use crate::update_cache::{self, CachedUpdate};
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

// Keep updater diagnostics outside the application bundle so they survive replacement.
fn update_log(app: &AppHandle, event: &str, details: Value) {
    static LOCK: Mutex<()> = Mutex::new(());
    let Ok(_guard) = LOCK.lock() else {
        return;
    };
    let result = (|| -> std::io::Result<()> {
        let directory = app.path().app_log_dir().map_err(std::io::Error::other)?;
        std::fs::create_dir_all(&directory)?;
        let path = directory.join("updater.jsonl");
        if std::fs::metadata(&path)
            .map(|m| m.len() > 2_000_000)
            .unwrap_or(false)
        {
            std::fs::rename(&path, directory.join("updater.previous.jsonl"))?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        writeln!(
            file,
            "{}",
            json!({"time": checked_at(), "pid": std::process::id(),
            "version": app.package_info().version.to_string(), "event": event, "details": details})
        )?;
        file.flush()
    })();
    if let Err(error) = result {
        eprintln!("FlowHub updater log: {error}");
    }
}

#[tauri::command]
pub(crate) fn log_update_event(app: AppHandle, event: String, details: Value) {
    update_log(&app, &format!("ui.{event}"), details);
}

pub(crate) struct UpdateRuntime {
    state: RwLock<Value>,
    available: Mutex<Option<Update>>,
    cached: Mutex<Option<CachedUpdate>>,
    operation: tokio::sync::Mutex<()>,
}

impl UpdateRuntime {
    pub(crate) fn new(current_version: &str) -> Self {
        let supported = !cfg!(debug_assertions);
        Self {
            state: RwLock::new(json!({
                "supported": supported,
                "currentVersion": current_version,
                "status": if supported { "idle" } else { "unsupported" },
                "availableVersion": "",
                "releaseDate": "",
                "releaseNotes": "",
                "percent": 0,
                "bytesPerSecond": 0,
                "transferred": 0,
                "total": 0,
                "checkedAt": "",
                "error": ""
            })),
            available: Mutex::new(None),
            cached: Mutex::new(None),
            operation: tokio::sync::Mutex::new(()),
        }
    }

    fn snapshot(&self) -> Value {
        self.state
            .read()
            .expect("FlowHub updater state lock poisoned")
            .clone()
    }

    fn replace(&self, app: &AppHandle, state: Value) -> Value {
        *self
            .state
            .write()
            .expect("FlowHub updater state lock poisoned") = state.clone();
        let _ = app.emit("flowhub:update-state", state.clone());
        state
    }

    fn patch(&self, app: &AppHandle, patch: Value) -> Value {
        let mut state = self.snapshot();
        if patch.get("status") != state.get("status")
            || patch.get("status").and_then(Value::as_str) == Some("error")
        {
            update_log(app, "state", patch.clone());
        }
        if let (Some(current), Some(fields)) = (state.as_object_mut(), patch.as_object()) {
            for (key, value) in fields {
                current.insert(key.clone(), value.clone());
            }
        }
        self.replace(app, state)
    }
}

fn checked_at() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn public_error(error: impl std::fmt::Display) -> String {
    let message = error.to_string();
    if message.trim().is_empty() {
        "更新操作失败".to_string()
    } else {
        message
    }
}

#[tauri::command]
pub(crate) fn get_update_state(runtime: State<'_, UpdateRuntime>) -> Value {
    runtime.snapshot()
}

#[tauri::command]
pub(crate) async fn check_for_updates(
    app: AppHandle,
    runtime: State<'_, UpdateRuntime>,
) -> Result<Value, String> {
    let _operation = runtime
        .operation
        .try_lock()
        .map_err(|_| "更新操作正在进行中".to_string())?;
    if runtime.cached.lock().unwrap().is_some() {
        return Ok(json!({"ok":true,"state":runtime.snapshot()}));
    }

    if !runtime
        .snapshot()
        .get("supported")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let state = runtime.snapshot();
        return Ok(json!({ "ok": false, "reason": "开发模式不检查应用更新", "state": state }));
    }
    runtime.patch(
        &app,
        json!({ "status": "checking", "error": "", "percent": 0 }),
    );
    let result = match app.updater().map_err(public_error)?.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let previous_version = runtime
                .snapshot()
                .get("availableVersion")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let state = runtime.patch(
                &app,
                json!({
                    "status": "available",
                    "availableVersion": version,
                    "releaseDate": update.date.map(|date| date.to_string()).unwrap_or_default(),
                    "releaseNotes": update.body.clone().unwrap_or_default(),
                    "checkedAt": checked_at(),
                    "error": "",
                    "percent": 0
                }),
            );
            let config =
                crate::storage::hydrated_config(&app.state::<crate::AppState>()).unwrap_or_default();
            let notifications_enabled = config
                .pointer("/core/notifications/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true)
                && config
                    .pointer("/core/notifications/updates")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
            if notifications_enabled && previous_version != version {
                let _ = app
                    .notification()
                    .builder()
                    .title("FlowHub 有新版本")
                    .body(format!("v{version} 已发布，可在设置中查看并更新。"))
                    .show();
            }
            *runtime
                .available
                .lock()
                .expect("FlowHub updater available lock poisoned") = Some(update);
            json!({ "ok": true, "state": state })
        }
        Ok(None) => {
            *runtime
                .available
                .lock()
                .expect("FlowHub updater available lock poisoned") = None;
            let state = runtime.patch(
                &app,
                json!({
                    "status": "not-available",
                    "availableVersion": "",
                    "checkedAt": checked_at(),
                    "error": "",
                    "percent": 0
                }),
            );
            json!({ "ok": true, "state": state })
        }
        Err(error) => {
            update_log(
                &app,
                "operation.error",
                json!({"error": format!("{error:?}")}),
            );
            let reason = public_error(error);
            let state = runtime.patch(&app, json!({ "status": "error", "error": reason }));
            json!({ "ok": false, "reason": reason, "state": state })
        }
    };
    Ok(result)
}

#[tauri::command]
pub(crate) async fn download_update(
    app: AppHandle,
    runtime: State<'_, UpdateRuntime>,
) -> Result<Value, String> {
    let _operation = runtime
        .operation
        .try_lock()
        .map_err(|_| "更新操作正在进行中".to_string())?;
    if runtime.cached.lock().unwrap().is_some() {
        return Ok(json!({"ok":true,"state":runtime.snapshot()}));
    }

    update_log(&app, "command", json!({"state": runtime.snapshot()}));
    let update = runtime
        .available
        .lock()
        .expect("FlowHub updater available lock poisoned")
        .clone();
    let Some(update) = update else {
        let state = runtime.snapshot();
        return Ok(json!({ "ok": false, "reason": "当前没有可下载的新版本", "state": state }));
    };
    runtime.patch(
        &app,
        json!({
            "status": "downloading",
            "error": "",
            "percent": 0,
            "bytesPerSecond": 0,
            "transferred": 0,
            "total": 0
        }),
    );
    let started = Instant::now();
    let mut transferred = 0_u64;
    let result = update
        .download(
            |chunk, total| {
                transferred += chunk as u64;
                let elapsed = started.elapsed().as_secs_f64().max(0.001);
                let percent = total
                    .filter(|total| *total > 0)
                    .map(|total| transferred as f64 / total as f64 * 100.0)
                    .unwrap_or(0.0);
                runtime.patch(
                    &app,
                    json!({
                        "status": "downloading",
                        "percent": percent.clamp(0.0, 100.0),
                        "bytesPerSecond": (transferred as f64 / elapsed) as u64,
                        "transferred": transferred,
                        "total": total.unwrap_or(0)
                    }),
                );
            },
            || {},
        )
        .await;
    match result {
        Ok(bytes) => {
            let metadata = CachedUpdate {
                version: update.version.clone(),
                target: update.target.clone(),
                arch: std::env::consts::ARCH.into(),
                url: update.download_url.to_string(),
                signature: update.signature.clone(),
                notes: update.body.clone().unwrap_or_default(),
                date: update.date.map(|d| d.to_string()).unwrap_or_default(),
                size: 0,
                sha256: String::new(),
            };
            let cached =
                match cache_dir(&app).and_then(|dir| update_cache::save(&dir, metadata, &bytes)) {
                    Ok(cached) => cached,
                    Err(error) => {
                        let state = runtime.patch(
                            &app,
                            json!({"status":"error", "error":format!("保存更新包失败：{error}")}),
                        );
                        return Ok(json!({"ok":false,"reason":state["error"],"state":state}));
                    }
                };
            update_log(
                &app,
                "cache.saved",
                json!({"version":cached.version,"bytes":cached.size}),
            );
            *runtime.cached.lock().unwrap() = Some(cached);
            let state = runtime.patch(
                &app,
                json!({ "status": "downloaded", "percent": 100, "error": "" }),
            );
            Ok(json!({ "ok": true, "state": state }))
        }
        Err(error) => {
            update_log(
                &app,
                "operation.error",
                json!({"error": format!("{error:?}")}),
            );
            let reason = public_error(error);
            let state = runtime.patch(&app, json!({ "status": "error", "error": reason }));
            Ok(json!({ "ok": false, "reason": reason, "state": state }))
        }
    }
}

#[tauri::command]
pub(crate) async fn quit_and_install_update(
    app: AppHandle,
    runtime: State<'_, UpdateRuntime>,
) -> Result<Value, String> {
    let _operation = runtime
        .operation
        .try_lock()
        .map_err(|_| "更新操作正在进行中".to_string())?;
    let cached = runtime.cached.lock().unwrap().clone();
    let Some(cached) = cached else {
        return Ok(json!({"ok":false,"reason":"更新尚未下载完成","state":runtime.snapshot()}));
    };
    runtime.patch(&app, json!({"status":"installing", "error":""}));
    // Tauri's Update handle is process-local. Recreate it from the small release
    // manifest after restart; the multi-megabyte package stays on disk.
    let available = runtime.available.lock().unwrap().clone();
    let result: Result<(), String> = async {
        let update = if let Some(update) = available.filter(|u| cached.matches(u)) {
            update
        } else {
            update_log(
                &app,
                "cache.resolve-release",
                json!({"version":cached.version}),
            );
            app.updater()
                .map_err(public_error)?
                .check()
                .await
                .map_err(public_error)?
                .ok_or_else(|| "当前没有可安装的新版，请重新检查更新".to_string())?
        };
        *runtime.available.lock().unwrap() = Some(update.clone());
        if !cached.matches(&update) {
            update_cache::clear(&cache_dir(&app)?)?;
            *runtime.cached.lock().unwrap() = None;
            runtime.patch(&app, json!({"availableVersion":update.version}));
            return Err("发布版本已变化，请下载新版更新包".into());
        }
        let bytes = match update_cache::bytes(&cache_dir(&app)?, &cached).and_then(|bytes| {
            update_cache::verify(&bytes, &update.signature, &public_key(&app)?)?;
            Ok(bytes)
        }) {
            Ok(bytes) => bytes,
            Err(error) => {
                update_cache::clear(&cache_dir(&app)?)?;
                *runtime.cached.lock().unwrap() = None;
                return Err(format!("本地更新包校验失败，请重新下载：{error}"));
            }
        };
        update_log(
            &app,
            "install.start",
            json!({"version":cached.version,"bytes":bytes.len(),"source":"disk"}),
        );
        // Installation may request the main thread for macOS authorization.
        tauri::async_runtime::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(public_error)?
            .map_err(public_error)?;
        Ok(())
    }
    .await;
    if let Err(error) = result {
        let retained = runtime.cached.lock().unwrap().is_some();
        update_log(
            &app,
            "install.error",
            json!({"error":error,"cacheRetained":retained}),
        );
        let state = runtime.patch(
            &app,
            json!({"status":if retained {"downloaded"} else {"available"},"error":error,"percent":if retained {100} else {0}}),
        );
        return Ok(json!({"ok":false,"reason":error,"state":state}));
    }
    // Keep disk cache until the new version actually starts successfully.
    update_log(&app, "install.success", json!({}));
    let state = runtime.snapshot();
    let restart_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        update_log(&restart_app, "restart.request", json!({}));
        restart_app.restart();
    });
    Ok(json!({"ok":true,"state":state}))
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join("updates"))
        .map_err(public_error)
}

fn public_key(app: &AppHandle) -> Result<String, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "缺少更新公钥".into())
}

fn restore_cache(app: &AppHandle) -> Result<bool, String> {
    let dir = cache_dir(app)?;
    let Some(cached) = update_cache::read(&dir)? else {
        return Ok(false);
    };
    if cached.arch != std::env::consts::ARCH {
        return Err("缓存更新包的架构与当前应用不一致".into());
    }
    let version = semver::Version::parse(&cached.version).map_err(public_error)?;
    if version <= app.package_info().version {
        update_cache::clear(&dir)?;
        update_log(
            app,
            "cache.obsolete-removed",
            json!({"version":cached.version}),
        );
        return Ok(false);
    }
    let bytes = update_cache::bytes(&dir, &cached)?;
    update_cache::verify(&bytes, &cached.signature, &public_key(app)?)?;
    let runtime = app.state::<UpdateRuntime>();
    *runtime.cached.lock().unwrap() = Some(cached.clone());
    runtime.patch(
        app,
        json!({"status":"downloaded","availableVersion":cached.version,
        "releaseDate":cached.date,"releaseNotes":cached.notes,"percent":100,
        "transferred":cached.size,"total":cached.size,"error":""}),
    );
    update_log(
        app,
        "cache.restored",
        json!({"version":cached.version,"bytes":cached.size}),
    );
    Ok(true)
}

pub(crate) fn schedule_initial_check(app: &AppHandle) {
    update_log(
        app,
        "startup",
        json!({"executable": std::env::current_exe().ok()}),
    );
    if cfg!(debug_assertions) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let runtime = handle.state::<UpdateRuntime>();
        let operation = runtime.operation.lock().await;
        let restored = restore_cache(&handle);
        let restored = match restored {
            Ok(value) => value,
            Err(error) => {
                update_log(&handle, "cache.invalid", json!({"error":error}));
                if let Ok(dir) = cache_dir(&handle) {
                    let _ = update_cache::clear(&dir);
                }
                false
            }
        };
        drop(operation);
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        let config_path = handle.state::<crate::AppState>().paths().config_path;
        let config = std::fs::read_to_string(config_path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .unwrap_or_default();
        if config
            .pointer("/core/autoUpdateCheck")
            .and_then(Value::as_bool)
            == Some(false)
        {
            return;
        }
        let auto_install = config
            .pointer("/core/autoUpdateInstall")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if restored {
            if auto_install {
                let _ =
                    quit_and_install_update(handle.clone(), handle.state::<UpdateRuntime>()).await;
            }
            return;
        }
        let result = check_for_updates(handle.clone(), handle.state::<UpdateRuntime>())
            .await
            .ok();
        if auto_install
            && result
                .as_ref()
                .and_then(|value| value.get("ok"))
                .and_then(Value::as_bool)
                == Some(true)
        {
            let _ = download_update(handle.clone(), handle.state::<UpdateRuntime>()).await;
            let _ = quit_and_install_update(handle.clone(), handle.state::<UpdateRuntime>()).await;
        }
    });
}

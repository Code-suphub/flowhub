use serde_json::{json, Value};
use std::sync::{Mutex, RwLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

pub(crate) struct UpdateRuntime {
    state: RwLock<Value>,
    available: Mutex<Option<Update>>,
    downloaded: Mutex<Option<Vec<u8>>>,
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
            downloaded: Mutex::new(None),
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
                crate::hydrated_config(&app.state::<crate::AppState>()).unwrap_or_default();
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
            *runtime
                .downloaded
                .lock()
                .expect("FlowHub updater download lock poisoned") = None;
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
            *runtime
                .downloaded
                .lock()
                .expect("FlowHub updater download lock poisoned") = Some(bytes);
            let state = runtime.patch(
                &app,
                json!({ "status": "downloaded", "percent": 100, "error": "" }),
            );
            Ok(json!({ "ok": true, "state": state }))
        }
        Err(error) => {
            let reason = public_error(error);
            let state = runtime.patch(&app, json!({ "status": "error", "error": reason }));
            Ok(json!({ "ok": false, "reason": reason, "state": state }))
        }
    }
}

#[tauri::command]
pub(crate) fn quit_and_install_update(
    app: AppHandle,
    runtime: State<'_, UpdateRuntime>,
) -> Result<Value, String> {
    let update = runtime
        .available
        .lock()
        .expect("FlowHub updater available lock poisoned")
        .clone();
    let bytes = runtime
        .downloaded
        .lock()
        .expect("FlowHub updater download lock poisoned")
        .take();
    let (Some(update), Some(bytes)) = (update, bytes) else {
        let state = runtime.snapshot();
        return Ok(json!({ "ok": false, "reason": "更新尚未下载完成", "state": state }));
    };
    let state = runtime.patch(&app, json!({ "status": "installing", "error": "" }));
    if let Err(error) = update.install(bytes) {
        let reason = public_error(error);
        let state = runtime.patch(&app, json!({ "status": "error", "error": reason }));
        return Ok(json!({ "ok": false, "reason": reason, "state": state }));
    }
    let response = json!({ "ok": true, "state": state });
    let restart_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        restart_app.restart();
    });
    Ok(response)
}

pub(crate) fn schedule_initial_check(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
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
            let _ = quit_and_install_update(handle.clone(), handle.state::<UpdateRuntime>());
        }
    });
}

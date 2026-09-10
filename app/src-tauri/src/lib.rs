mod menu_bar;
mod storage;
use menu_bar::{apply_menu_bar, apply_menu_bar_organizer, config_flag};
use storage::{
    configured_path, ensure_object_path, hydrated_config, initialize_state, read_json,
    write_json_atomic,
};
mod config_save;
#[cfg(test)]
mod storage_tests;
mod web_open;
mod search_diagnostic_run;
mod focus_diagnostics;
#[cfg(target_os = "macos")]
mod app_launch;
#[cfg(target_os = "macos")]
mod macos_launcher_position;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering},
        Arc, Mutex, RwLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
#[cfg(target_os = "macos")]
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt as PanelManagerExt, PanelLevel, StyleMask,
    WebviewWindowExt,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

mod clipboard;
mod clipboard_privacy;
mod cloudflare_probe;
#[cfg(all(test, feature = "custom-protocol"))]
mod desktop_security;
mod diagnostics;
mod port_inspector;
mod network_diagnostics;
mod plugin_runtime;
mod plugin_status;
mod plugin_canvas;
#[cfg(target_os = "macos")]
mod macos_accessibility;
#[cfg(target_os = "macos")]
mod macos_hotkey;
#[cfg(target_os = "macos")]
mod macos_item_submenu;
#[cfg(any(target_os = "macos", test))]
mod menu_bar_section_memory;
#[cfg(target_os = "macos")]
mod menu_bar_icon;
mod update_cache;
mod updater;

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(FlowHubLauncherPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            is_floating_panel: true
        }
    })
}

const DEFAULT_CONFIG: &str = include_str!("../../../config.json");
static LAST_MAIN_SHOW_MILLIS: AtomicU64 = AtomicU64::new(0);
#[tauri::command]
fn send_test_notification(app: tauri::AppHandle) -> Result<Value, String> {
    let config = hydrated_config(&app.state::<AppState>())?;
    if !config_flag(&config, "/core/notifications/enabled", true) {
        return Ok(json!({ "ok": false, "reason": "请先开启 FlowHub 应用通知" }));
    }
    app.notification()
        .builder()
        .title("FlowHub 通知已开启")
        .body("之后可在这里接收更新提醒。")
        .show()
        .map_err(|error| error.to_string())?;
    Ok(json!({ "ok": true }))
}

#[derive(Clone)]
struct AppPaths {
    config_path: PathBuf,
    storage_dir: PathBuf,
    db_path: PathBuf,
}

#[cfg(target_os = "macos")]
fn mihomo_api(path: &str) -> Option<Value> {
    use std::os::unix::net::UnixStream;
    let entries = fs::read_dir("/tmp").ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("mihomo-party-") || !name.ends_with(".sock") {
            continue;
        }
        let Ok(mut stream) = UnixStream::connect(entry.path()) else {
            continue;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let request = format!("GET {path} HTTP/1.1\r\nHost: mihomo\r\nConnection: close\r\n\r\n");
        if stream.write_all(request.as_bytes()).is_err() {
            continue;
        }
        let mut bytes = Vec::new();
        if stream.read_to_end(&mut bytes).is_err() {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let Some(body) = text.split("\r\n\r\n").nth(1) else {
            continue;
        };
        if let Ok(value) = serde_json::from_str(body) {
            return Some(value);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn clash_rest_api(path: &str) -> Option<Value> {
    use std::net::TcpStream;
    for port in [9090_u16, 9097, 7897] {
        let Ok(mut stream) =
            TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(700))
        else {
            continue;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
        let request =
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        if stream.write_all(request.as_bytes()).is_err() {
            continue;
        }
        let mut bytes = Vec::new();
        if stream.read_to_end(&mut bytes).is_err() {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let Some(body) = text.split("\r\n\r\n").nth(1) else {
            continue;
        };
        if let Ok(value) = serde_json::from_str(body) {
            return Some(value);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn node_from_connections(payload: &Value) -> Option<Value> {
    let connections = payload.get("connections")?.as_array()?;
    let latest = connections
        .iter()
        .filter(|connection| {
            connection
                .pointer("/metadata/remoteDestination")
                .and_then(Value::as_str)
                .map(|value| !value.is_empty())
                .unwrap_or(false)
        })
        .max_by_key(|connection| {
            connection
                .get("start")
                .and_then(Value::as_str)
                .unwrap_or("")
        })?;
    let metadata = latest.get("metadata")?;
    Some(json!({
        "nodeName": latest.get("chains").and_then(Value::as_array).and_then(|chains| chains.first()).and_then(Value::as_str).unwrap_or(""),
        "remoteAddress": metadata.get("remoteDestination").and_then(Value::as_str).unwrap_or(""),
        "chains": latest.get("chains").cloned().unwrap_or_else(|| json!([])),
        "observedAt": latest.get("start").and_then(Value::as_str).unwrap_or("")
    }))
}

#[cfg(target_os = "macos")]
fn current_proxy_node(adapter: &str) -> Option<Value> {
    match adapter {
        "system" => None,
        "mihomo" => node_from_connections(&mihomo_api("/connections")?),
        "clash-rest" => node_from_connections(&clash_rest_api("/connections")?),
        _ => mihomo_api("/connections")
            .and_then(|payload| node_from_connections(&payload))
            .or_else(|| {
                clash_rest_api("/connections").and_then(|payload| node_from_connections(&payload))
            }),
    }
}

pub(crate) struct AppState {
    storage_access: RwLock<()>,
    config_save: Mutex<()>,
    root_dir: PathBuf,
    default_config_path: PathBuf,
    default_storage_dir: PathBuf,
    paths: RwLock<AppPaths>,
    application_index: RwLock<Vec<Value>>,
    application_index_path: PathBuf,
    application_index_needs_refresh: AtomicBool,
    application_index_refreshing: AtomicBool,
    application_icon_cache: Mutex<HashMap<String, String>>,
    application_icon_cache_dir: PathBuf,
}

impl AppState {
    fn paths(&self) -> AppPaths {
        self.paths
            .read()
            .expect("FlowHub paths lock poisoned")
            .clone()
    }

    pub(crate) fn storage_dir(&self) -> PathBuf {
        self.paths().storage_dir
    }
}

fn apply_autostart(app: &tauri::AppHandle, config: &Value) -> Value {
    let requested = config
        .pointer("/core/launchAtLogin")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if cfg!(debug_assertions) {
        return json!({ "launchAtLogin": requested, "applied": false, "reason": "开发模式不修改登录项" });
    }
    let result = if requested {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    match result {
        Ok(()) => json!({ "launchAtLogin": requested, "applied": true }),
        Err(error) => {
            json!({ "launchAtLogin": requested, "applied": false, "reason": error.to_string() })
        }
    }
}

#[tauri::command]
async fn get_config(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || hydrated_config(&app.state::<AppState>()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn save_config(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mut config: Value,
) -> Result<Value, String> {
    let _save = state
        .config_save
        .lock()
        .map_err(|error| error.to_string())?;
    if !config.is_object() {
        return Ok(json!({ "ok": false, "reason": "配置必须是 JSON 对象" }));
    }
    let items = config
        .pointer("/plugins/web/settings/items")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "网页插件配置缺少 items 数组".to_string())?;
    let target_storage = configured_path(
        &config,
        &["plugins", "clipboard", "settings", "storagePath"],
    )
    .unwrap_or_else(|| state.default_storage_dir.clone());
    if !target_storage.is_absolute() {
        return Ok(json!({ "ok": false, "reason": "剪贴板存放位置必须是绝对路径" }));
    }
    let target_config = configured_path(&config, &["core", "configPath"])
        .unwrap_or_else(|| state.default_config_path.clone());
    if !target_config.is_absolute() {
        return Ok(json!({ "ok": false, "reason": "配置文件位置必须是绝对路径" }));
    }
    let previous_config = hydrated_config(&state)?;
    let storage_changed = config_save::resolved_path(&target_storage)?
        != config_save::resolved_path(&state.paths().storage_dir)?;
    if storage_changed {
        if let Err(reason) = clipboard::stop_monitor(&app) {
            if let Err(resume_error) = clipboard::apply_config(&app, &previous_config) {
                return Err(format!("{reason}; 恢复剪贴板监控失败：{resume_error}"));
            }
            return Err(reason);
        }
    }
    let persisted =
        config_save::persist(&state, &mut config, &items, &target_storage, &target_config);
    let (storage_state, count, saved_items) = match persisted {
        Ok(state) => state,
        Err(reason) => {
            if storage_changed {
                if let Err(resume_error) = clipboard::apply_config(&app, &previous_config) {
                    return Ok(
                        json!({ "ok": false, "reason": format!("{reason}; 恢复剪贴板监控失败：{resume_error}") }),
                    );
                }
            }
            return Ok(json!({ "ok": false, "reason": reason }));
        }
    };

    let mut hydrated = config.clone();
    ensure_object_path(&mut hydrated, &["plugins", "web", "settings"])
        .expect("validated persisted settings")
        .insert("items".to_string(), Value::Array(saved_items));
    let integrations =
        config_save::IntegrationPlan::between(&previous_config, &hydrated, storage_changed);
    Ok(config_save::saved_response(
        &hydrated,
        storage_state,
        count,
        &integrations,
        |name| match name {
            "clipboard" => {
                clipboard::apply_config(&app, &config).map(|_| json!({ "applied": true }))
            }
            "hotkey" => Ok(register_hotkey(
                &app,
                hydrated
                    .pointer("/core/hotkey")
                    .and_then(Value::as_str)
                    .unwrap_or("Alt+Space"),
            )),
            "autostart" => Ok(apply_autostart(&app, &hydrated)),
            "menuBar" => apply_menu_bar(&app, &hydrated),
            "organizer" => Ok(apply_menu_bar_organizer(&app, &hydrated)),
            "broadcast" => app
                .emit("flowhub:config", json!({ "config": hydrated, "query": "" }))
                .map(|_| json!({ "applied": true }))
                .map_err(|error| error.to_string()),
            _ => unreachable!("unknown settings integration"),
        },
    ))
}

fn application_directories() -> Vec<PathBuf> {
    let mut directories = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
        PathBuf::from("/System/Library/CoreServices"),
    ];
    if let Some(home) = dirs::home_dir() {
        directories.push(home.join("Applications"));
    }
    directories
}

fn scan_applications() -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut applications = Vec::new();
    for directory in application_directories() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !path.is_dir()
                || !file_name.to_lowercase().ends_with(".app")
                || !seen.insert(path.clone())
            {
                continue;
            }
            applications.push(json!({
                "kind": "app",
                "title": file_name.trim_end_matches(".app"),
                "fileName": file_name,
                "path": path.to_string_lossy(),
                "bundleId": "",
                "iconUrl": ""
            }));
        }
    }
    if cfg!(target_os = "macos") && !applications.is_empty() {
        const SCRIPT: &str = "ObjC.import('Foundation'); var args=$.NSProcessInfo.processInfo.arguments; var result=[]; for(var i=6;i<args.count;i++){try{var p=ObjC.unwrap(args.objectAtIndex(i));var bundle=$.NSBundle.bundleWithPath(p);var info=bundle?(bundle.localizedInfoDictionary||bundle.infoDictionary):null;var display=info&&typeof info.objectForKey==='function'?(info.objectForKey('CFBundleDisplayName')||info.objectForKey('CFBundleName')):null;var identifier=bundle?bundle.bundleIdentifier:null;result.push({displayName:display?ObjC.unwrap(display):'',bundleId:identifier?ObjC.unwrap(identifier):''});}catch(e){result.push({displayName:'',bundleId:''});}} console.log(JSON.stringify(result));";
        let paths: Vec<String> = applications
            .iter()
            .filter_map(|application| {
                application
                    .get("path")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        let mut command = Command::new("osascript");
        command.args(["-l", "JavaScript", "-e", SCRIPT, "--"]);
        command.args(&paths);
        if let Ok(output) = command.output() {
            let text = if output.stdout.is_empty() {
                output.stderr
            } else {
                output.stdout
            };
            let metadata: Vec<Value> = serde_json::from_slice(&text).unwrap_or_default();
            for (index, application) in applications.iter_mut().enumerate() {
                if let Some(object) = application.as_object_mut() {
                    let display = metadata
                        .get(index)
                        .and_then(|entry| entry.get("displayName"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let bundle_id = metadata
                        .get(index)
                        .and_then(|entry| entry.get("bundleId"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if !display.is_empty() {
                        object.insert("title".to_string(), Value::String(display.to_string()));
                    }
                    object.insert("bundleId".to_string(), Value::String(bundle_id.to_string()));
                }
            }
        }
    }
    for application in &mut applications {
        let title = application
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("");
        let file_name = application
            .get("fileName")
            .and_then(Value::as_str)
            .unwrap_or("");
        let path = application
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("");
        let bundle_id = application
            .get("bundleId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let hay = format!("{title} {file_name} {bundle_id} {path}").to_lowercase();
        application
            .as_object_mut()
            .unwrap()
            .insert("hay".to_string(), Value::String(hay));
    }
    applications.sort_by(|left, right| {
        left.get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase()
            .cmp(
                &right
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_lowercase(),
            )
    });
    applications
}

fn application_fingerprint() -> String {
    let mut entries = Vec::new();
    for directory in application_directories() {
        let Ok(read_dir) = fs::read_dir(directory) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !path.is_dir() || !file_name.to_lowercase().ends_with(".app") {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_secs().to_string())
                .unwrap_or_default();
            entries.push(format!("{}:{}", path.to_string_lossy(), modified));
        }
    }
    entries.sort_unstable();
    entries.join("\n")
}

fn load_application_cache(path: &Path) -> (Vec<Value>, String) {
    let Some(value) = read_json(path) else {
        return (Vec::new(), String::new());
    };
    let fingerprint = value
        .get("fingerprint")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let applications = value
        .get("applications")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    (applications, fingerprint)
}

fn persist_application_cache(path: &Path, applications: &[Value], fingerprint: &str) {
    let value = json!({
        "version": 1,
        "fingerprint": fingerprint,
        "applications": applications
    });
    if let Err(error) = write_json_atomic(path, &value) {
        eprintln!("[flowhub-tauri] 保存应用索引失败：{error}");
    }
}

fn refresh_application_index(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state
        .application_index_refreshing
        .swap(true, AtomicOrdering::AcqRel)
    {
        return;
    }
    let applications = scan_applications();
    let fingerprint = application_fingerprint();
    {
        let mut index = state
            .application_index
            .write()
            .expect("application index lock poisoned");
        *index = applications.clone();
    }
    persist_application_cache(&state.application_index_path, &applications, &fingerprint);
    state
        .application_index_needs_refresh
        .store(false, AtomicOrdering::Release);
    state
        .application_index_refreshing
        .store(false, AtomicOrdering::Release);
}

#[tauri::command]
async fn search_applications(
    state: State<'_, AppState>,
    query: String,
    limit: usize,
    offset: usize,
    include_icons: bool,
) -> Result<Vec<Value>, String> {
    let keyword = query.trim().to_lowercase();
    let mut applications = state
        .application_index
        .read()
        .expect("application index lock poisoned")
        .clone();
    if applications.is_empty() {
        applications = scan_applications();
        let fingerprint = application_fingerprint();
        *state
            .application_index
            .write()
            .expect("application index lock poisoned") = applications.clone();
        persist_application_cache(&state.application_index_path, &applications, &fingerprint);
        state
            .application_index_needs_refresh
            .store(false, AtomicOrdering::Release);
    }
    let mut selected: Vec<Value> = applications
        .iter()
        .filter(|application| {
            keyword.is_empty()
                || application
                    .get("hay")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .contains(&keyword)
        })
        .skip(offset)
        .take(limit.clamp(1, 100))
        .cloned()
        .collect();
    if include_icons {
        let paths: Vec<String> = selected
            .iter()
            .filter_map(|application| {
                application
                    .get("path")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        let icons = application_icon_data_urls(&state, &paths);
        for application in &mut selected {
            let path = application
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("");
            if let Some(icon) = icons.get(path) {
                application
                    .as_object_mut()
                    .unwrap()
                    .insert("iconUrl".to_string(), Value::String(icon.clone()));
            }
        }
    }
    Ok(selected)
}

#[tauri::command]
async fn load_application_icons(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> HashMap<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        application_icon_data_urls(&state, &paths)
    })
    .await
    .unwrap_or_default()
}

/// Resolve native application icons once per path for both app search and usage cards.
/// Icon extraction invokes `osascript`, so keeping this cache in process avoids a
/// visible delay every time the launcher is shown or the query becomes empty.
pub(crate) fn application_icon_data_urls(
    state: &AppState,
    paths: &[String],
) -> HashMap<String, String> {
    let unique_paths: Vec<String> = paths
        .iter()
        .filter(|path| !path.trim().is_empty())
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if unique_paths.is_empty() {
        return HashMap::new();
    }

    let mut result = HashMap::new();
    {
        let cache = state
            .application_icon_cache
            .lock()
            .expect("application icon cache lock poisoned");
        for path in &unique_paths {
            if let Some(icon) = cache.get(path).filter(|icon| !icon.is_empty()) {
                result.insert(path.clone(), icon.clone());
            }
        }
    }

    let mut disk_loaded = HashMap::new();
    for path in unique_paths
        .iter()
        .filter(|path| !result.contains_key(*path))
    {
        let cache_path = application_icon_cache_path(state, path);
        if let Ok(bytes) = fs::read(cache_path) {
            if !bytes.is_empty() {
                disk_loaded.insert(
                    path.clone(),
                    format!("data:image/png;base64,{}", BASE64.encode(bytes)),
                );
            }
        }
    }
    if !disk_loaded.is_empty() {
        state
            .application_icon_cache
            .lock()
            .expect("application icon cache lock poisoned")
            .extend(disk_loaded.clone());
        result.extend(disk_loaded);
    }

    let missing: Vec<String> = unique_paths
        .iter()
        .filter(|path| !result.contains_key(*path))
        .cloned()
        .collect();
    if !missing.is_empty() {
        let resolved = clipboard::native_icon_data_urls(&missing);
        let mut cache_updates = HashMap::new();
        for path in missing {
            let icon = resolved.get(&path).cloned().unwrap_or_default();
            if let Some(encoded) = icon.strip_prefix("data:image/png;base64,") {
                if let Ok(bytes) = BASE64.decode(encoded) {
                    let _ = fs::write(application_icon_cache_path(state, &path), bytes);
                }
            }
            if !icon.is_empty() {
                result.insert(path.clone(), icon.clone());
            }
            cache_updates.insert(path, icon);
        }
        state
            .application_icon_cache
            .lock()
            .expect("application icon cache lock poisoned")
            .extend(cache_updates);
    }

    result
}

fn application_icon_cache_path(state: &AppState, application_path: &str) -> PathBuf {
    let modified = fs::metadata(application_path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs())
        .unwrap_or_default();
    let key = format!("{application_path}\0{modified}");
    let digest = format!("{:x}", Sha256::digest(key.as_bytes()));
    state
        .application_icon_cache_dir
        .join(format!("{digest}.png"))
}

pub(crate) fn hide_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

static LAUNCHER_PINNED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn get_launcher_pinned() -> bool {
    LAUNCHER_PINNED.load(AtomicOrdering::Acquire)
}

#[tauri::command]
fn set_launcher_pinned(pinned: bool) -> bool {
    LAUNCHER_PINNED.store(pinned, AtomicOrdering::Release);
    pinned
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<Value, String> {
    hide_main(&app);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
async fn get_proxy_info(adapter: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || get_proxy_info_blocking(adapter))
        .await
        .map_err(|error| error.to_string())?
}

fn get_proxy_info_blocking(adapter: Option<String>) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("scutil")
            .arg("--proxy")
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err("无法读取 macOS 系统代理".to_string());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let values: HashMap<String, String> = text
            .lines()
            .filter_map(|line| line.split_once(':'))
            .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
            .collect();
        let proxy = |name: &str| {
            json!({
                "enabled": values.get(&format!("{name}Enable")).map(|value| value == "1").unwrap_or(false),
                "host": values.get(&format!("{name}Proxy")).cloned().unwrap_or_default(),
                "port": values.get(&format!("{name}Port")).cloned().unwrap_or_default()
            })
        };
        let mut result =
            json!({ "http": proxy("HTTP"), "https": proxy("HTTPS"), "socks": proxy("SOCKS") });
        if let Some(object) = result.as_object_mut() {
            object.insert(
                "node".to_string(),
                current_proxy_node(adapter.as_deref().unwrap_or("auto")).unwrap_or(Value::Null),
            );
        }
        return Ok(result);
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(
            json!({ "http": { "enabled": false, "host": "", "port": "" }, "https": { "enabled": false, "host": "", "port": "" }, "socks": { "enabled": false, "host": "", "port": "" } }),
        )
    }
}

#[tauri::command]
async fn activate_target(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    payload: Value,
) -> Result<Value, String> {
    let mut response = json!({ "ok": true });
    match plugin_id.as_str() {
        "web" => {
            let url = payload.get("url").and_then(Value::as_str).unwrap_or("");
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Ok(json!({ "ok": false, "reason": "非 http(s) 链接" }));
            }
            let target = url.to_string();
            let handle = app.clone();
            response = tauri::async_runtime::spawn_blocking(move || web_open::open(&handle, &target))
                .await.map_err(|e| e.to_string())??;
            if let Some(usage) = payload.get("usage") {
                storage::record_usage(&state, usage, url)?;
            }
        }
        "app" => {
            let path = payload.get("path").and_then(Value::as_str).unwrap_or("");
            if path.is_empty() {
                return Ok(json!({ "ok": false, "reason": "应用路径为空" }));
            }
            #[cfg(target_os = "macos")]
            {
                let target = path.to_string();
                tauri::async_runtime::spawn_blocking(move || app_launch::launch(&target))
                    .await.map_err(|error|error.to_string())??;
            }
            #[cfg(not(target_os = "macos"))]
            app.opener()
                .open_path(path, None::<&str>)
                .map_err(|error| error.to_string())?;
            if let Some(usage) = payload.get("usage") {
                storage::record_usage(&state, usage, path)?;
            }
        }
        "memo" => {
            let content = payload.get("content").and_then(Value::as_str).unwrap_or("");
            return clipboard::paste_text(&app, content);
        }
        _ => {
            return Ok(json!({ "ok": false, "reason": format!("当前版本不支持插件：{plugin_id}") }))
        }
    }
    let _ = app.emit("flowhub:usage-updated", ());
    hide_main(&app);
    Ok(response)
}

#[tauri::command]
async fn search_usage(app: tauri::AppHandle, scope: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        storage::search_usage(&state, &scope, |paths| application_icon_data_urls(&state, paths))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn close_settings(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_settings(app: tauri::AppHandle, initial_url: Option<String>) -> Result<Value, String> {
    open_settings_window(app, initial_url, false)
}

pub(crate) fn open_settings_window(app: tauri::AppHandle, initial_url: Option<String>, update: bool) -> Result<Value, String> {
    let initial_url = initial_url.and_then(|value| {
        let value = value.trim().to_string();
        match url::Url::parse(&value) {
            Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => Some(value),
            _ => None,
        }
    });
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        if update {
            window.eval("(() => { let attempts = 0; const run = () => { if (window.runMenuUpdate) { window.runMenuUpdate(); } else if (++attempts < 200) { setTimeout(run, 100); } }; run(); })();")
                .map_err(|error| error.to_string())?;
        }
        if let Some(url) = initial_url {
            let argument = serde_json::to_string(&url).map_err(|error| error.to_string())?;
            window
                .eval(&format!(
                    "(function(){{const value={argument}; const apply=()=>{{if(window.prepareAddWebUrl){{window.prepareAddWebUrl(value);}}else{{setTimeout(apply,100);}}}}; apply();}})();"
                ))
                .map_err(|error| error.to_string())?;
        }
        return Ok(json!({ "ok": true }));
    }
    let settings_path = initial_url
        .as_ref()
        .map(|url| {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("addUrl", url);
            format!("settings.html?{}", query.finish())
        })
        .unwrap_or_else(|| if update { "settings.html?update=1".to_string() } else { "settings.html".to_string() });
    WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(settings_path.into()))
        .title("FlowHub 设置")
        .inner_size(980.0, 720.0)
        .min_inner_size(820.0, 600.0)
        .center()
        .build()
        .map_err(|error| error.to_string())?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
fn open_accessibility_settings(app: tauri::AppHandle) -> Result<Value, String> {
    app.opener()
        .open_url(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            None::<&str>,
        )
        .map_err(|error| error.to_string())?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
fn get_config_path_info(state: State<'_, AppState>) -> Value {
    let paths = state.paths();
    let configured = hydrated_config(&state)
        .ok()
        .and_then(|config| configured_path(&config, &["core", "configPath"]))
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    json!({
        "available": true,
        "configuredPath": configured,
        "defaultPath": state.default_config_path.to_string_lossy(),
        "resolvedPath": paths.config_path.to_string_lossy(),
        "activePath": paths.config_path.to_string_lossy()
    })
}

#[tauri::command]
fn get_storage_info(state: State<'_, AppState>) -> Value {
    let paths = state.paths();
    let configured = hydrated_config(&state)
        .ok()
        .and_then(|config| {
            configured_path(
                &config,
                &["plugins", "clipboard", "settings", "storagePath"],
            )
        })
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    json!({
        "available": true,
        "configuredPath": configured,
        "defaultPath": state.default_storage_dir.to_string_lossy(),
        "resolvedPath": paths.storage_dir.to_string_lossy(),
        "activePath": paths.storage_dir.to_string_lossy()
    })
}

#[tauri::command]
async fn choose_config_path(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let current = state.paths().config_path;
    let directory = current.parent().unwrap_or(&state.root_dir);
    let file_name = current
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config.json");
    let selected = app
        .dialog()
        .file()
        .set_title("选择 FlowHub 配置文件位置")
        .set_directory(directory)
        .set_file_name(file_name)
        .add_filter("JSON 配置", &["json"])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let mut path = selected.into_path().map_err(|error| error.to_string())?;
    if path.extension().is_none() {
        path.set_extension("json");
    }
    Ok(json!({ "ok": true, "path": path.to_string_lossy() }))
}

#[tauri::command]
async fn choose_storage_path(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("选择 FlowHub 数据存放目录")
        .set_directory(state.paths().storage_dir)
        .blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let path = selected.into_path().map_err(|error| error.to_string())?;
    Ok(json!({ "ok": true, "path": path.to_string_lossy() }))
}

#[tauri::command]
fn open_config_path(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let path = state.paths().config_path;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| error.to_string())?;
    Ok(json!({ "ok": true, "path": path.to_string_lossy() }))
}

#[tauri::command]
fn open_storage_path(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let path = state.paths().storage_dir;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())?;
    Ok(json!({ "ok": true, "path": path.to_string_lossy() }))
}

fn toggle_main(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[flowhub-tauri] 唤出失败：主窗口不存在");
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    eprintln!("[flowhub-tauri] 收到唤出请求，当前可见：{visible}，当前聚焦：{focused}");
    if visible && focused {
        let _ = window.hide();
        return;
    }
    // macOS uses a non-activating fullscreen-compatible panel. Select the
    // pointer's NSScreen and position it on the main thread immediately before
    // showing; NSWindow::center does not explicitly choose the pointer screen.
    #[cfg(not(target_os = "macos"))]
    let _ = window.set_visible_on_all_workspaces(true);
    #[cfg(not(target_os = "macos"))]
    let _ = window.set_always_on_top(true);
    #[cfg(not(target_os = "macos"))]
    let _ = window.center();
    LAST_MAIN_SHOW_MILLIS.store(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
        AtomicOrdering::Release,
    );
    #[cfg(target_os = "macos")]
    show_macos_window(&window);
    #[cfg(not(target_os = "macos"))]
    {
        if let Err(error) = window.show() {
            eprintln!("[flowhub-tauri] 显示主窗口失败：{error}");
        }
        if let Err(error) = window.set_focus() {
            eprintln!("[flowhub-tauri] 聚焦主窗口失败：{error}");
        }
    }
    // Showing and focusing are dispatched to the windowing system. A second
    // focus request is only needed for regular windows; the macOS NSPanel is
    // non-activating and makes itself key without switching Spaces.
    #[cfg(not(target_os = "macos"))]
    let focus_window = window.clone();
    #[cfg(not(target_os = "macos"))]
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(40));
        if focus_window.is_visible().unwrap_or(false) && !focus_window.is_focused().unwrap_or(false)
        {
            let _ = focus_window.set_focus();
        }
        eprintln!(
            "[flowhub-tauri] 唤出完成，可见：{}，聚焦：{}，位置：{:?}",
            focus_window.is_visible().unwrap_or(false),
            focus_window.is_focused().unwrap_or(false),
            focus_window.outer_position().ok()
        );
    });
    // Reset the query and refresh data after the first frame so showing the
    // launcher is not blocked by four concurrent searches on every hotkey.
    let _ = window.eval("window.prepareForShow?.()");
}

#[cfg(target_os = "macos")]
fn show_macos_window(window: &tauri::WebviewWindow) {
    let handle = window.app_handle().clone();
    let panel_handle = handle.clone();
    let queued_at = std::time::Instant::now();
    let _ = handle.run_on_main_thread(move || {
        let queue_ms = queued_at.elapsed().as_secs_f64() * 1000.0;
        let mut detail = match panel_handle.get_webview_panel("main") {
            Ok(panel) => {
                let mut detail = objc2::MainThreadMarker::new()
                    .map(|mtm| macos_launcher_position::position_at_pointer(panel.as_panel(), mtm))
                    .unwrap_or_else(|| json!({"status": "missing-main-thread"}));
                panel.show_and_make_key();
                detail["visible"] = json!(panel.as_panel().isVisible());
                detail["keyWindow"] = json!(panel.as_panel().isKeyWindow());
                detail
            }
            Err(error) => {
                eprintln!("[flowhub-tauri] 显示 macOS Panel 失败：{error:?}");
                json!({"status": "panel-error", "error": format!("{error:?}")})
            }
        };
        focus_diagnostics::record("native-show", detail.clone());
        detail["mainThreadQueueMs"] = json!(queue_ms);
        detail["nativeShowMs"] = json!(queued_at.elapsed().as_secs_f64() * 1000.0);
        // Disk access must not delay the panel's first frame. Diagnostics retain
        // the existing opt-in setting and contain geometry, never search text.
        tauri::async_runtime::spawn_blocking(move || {
            diagnostics::record_event(&panel_handle, "launcher-show", detail);
        });
    });
}

#[cfg(target_os = "macos")]
fn configure_macos_panel(window: &tauri::WebviewWindow) -> Result<(), String> {
    let panel = window
        .to_panel::<FlowHubLauncherPanel>()
        .map_err(|error| error.to_string())?;
    panel.set_level(PanelLevel::PopUpMenu.value());
    panel.set_floating_panel(true);
    panel.set_hides_on_deactivate(false);
    // A non-activating NSPanel can become the key window and receive search
    // input without activating FlowHub or switching away from another app's
    // fullscreen Space.
    panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .full_screen_auxiliary()
            .can_join_all_spaces()
            .transient()
            .ignores_cycle()
            .into(),
    );
    Ok(())
}

fn register_hotkey(app: &tauri::AppHandle, hotkey: &str) -> Value {
    let parsed = hotkey.parse::<Shortcut>();
    match parsed {
        Ok(shortcut) => match register_platform_hotkey(app, shortcut) {
            Ok(()) => json!({ "hotkey": hotkey, "hotkeyRegistered": true }),
            Err(error) => {
                json!({ "hotkey": hotkey, "hotkeyRegistered": false, "reason": error.to_string() })
            }
        },
        Err(error) => {
            json!({ "hotkey": hotkey, "hotkeyRegistered": false, "reason": error.to_string() })
        }
    }
}

#[cfg(target_os = "macos")]
fn register_platform_hotkey(app: &tauri::AppHandle, shortcut: Shortcut) -> Result<(), String> {
    if std::env::var("FLOWHUB_TAURI_CUSTOM_HOTKEY").as_deref() == Ok("1") {
        eprintln!("[flowhub-tauri] 使用自定义 macOS 热键回退路径");
        return app
            .try_state::<macos_hotkey::MacHotkeyRuntime>()
            .ok_or_else(|| "自定义 macOS 热键运行时未初始化".to_string())?
            .register(shortcut);
    }
    let _ = app.global_shortcut().unregister_all();
    eprintln!("[flowhub-tauri] 使用官方 global-shortcut 路径");
    app.global_shortcut()
        .register(shortcut)
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
fn register_platform_hotkey(app: &tauri::AppHandle, shortcut: Shortcut) -> Result<(), String> {
    let _ = app.global_shortcut().unregister_all();
    app.global_shortcut()
        .register(shortcut)
        .map_err(|error| error.to_string())
}

pub fn run() {
    focus_diagnostics::initialize();
    let builder = tauri::Builder::default()
        .register_uri_scheme_protocol("flowhub-plugin", |context, request| {
            let uri=request.uri();
            let id=uri.host().unwrap_or("");
            let path=uri.path().trim_start_matches('/');
            let result=context.app_handle().state::<plugin_runtime::Runtime>().asset(id,path);
            let (status,body,mime)=match result {Ok((data,mime))=>(200,data,mime),Err(error)=>(404,error.into_bytes(),"text/plain")};
            tauri::http::Response::builder().status(status).header("Content-Type",mime).header("Cache-Control","no-store")
                // The sandbox gives the document an opaque origin. WebKit cannot
                // match its custom-protocol subresources against 'self'.
                .header("Content-Security-Policy",plugin_runtime::asset_csp(id))
                .body(body).unwrap()
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(index) = args.iter().position(|arg| arg == "--open-web") {
                if let Some(url) = args.get(index + 1).cloned() {
                    let handle = app.clone();
                    tauri::async_runtime::spawn_blocking(move || { let _ = web_open::open(&handle, &url); });
                }
                return;
            }
            if args.iter().any(|arg| arg == "--search-diagnostics") {
                search_diagnostic_run::start(app);
                return;
            }
            #[cfg(target_os = "macos")]
            if args.iter().any(|arg| arg == "--menu-bar-menu") {
                menu_bar::open_native_menu(app);
                return;
            }
            #[cfg(target_os = "macos")]
            if args.iter().any(|arg| arg == "--menu-bar-controls") {
                macos_item_submenu::open_controls(app);
                return;
            }
            if args.iter().any(|arg| arg == "--menu-bar-panel") {
                let _ = menu_bar::toggle_menu_bar_panel(app.clone());
            } else {
                toggle_main(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("FlowHub")
                .build(),
        )
        .plugin(tauri_plugin_opener::init());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    let hotkey_down = Arc::new(AtomicBool::new(false));
    let last_hotkey_trigger = Arc::new(Mutex::new(None::<Instant>));
    let builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler({
                let hotkey_down = hotkey_down.clone();
                let last_hotkey_trigger = last_hotkey_trigger.clone();
                move |app, shortcut, event| {
                    eprintln!(
                        "[flowhub-tauri] 官方 global-shortcut 事件：{} {:?}",
                        shortcut.into_string(),
                        event.state()
                    );
                    match event.state() {
                        ShortcutState::Pressed => {
                            // macOS may emit repeated Pressed events while the key
                            // combination is held. Toggle only on the first edge.
                            if !hotkey_down.swap(true, AtomicOrdering::AcqRel) {
                                let now = Instant::now();
                                let allow_trigger = last_hotkey_trigger
                                    .lock()
                                    .map(|mut last| {
                                        let allow = last
                                            .map(|previous| {
                                                now.duration_since(previous).as_millis() >= 250
                                            })
                                            .unwrap_or(true);
                                        if allow {
                                            *last = Some(now);
                                        }
                                        allow
                                    })
                                    .unwrap_or(true);
                                if allow_trigger {
                                    toggle_main(app);
                                } else {
                                    eprintln!("[flowhub-tauri] 忽略快捷键冷却期内的 Pressed 事件");
                                }
                            } else {
                                eprintln!("[flowhub-tauri] 忽略快捷键重复 Pressed 事件");
                            }
                        }
                        ShortcutState::Released => {
                            hotkey_down.store(false, AtomicOrdering::Release);
                        }
                    }
                }
            })
            .build(),
    );

    #[cfg(target_os = "macos")]
    let builder = builder.on_tray_icon_event(menu_bar::on_tray_event);

    builder
        .setup(|app| {
            let state = initialize_state().map_err(std::io::Error::other)?;
            let config = hydrated_config(&state).map_err(std::io::Error::other)?;
            app.manage(state);
            app.manage(plugin_runtime::Runtime::new(app.state::<AppState>().root_dir.clone()).map_err(std::io::Error::other)?);
            app.manage(plugin_status::State::new(&app.state::<AppState>().root_dir).map_err(std::io::Error::other)?);
            app.manage(plugin_canvas::State::new(&app.state::<AppState>().root_dir).map_err(std::io::Error::other)?);
            plugin_canvas::restore(app.handle());
            plugin_status::start(app.handle().clone());
            if app
                .state::<AppState>()
                .application_index_needs_refresh
                .load(AtomicOrdering::Acquire)
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || refresh_application_index(&handle));
            }
            #[cfg(target_os = "macos")]
            if std::env::var("FLOWHUB_TAURI_CUSTOM_HOTKEY").as_deref() == Ok("1") {
                app.manage(
                    macos_hotkey::MacHotkeyRuntime::install(app.handle())
                        .map_err(std::io::Error::other)?,
                );
            }
            app.manage(clipboard::ClipboardRuntime::new());
            app.manage(updater::UpdateRuntime::new(
                app.package_info().version.to_string().as_str(),
            ));
            clipboard::apply_config(app.handle(), &config).map_err(std::io::Error::other)?;

            let hotkey = config
                .pointer("/core/hotkey")
                .and_then(Value::as_str)
                .unwrap_or("Alt+Space");
            let hotkey_state = register_hotkey(app.handle(), hotkey);
            let autostart_state = apply_autostart(app.handle(), &config);
            let menu_bar_state =
                apply_menu_bar(app.handle(), &config).map_err(std::io::Error::other)?;
            let organizer_state = apply_menu_bar_organizer(app.handle(), &config);
            #[cfg(target_os = "macos")]
            menu_bar::run_smoke_test(app.handle()).map_err(std::io::Error::other)?;
            println!(
                "[flowhub-tauri] 数据目录：{}",
                app.state::<AppState>().root_dir.display()
            );
            println!("[flowhub-tauri] 快捷键状态：{hotkey_state}");
            println!("[flowhub-tauri] 登录项状态：{autostart_state}");
            println!("[flowhub-tauri] 菜单栏状态：{menu_bar_state}");
            println!("[flowhub-tauri] 菜单栏整理状态：{organizer_state}");

            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                configure_macos_panel(&window).map_err(std::io::Error::other)?;
                #[cfg(target_os = "macos")]
                focus_diagnostics::install_native_monitor();
                #[cfg(not(target_os = "macos"))]
                let _ = window.set_visible_on_all_workspaces(true);
                let main_window = window.clone();
                let main_has_focused = Arc::new(AtomicBool::new(false));
                let focus_state = main_has_focused.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = main_window.hide();
                    } else if let WindowEvent::Focused(true) = event {
                        focus_diagnostics::record("native-focus", json!({"focused": true}));
                        eprintln!("[flowhub-tauri] 主窗口获得焦点");
                        focus_state.store(true, AtomicOrdering::Release);
                    } else if let WindowEvent::Focused(false) = event {
                        focus_diagnostics::record("native-focus", json!({"focused": false}));
                        eprintln!("[flowhub-tauri] 主窗口失去焦点");
                        // Ignore the initial/stale blur generated while the
                        // launcher's hidden window is being created.
                        if !focus_state.swap(false, AtomicOrdering::AcqRel) {
                            return;
                        }
                        let now = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map(|duration| duration.as_millis() as u64)
                            .unwrap_or(0);
                        let last_show = LAST_MAIN_SHOW_MILLIS.load(AtomicOrdering::Acquire);
                        if now.saturating_sub(last_show) < 500 {
                            eprintln!("[flowhub-tauri] 忽略唤醒后的短暂失焦");
                            return;
                        }
                        let blur_window = main_window.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(120));
                            if !LAUNCHER_PINNED.load(AtomicOrdering::Acquire)
                                && !blur_window.is_focused().unwrap_or(false) {
                                eprintln!("[flowhub-tauri] 失焦后隐藏主窗口");
                                let _ = blur_window.hide();
                            }
                        });
                    }
                });
                if std::env::var("FLOWHUB_TAURI_SHOW_ON_START").as_deref() == Ok("1") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            if std::env::var("FLOWHUB_TAURI_SHOW_SETTINGS_ON_START").as_deref() == Ok("1") {
                open_settings(app.handle().clone(), None).map_err(std::io::Error::other)?;
            }

            if std::env::var("FLOWHUB_TAURI_SMOKE_TEST").as_deref() == Ok("1") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(700));
                    handle.exit(0);
                });
            }
            updater::schedule_update_checks(app.handle());
            if std::env::args().any(|arg| arg == "--menu-bar-panel") {
                menu_bar::toggle_menu_bar_panel(app.handle().clone()).map_err(std::io::Error::other)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            search_applications,
            load_application_icons,
            activate_target,
            hide_main_window,
            get_launcher_pinned,
            set_launcher_pinned,
            get_proxy_info,
            search_usage,
            open_settings,
            plugin_runtime::plugin_api,
            plugin_runtime::plugin_rpc,
            plugin_status::plugin_status_api,
            plugin_canvas::plugin_canvas_api,
            plugin_canvas::plugin_widget_rpc,
            close_settings,
            network_diagnostics::run_network_diagnostic,
            port_inspector::inspect_port,
            port_inspector::terminate_port_process,
            open_accessibility_settings,
            menu_bar::get_menu_bar_management_state,
            menu_bar::request_menu_bar_management_permission,
            menu_bar::list_menu_bar_items,
            menu_bar::toggle_menu_bar_panel,
            menu_bar::set_menu_bar_item_hidden,
            get_config_path_info,
            get_storage_info,
            search_diagnostic_run::save_search_diagnostic_run,
            focus_diagnostics::focus_diagnostics_enabled,
            focus_diagnostics::focus_diagnostics_loop_enabled,
            focus_diagnostics::record_focus_sample,
            diagnostics::get_diagnostics_state,
            diagnostics::set_diagnostics_enabled,
            diagnostics::sample_diagnostics,
            diagnostics::clear_diagnostics,
            choose_config_path,
            choose_storage_path,
            open_config_path,
            open_storage_path,
            clipboard::search_clipboard,
            clipboard::load_clipboard_assets,
            clipboard::activate_clipboard,
            clipboard::delete_clipboard,
            cloudflare_probe::inspect_cloudflare,
            updater::log_update_event,
            updater::get_update_state,
            updater::check_for_updates,
            updater::download_update,
            updater::download_and_install_update,
            updater::quit_and_install_update,
            send_test_notification,
            menu_bar::toggle_menu_bar_items
        ])
        .build(tauri::generate_context!())
        .expect("FlowHub failed to build")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                if let Err(error) = clipboard::stop_monitor(app) {
                    eprintln!("[flowhub][clipboard] shutdown failed: {error}");
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{normalize_migrated_config, validate_catalog};

    #[test]
    fn migrated_config_uses_official_default_paths() {
        let input = json!({
            "core": { "configPath": "/tmp/legacy.json" },
            "plugins": {
                "clipboard": { "settings": { "storagePath": "/tmp/legacy-data" } }
            }
        });
        let migrated = normalize_migrated_config(input);
        assert_eq!(migrated.pointer("/core/configPath"), Some(&json!("")));
        assert_eq!(
            migrated.pointer("/plugins/clipboard/settings/storagePath"),
            Some(&json!(""))
        );
        assert_eq!(migrated.pointer("/core/hotkey"), Some(&json!("Alt+Space")));
        assert_eq!(
            migrated.pointer("/plugins/tools/enabled"),
            Some(&json!(true))
        );
    }

    #[test]
    fn catalog_validation_rejects_duplicate_ids_at_any_depth() {
        let duplicate = vec![json!({
            "id": "same",
            "children": [{ "id": "same", "title": "duplicate" }]
        })];
        assert!(validate_catalog(&duplicate)
            .expect_err("duplicate ids must fail")
            .contains("重复"));
    }

    #[test]
    fn catalog_validation_accepts_nested_unique_ids() {
        let catalog = vec![json!({
            "id": "root",
            "children": [{ "id": "page", "url": "https://example.com" }]
        })];
        assert!(validate_catalog(&catalog).is_ok());
    }
}

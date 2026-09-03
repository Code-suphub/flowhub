use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, Utc};
#[cfg(target_os = "macos")]
use objc2_app_kit::NSVariableStatusItemLength;
#[cfg(target_os = "macos")]
use objc2_foundation::NSString;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering as AtomicOrdering},
        Arc, Mutex, RwLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[cfg(target_os = "macos")]
use tauri::{
    menu::{MenuBuilder, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
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
mod diagnostics;
#[cfg(target_os = "macos")]
mod macos_hotkey;
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
#[cfg(target_os = "macos")]
const FLOWHUB_TRAY_ID: &str = "flowhub-menu-bar";
#[cfg(target_os = "macos")]
const FLOWHUB_ORGANIZER_MENU_ID: &str = "flowhub-organizer";
#[cfg(target_os = "macos")]
const ORGANIZER_CONTROL_ID: &str = "flowhub-organizer-control";
#[cfg(target_os = "macos")]
const ORGANIZER_BOUNDARY_ID: &str = "flowhub-organizer-boundary";
#[cfg(target_os = "macos")]
static ORGANIZER_CONTROL_PTR: AtomicUsize = AtomicUsize::new(0);
#[cfg(target_os = "macos")]
static ORGANIZER_BOUNDARY_PTR: AtomicUsize = AtomicUsize::new(0);
#[cfg(target_os = "macos")]
static ORGANIZER_ENABLED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static ORGANIZER_COLLAPSED: AtomicBool = AtomicBool::new(false);

fn config_flag(config: &Value, pointer: &str, default: bool) -> bool {
    config
        .pointer(pointer)
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

#[cfg(target_os = "macos")]
unsafe fn organizer_tray(pointer: &AtomicUsize) -> Option<&'static tray_icon::TrayIcon> {
    let address = pointer.load(AtomicOrdering::Acquire);
    (address != 0).then(|| unsafe { &*(address as *const tray_icon::TrayIcon) })
}

#[cfg(target_os = "macos")]
fn set_organizer_autosave_name(tray: &tray_icon::TrayIcon, name: &str) {
    if let Some(status_item) = tray.ns_status_item() {
        let name = NSString::from_str(name);
        status_item.setAutosaveName(Some(&name));
    }
}

#[cfg(target_os = "macos")]
fn set_organizer_item_length(tray: &tray_icon::TrayIcon, length: f64) {
    if let Some(status_item) = tray.ns_status_item() {
        status_item.setLength(length);
    }
}

#[cfg(target_os = "macos")]
fn organizer_boundary_title(collapsed: bool) -> String {
    if collapsed {
        // AppKit may discard an empty status item whose fixed width is wider
        // than the available menu bar. Real (but invisible) content instead
        // participates in layout and pushes items on its left off-screen.
        "\u{2002}".repeat(720)
    } else {
        String::new()
    }
}

#[cfg(target_os = "macos")]
fn configure_organizer_items(enabled: bool, collapsed: bool) -> Result<(), String> {
    let control = unsafe { organizer_tray(&ORGANIZER_CONTROL_PTR) };
    let boundary = unsafe { organizer_tray(&ORGANIZER_BOUNDARY_PTR) };
    let (control, boundary) = match (control, boundary) {
        (Some(control), Some(boundary)) => (control, boundary),
        _ => {
            // New status items are inserted to the left of existing items, so
            // create the fixed arrow first and the boundary second.
            let control = tray_icon::TrayIconBuilder::new()
                .with_id(ORGANIZER_CONTROL_ID)
                .with_title(if collapsed { "‹" } else { "›" })
                .with_tooltip("展开或收起菜单栏隐藏区")
                .build()
                .map_err(|error| error.to_string())?;
            let boundary = tray_icon::TrayIconBuilder::new()
                .with_id(ORGANIZER_BOUNDARY_ID)
                .with_title(organizer_boundary_title(collapsed))
                .build()
                .map_err(|error| error.to_string())?;
            let control = Box::into_raw(Box::new(control));
            let boundary = Box::into_raw(Box::new(boundary));
            ORGANIZER_CONTROL_PTR.store(control as usize, AtomicOrdering::Release);
            ORGANIZER_BOUNDARY_PTR.store(boundary as usize, AtomicOrdering::Release);
            (unsafe { &*control }, unsafe { &*boundary })
        }
    };

    control
        .set_visible(enabled)
        .map_err(|error| error.to_string())?;
    boundary
        .set_visible(enabled)
        .map_err(|error| error.to_string())?;
    if enabled {
        set_organizer_autosave_name(control, "FlowHub.Organizer.V7.Control");
        set_organizer_autosave_name(boundary, "FlowHub.Organizer.V7.Boundary");
        control.set_title(Some(if collapsed { "‹" } else { "›" }));
        set_organizer_item_length(control, NSVariableStatusItemLength);
        boundary.set_title(Some(&organizer_boundary_title(collapsed)));
        // One point is enough to preserve ordering in the expanded state.
        // Collapsed width is derived from invisible content because AppKit
        // keeps content-backed items in its status-item layout.
        set_organizer_item_length(
            boundary,
            if collapsed {
                NSVariableStatusItemLength
            } else {
                1.0
            },
        );
    }
    ORGANIZER_ENABLED.store(enabled, AtomicOrdering::Release);
    ORGANIZER_COLLAPSED.store(collapsed, AtomicOrdering::Release);
    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_menu_bar_organizer(app: &tauri::AppHandle, config: &Value) -> Value {
    let enabled = config_flag(config, "/core/menuBar/organizerEnabled", false);
    let collapsed = enabled && config_flag(config, "/core/menuBar/collapseOnLaunch", false);
    let handle = app.clone();
    let _ = handle.run_on_main_thread(move || {
        if let Err(error) = configure_organizer_items(enabled, collapsed) {
            eprintln!("[flowhub-tauri] 菜单栏整理器配置失败：{error}");
        }
    });
    json!({ "enabled": enabled, "collapsed": collapsed })
}

#[cfg(not(target_os = "macos"))]
fn apply_menu_bar_organizer(_app: &tauri::AppHandle, _config: &Value) -> Value {
    json!({ "enabled": false, "collapsed": false, "unsupported": true })
}

#[cfg(target_os = "macos")]
fn toggle_menu_bar_organizer() -> Result<bool, String> {
    if !ORGANIZER_ENABLED.load(AtomicOrdering::Acquire) {
        return Err("请先在设置中启用菜单栏整理".to_string());
    }
    let collapsed = !ORGANIZER_COLLAPSED.load(AtomicOrdering::Acquire);
    configure_organizer_items(true, collapsed)?;
    Ok(collapsed)
}

#[cfg(target_os = "macos")]
fn enable_menu_bar_organizer(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let paths = state.paths();
    let mut config = read_json(&paths.config_path)
        .unwrap_or_else(|| serde_json::from_str(DEFAULT_CONFIG).unwrap_or_else(|_| json!({})));
    let menu_bar = ensure_object_path(&mut config, &["core", "menuBar"])?;
    menu_bar.insert("organizerEnabled".to_string(), Value::Bool(true));
    write_json_atomic(&paths.config_path, &config)?;
    apply_menu_bar_organizer(app, &config);
    Ok(())
}

#[tauri::command]
async fn toggle_menu_bar_items(app: tauri::AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(toggle_menu_bar_organizer());
        })
        .map_err(|error| error.to_string())?;
        let collapsed = receiver.await.map_err(|error| error.to_string())??;
        return Ok(json!({ "ok": true, "collapsed": collapsed }));
    }
    #[cfg(not(target_os = "macos"))]
    Ok(json!({ "ok": false, "reason": "菜单栏整理仅支持 macOS" }))
}

#[cfg(target_os = "macos")]
fn apply_menu_bar(app: &tauri::AppHandle, config: &Value) -> Result<Value, String> {
    let _ = app.remove_tray_by_id(FLOWHUB_TRAY_ID);
    if !config_flag(config, "/core/menuBar/enabled", true) {
        return Ok(json!({ "enabled": false }));
    }

    let mut menu = MenuBuilder::new(app);
    let show_launcher = config_flag(config, "/core/menuBar/showOpenLauncher", true);
    let show_settings = config_flag(config, "/core/menuBar/showOpenSettings", true);
    let show_version = config_flag(config, "/core/menuBar/showVersion", true);
    let show_quit = config_flag(config, "/core/menuBar/showQuit", true);
    if show_launcher {
        menu = menu.text("flowhub-open", "打开 FlowHub");
    }
    if show_settings {
        menu = menu.text("flowhub-settings", "设置…");
    }
    if show_launcher || show_settings {
        menu = menu.separator();
    }
    menu = menu.text(
        FLOWHUB_ORGANIZER_MENU_ID,
        "菜单栏整理 · 展开 / 收起",
    );
    if show_version || show_quit {
        menu = menu.separator();
    }
    if show_version {
        let version = MenuItem::with_id(
            app,
            "flowhub-version",
            format!("FlowHub v{}", app.package_info().version),
            false,
            None::<&str>,
        )
        .map_err(|error| error.to_string())?;
        menu = menu.item(&version);
    }
    if show_quit {
        menu = menu.text("flowhub-quit", "退出 FlowHub");
    }
    let menu = menu.build().map_err(|error| error.to_string())?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "FlowHub 缺少菜单栏图标".to_string())?;
    TrayIconBuilder::with_id(FLOWHUB_TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("FlowHub")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "flowhub-open" => toggle_main(app),
            "flowhub-settings" => {
                let _ = open_settings(app.clone(), None);
            }
            FLOWHUB_ORGANIZER_MENU_ID => {
                let result = if ORGANIZER_ENABLED.load(AtomicOrdering::Acquire) {
                    toggle_menu_bar_organizer().map(|_| ())
                } else {
                    enable_menu_bar_organizer(app)
                };
                if let Err(error) = result {
                    eprintln!("[flowhub-tauri] 菜单栏整理操作失败：{error}");
                }
            }
            "flowhub-quit" => app.exit(0),
            _ => {}
        })
        .build(app)
        .map_err(|error| error.to_string())?;
    Ok(json!({ "enabled": true }))
}

#[cfg(not(target_os = "macos"))]
fn apply_menu_bar(_app: &tauri::AppHandle, _config: &Value) -> Result<Value, String> {
    Ok(json!({ "enabled": false, "unsupported": true }))
}

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

fn app_support_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|path| path.join("FlowHub"))
        .ok_or_else(|| "无法确定系统应用数据目录".to_string())
}

fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

fn configured_path(config: &Value, keys: &[&str]) -> Option<PathBuf> {
    let mut value = config;
    for key in keys {
        value = value.get(*key)?;
    }
    let candidate = value.as_str()?.trim();
    if candidate.is_empty() {
        None
    } else {
        Some(PathBuf::from(candidate))
    }
}

fn legacy_sources() -> Vec<PathBuf> {
    let Some(base) = dirs::data_dir() else {
        return Vec::new();
    };
    ["FlowHub Tauri", "Web Organization", "Electron"]
        .into_iter()
        .map(|name| base.join(name))
        .collect()
}

fn find_legacy_config() -> Option<PathBuf> {
    for root in legacy_sources() {
        if let Some(locator) = read_json(&root.join("config-location.json")) {
            if let Some(path) = configured_path(&locator, &["configPath"]) {
                if path.is_file() {
                    return Some(path);
                }
            }
        }
        let candidate = root.join("config.json");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn find_legacy_database(config: &Value) -> Option<PathBuf> {
    if let Some(storage) =
        configured_path(config, &["plugins", "clipboard", "settings", "storagePath"])
    {
        let candidate = storage.join("weborg.db");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    legacy_sources()
        .into_iter()
        .map(|root| root.join("clipboard").join("weborg.db"))
        .find(|path| path.is_file())
}

fn normalize_migrated_config(mut config: Value) -> Value {
    if !config.is_object() {
        config = serde_json::from_str(DEFAULT_CONFIG).unwrap_or_else(|_| json!({}));
    }
    let root = config.as_object_mut().expect("config normalized as object");
    let core = root.entry("core").or_insert_with(|| json!({}));
    if let Some(core) = core.as_object_mut() {
        core.insert("configPath".to_string(), Value::String(String::new()));
        core.entry("hotkey")
            .or_insert_with(|| Value::String("Alt+Space".to_string()));
    }
    let plugins = root.entry("plugins").or_insert_with(|| json!({}));
    let clipboard = plugins.as_object_mut().and_then(|plugins| {
        plugins
            .entry("clipboard")
            .or_insert_with(|| json!({}))
            .as_object_mut()
    });
    if let Some(clipboard) = clipboard {
        let settings = clipboard.entry("settings").or_insert_with(|| json!({}));
        if let Some(settings) = settings.as_object_mut() {
            settings.insert("storagePath".to_string(), Value::String(String::new()));
        }
    }
    if let Some(plugins) = plugins.as_object_mut() {
        plugins
            .entry("tools")
            .or_insert_with(|| json!({"enabled": true, "settings": {}}));
    }
    config
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&temporary, format!("{text}\n")).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn copy_directory_contents(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory_contents(&source_path, &target_path)?;
        } else if !target_path.exists() {
            fs::copy(&source_path, &target_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn initialize_state() -> Result<AppState, String> {
    let root_dir = app_support_dir()?;
    let application_index_path = root_dir.join("application-index.json");
    let application_icon_cache_dir = root_dir.join("application-icons");
    fs::create_dir_all(&application_icon_cache_dir).map_err(|error| error.to_string())?;
    let (cached_application_index, cached_fingerprint) =
        load_application_cache(&application_index_path);
    let current_fingerprint = application_fingerprint();
    let default_config_path = root_dir.join("config.json");
    let default_storage_dir = root_dir.join("clipboard");
    let locator_path = root_dir.join("config-location.json");
    let config_path = read_json(&locator_path)
        .and_then(|locator| configured_path(&locator, &["configPath"]))
        .filter(|path| path.is_absolute() && path.is_file())
        .unwrap_or_else(|| default_config_path.clone());

    let legacy_config_path = find_legacy_config();
    let legacy_config = legacy_config_path
        .as_deref()
        .and_then(read_json)
        .unwrap_or_else(|| serde_json::from_str(DEFAULT_CONFIG).unwrap_or_else(|_| json!({})));

    if !config_path.exists() {
        write_json_atomic(
            &config_path,
            &normalize_migrated_config(legacy_config.clone()),
        )?;
    }
    let active_config = read_json(&config_path).unwrap_or_else(|| legacy_config.clone());
    let storage_dir = configured_path(
        &active_config,
        &["plugins", "clipboard", "settings", "storagePath"],
    )
    .filter(|path| path.is_absolute())
    .unwrap_or_else(|| default_storage_dir.clone());
    let db_path = storage_dir.join("weborg.db");
    fs::create_dir_all(&storage_dir).map_err(|error| error.to_string())?;
    if !db_path.exists() {
        if let Some(source) = find_legacy_database(&legacy_config) {
            if let Some(source_dir) = source.parent() {
                copy_directory_contents(source_dir, &storage_dir)
                    .map_err(|error| format!("复制现有 FlowHub 数据失败：{error}"))?;
            }
        }
    }
    let image_dir = storage_dir.join("images");
    for source_root in legacy_sources() {
        let source_images = source_root.join("clipboard").join("images");
        if source_images.is_dir() {
            copy_directory_contents(&source_images, &image_dir)
                .map_err(|error| format!("复制现有剪贴板图片失败：{error}"))?;
        }
    }

    let state = AppState {
        root_dir,
        default_config_path,
        default_storage_dir,
        paths: RwLock::new(AppPaths {
            config_path,
            storage_dir,
            db_path,
        }),
        application_index: RwLock::new(cached_application_index),
        application_index_path,
        application_index_needs_refresh: AtomicBool::new(cached_fingerprint != current_fingerprint),
        application_index_refreshing: AtomicBool::new(false),
        application_icon_cache: Mutex::new(HashMap::new()),
        application_icon_cache_dir,
    };
    initialize_database(&state)?;
    import_json_catalog_if_needed(&state)?;
    Ok(state)
}

pub(crate) fn database(state: &AppState) -> Result<Connection, String> {
    Connection::open(state.paths().db_path).map_err(|error| error.to_string())
}

fn initialize_database(state: &AppState) -> Result<(), String> {
    let connection = database(state)?;
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS usage_records (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              target_type TEXT NOT NULL,
              target_key TEXT NOT NULL,
              title TEXT NOT NULL,
              target_path TEXT,
              url TEXT,
              icon TEXT,
              use_count INTEGER NOT NULL DEFAULT 1,
              first_used_at TEXT NOT NULL,
              last_used_at TEXT NOT NULL,
              UNIQUE(target_type, target_key)
            );
            CREATE INDEX IF NOT EXISTS usage_records_recent ON usage_records(target_type, last_used_at DESC);
            CREATE INDEX IF NOT EXISTS usage_records_score ON usage_records(target_type, use_count DESC, last_used_at DESC);
            CREATE TABLE IF NOT EXISTS clipboard_records (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              kind TEXT NOT NULL,
              hash TEXT NOT NULL,
              content TEXT,
              file_name TEXT,
              source_name TEXT,
              file_paths TEXT,
              file_types TEXT,
              size INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL,
              copy_count INTEGER NOT NULL DEFAULT 1,
              UNIQUE(kind, hash)
            );
            CREATE INDEX IF NOT EXISTS clipboard_records_recent ON clipboard_records(last_seen_at DESC);
            CREATE INDEX IF NOT EXISTS clipboard_records_hash ON clipboard_records(hash);
            CREATE TABLE IF NOT EXISTS web_catalog_nodes (
              id TEXT PRIMARY KEY,
              parent_id TEXT,
              sort_order INTEGER NOT NULL,
              title TEXT NOT NULL DEFAULT '',
              url TEXT NOT NULL DEFAULT '',
              note TEXT NOT NULL DEFAULT '',
              data_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS web_catalog_nodes_parent_order ON web_catalog_nodes(parent_id, sort_order);
            CREATE TABLE IF NOT EXISTS web_catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            ",
        )
        .map_err(|error| error.to_string())
}

fn catalog_count(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row("SELECT COUNT(*) FROM web_catalog_nodes", [], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())
}

fn catalog_meta(connection: &Connection, key: &str) -> String {
    connection
        .query_row(
            "SELECT value FROM web_catalog_meta WHERE key = ?",
            [key],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
        .unwrap_or_default()
}

fn insert_catalog_nodes(
    transaction: &Transaction<'_>,
    nodes: &[Value],
    parent_id: Option<&str>,
    count: &mut usize,
) -> Result<(), String> {
    for (sort_order, node) in nodes.iter().enumerate() {
        let id = node
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if id.is_empty() {
            return Err("每个网页目录节点都需要 id".to_string());
        }
        let title = node.get("title").and_then(Value::as_str).unwrap_or("");
        let url = node.get("url").and_then(Value::as_str).unwrap_or("");
        let note = node.get("note").and_then(Value::as_str).unwrap_or("");
        let children = node
            .get("children")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut stored = node.clone();
        if let Some(object) = stored.as_object_mut() {
            object.remove("children");
        }
        transaction
            .execute(
                "INSERT INTO web_catalog_nodes(id, parent_id, sort_order, title, url, note, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![id, parent_id, sort_order as i64, title, url, note, stored.to_string()],
            )
            .map_err(|error| error.to_string())?;
        *count += 1;
        insert_catalog_nodes(transaction, &children, Some(&id), count)?;
    }
    Ok(())
}

fn replace_catalog(connection: &mut Connection, items: &[Value]) -> Result<usize, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM web_catalog_nodes", [])
        .map_err(|error| error.to_string())?;
    let mut count = 0;
    insert_catalog_nodes(&transaction, items, None, &mut count)?;
    let updated_at = Utc::now().to_rfc3339();
    transaction
        .execute(
            "INSERT OR REPLACE INTO web_catalog_meta(key, value) VALUES ('updated_at', ?)",
            [&updated_at],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(count)
}

fn import_json_catalog_if_needed(state: &AppState) -> Result<(), String> {
    let mut connection = database(state)?;
    if catalog_count(&connection)? > 0 {
        return Ok(());
    }
    let Some(config) = read_json(&state.paths().config_path) else {
        return Ok(());
    };
    let items = config
        .pointer("/plugins/web/settings/items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !items.is_empty() {
        replace_catalog(&mut connection, &items)?;
    }
    Ok(())
}

fn catalog_items(connection: &Connection) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, parent_id, data_json FROM web_catalog_nodes
             ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, parent_id, sort_order",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut grouped: HashMap<Option<String>, Vec<Value>> = HashMap::new();
    for row in rows {
        let (id, parent_id, data_json) = row.map_err(|error| error.to_string())?;
        let mut node = serde_json::from_str::<Value>(&data_json).unwrap_or_else(|_| json!({}));
        if let Some(object) = node.as_object_mut() {
            object.insert("id".to_string(), Value::String(id));
            object.remove("children");
        }
        grouped.entry(parent_id).or_default().push(node);
    }

    fn build(
        parent: Option<String>,
        grouped: &mut HashMap<Option<String>, Vec<Value>>,
    ) -> Vec<Value> {
        let mut nodes = grouped.remove(&parent).unwrap_or_default();
        for node in &mut nodes {
            let id = node
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let children = build(Some(id), grouped);
            if !children.is_empty() {
                if let Some(object) = node.as_object_mut() {
                    object.insert("children".to_string(), Value::Array(children));
                }
            }
        }
        nodes
    }

    Ok(build(None, &mut grouped))
}

pub(crate) fn hydrated_config(state: &AppState) -> Result<Value, String> {
    let mut config = read_json(&state.paths().config_path)
        .unwrap_or_else(|| serde_json::from_str(DEFAULT_CONFIG).unwrap_or_else(|_| json!({})));
    let connection = database(state)?;
    let items = catalog_items(&connection)?;
    let count = items.iter().map(count_catalog_nodes).sum::<usize>();
    let settings = ensure_object_path(&mut config, &["plugins", "web", "settings"])?;
    settings.insert("items".to_string(), Value::Array(items));
    settings.insert(
        "catalogStorage".to_string(),
        Value::String("sqlite".to_string()),
    );
    settings.insert("catalogCount".to_string(), json!(count));
    let updated_at = catalog_meta(&connection, "updated_at");
    if !updated_at.is_empty() {
        settings.insert("catalogUpdatedAt".to_string(), Value::String(updated_at));
    }
    Ok(config)
}

fn count_catalog_nodes(node: &Value) -> usize {
    1 + node
        .get("children")
        .and_then(Value::as_array)
        .map(|children| children.iter().map(count_catalog_nodes).sum())
        .unwrap_or(0)
}

fn ensure_object_path<'a>(
    value: &'a mut Value,
    keys: &[&str],
) -> Result<&'a mut Map<String, Value>, String> {
    let mut current = value;
    for key in keys {
        let object = current
            .as_object_mut()
            .ok_or_else(|| format!("配置字段 {} 必须是对象", key))?;
        current = object
            .entry((*key).to_string())
            .or_insert_with(|| json!({}));
    }
    current
        .as_object_mut()
        .ok_or_else(|| "配置节点必须是对象".to_string())
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

fn switch_storage(state: &AppState, target: &Path) -> Result<Value, String> {
    let current = state.paths();
    if current.storage_dir == target {
        return Ok(json!({ "migrated": false, "activePath": target.to_string_lossy() }));
    }
    if target.starts_with(&current.storage_dir) || current.storage_dir.starts_with(target) {
        return Err("新的存放位置不能与当前数据目录互相嵌套".to_string());
    }
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    let entries = fs::read_dir(target)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .count();
    let target_db = target.join("weborg.db");
    if entries > 0 && !target_db.exists() {
        return Err("所选目录不是空目录，也不包含 FlowHub 数据库".to_string());
    }
    let migrated = entries == 0 && current.storage_dir.is_dir();
    if migrated {
        copy_directory_contents(&current.storage_dir, target)?;
    }
    let mut paths = state.paths.write().expect("FlowHub paths lock poisoned");
    paths.storage_dir = target.to_path_buf();
    paths.db_path = target_db;
    drop(paths);
    initialize_database(state)?;
    Ok(json!({ "migrated": migrated, "activePath": target.to_string_lossy() }))
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> Result<Value, String> {
    hydrated_config(&state)
}

#[tauri::command]
fn save_config(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mut config: Value,
) -> Result<Value, String> {
    if !config.is_object() {
        return Ok(json!({ "ok": false, "reason": "配置必须是 JSON 对象" }));
    }
    let items = config
        .pointer("/plugins/web/settings/items")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "网页插件配置缺少 items 数组".to_string())?;
    validate_catalog(&items)?;
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
    clipboard::stop_monitor(&app);
    let persisted = (|| -> Result<(Value, usize), String> {
        let storage_state = switch_storage(&state, &target_storage)?;
        let mut connection = database(&state)?;
        let count = replace_catalog(&mut connection, &items)?;

        let settings = ensure_object_path(&mut config, &["plugins", "web", "settings"])?;
        settings.insert("items".to_string(), Value::Array(Vec::new()));
        settings.insert(
            "catalogStorage".to_string(),
            Value::String("sqlite".to_string()),
        );
        settings.insert("catalogCount".to_string(), json!(count));
        write_json_atomic(&target_config, &config)?;
        write_json_atomic(
            &state.root_dir.join("config-location.json"),
            &json!({ "configPath": config.pointer("/core/configPath").and_then(Value::as_str).unwrap_or("") }),
        )?;
        state
            .paths
            .write()
            .expect("FlowHub paths lock poisoned")
            .config_path = target_config;
        Ok((storage_state, count))
    })();
    let (storage_state, count) = match persisted {
        Ok(state) => state,
        Err(reason) => {
            let _ = clipboard::apply_config(&app, &previous_config);
            return Ok(json!({ "ok": false, "reason": reason }));
        }
    };

    let hydrated = hydrated_config(&state)?;
    let hotkey = hydrated
        .pointer("/core/hotkey")
        .and_then(Value::as_str)
        .unwrap_or("Alt+Space");
    let hotkey_state = register_hotkey(&app, hotkey);
    let autostart_state = apply_autostart(&app, &hydrated);
    let menu_bar_state = apply_menu_bar(&app, &hydrated)?;
    let organizer_state = apply_menu_bar_organizer(&app, &hydrated);
    clipboard::apply_config(&app, &hydrated)?;
    let _ = app.emit("flowhub:config", json!({ "config": hydrated, "query": "" }));
    Ok(json!({
        "ok": true,
        "config": hydrated,
        "pluginFailures": [],
        "coreState": { "hotkey": hotkey_state, "autostart": autostart_state, "menuBar": menu_bar_state, "organizer": organizer_state },
        "storageState": storage_state,
        "catalogState": { "count": count, "storage": "sqlite" }
    }))
}

fn validate_catalog(items: &[Value]) -> Result<(), String> {
    fn visit(nodes: &[Value], ids: &mut HashSet<String>) -> Result<(), String> {
        for node in nodes {
            let id = node
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if id.is_empty() {
                return Err("每个网页目录节点都需要 id".to_string());
            }
            if !ids.insert(id.clone()) {
                return Err(format!("目录 id 重复：{id}"));
            }
            if let Some(children) = node.get("children") {
                let children = children
                    .as_array()
                    .ok_or_else(|| format!("节点 {id} 的 children 必须是数组"))?;
                visit(children, ids)?;
            }
        }
        Ok(())
    }
    visit(items, &mut HashSet::new())
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

fn record_usage(state: &AppState, usage: &Value, fallback: &str) -> Result<(), String> {
    let target_type = match usage.get("type").and_then(Value::as_str) {
        Some("app") => "app",
        Some("page") => "page",
        _ => return Ok(()),
    };
    let target_key = if target_type == "app" {
        usage
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or(fallback)
    } else {
        usage
            .get("id")
            .or_else(|| usage.get("url"))
            .and_then(Value::as_str)
            .unwrap_or(fallback)
    };
    if target_key.trim().is_empty() {
        return Ok(());
    }
    let title = usage
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(target_key);
    let target_path = if target_type == "app" {
        usage
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or(fallback)
    } else {
        usage
            .get("breadcrumb")
            .and_then(Value::as_str)
            .unwrap_or("")
    };
    let url = usage
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or(if target_type == "page" { fallback } else { "" });
    let icon = usage.get("icon").and_then(Value::as_str).unwrap_or("");
    let now = Utc::now().to_rfc3339();
    let connection = database(state)?;
    connection
        .execute(
            "INSERT INTO usage_records(target_type, target_key, title, target_path, url, icon, use_count, first_used_at, last_used_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(target_type, target_key) DO UPDATE SET
               title = excluded.title, target_path = excluded.target_path, url = excluded.url,
               icon = excluded.icon, use_count = usage_records.use_count + 1, last_used_at = excluded.last_used_at",
            params![target_type, target_key, title, target_path, url, icon, now, now],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn hide_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
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
fn activate_target(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    payload: Value,
) -> Result<Value, String> {
    match plugin_id.as_str() {
        "web" => {
            let url = payload.get("url").and_then(Value::as_str).unwrap_or("");
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Ok(json!({ "ok": false, "reason": "非 http(s) 链接" }));
            }
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|error| error.to_string())?;
            if let Some(usage) = payload.get("usage") {
                record_usage(&state, usage, url)?;
            }
        }
        "app" => {
            let path = payload.get("path").and_then(Value::as_str).unwrap_or("");
            if path.is_empty() {
                return Ok(json!({ "ok": false, "reason": "应用路径为空" }));
            }
            app.opener()
                .open_path(path, None::<&str>)
                .map_err(|error| error.to_string())?;
            if let Some(usage) = payload.get("usage") {
                record_usage(&state, usage, path)?;
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
    Ok(json!({ "ok": true }))
}

#[tauri::command]
async fn search_usage(app: tauri::AppHandle, scope: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        search_usage_blocking(&state, &scope)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn search_usage_blocking(state: &AppState, scope: &str) -> Result<Value, String> {
    let connection = database(state)?;
    let target_type = match scope {
        "app" => "app",
        "web" => "page",
        _ => "",
    };
    let sql = "
        WITH frequent_candidates AS (
          SELECT target_type, target_key, title, target_path, url, icon, use_count, first_used_at, last_used_at
          FROM usage_records WHERE (?1 = '' OR target_type = ?1)
          ORDER BY use_count DESC, last_used_at DESC LIMIT 100
        ), recent_candidates AS (
          SELECT target_type, target_key, title, target_path, url, icon, use_count, first_used_at, last_used_at
          FROM usage_records WHERE (?1 = '' OR target_type = ?1)
          ORDER BY last_used_at DESC LIMIT 100
        )
        SELECT * FROM frequent_candidates UNION SELECT * FROM recent_candidates";
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Value> {
        let target_type: String = row.get(0)?;
        let target_key: String = row.get(1)?;
        let title: String = row.get(2)?;
        let target_path: Option<String> = row.get(3)?;
        let url: Option<String> = row.get(4)?;
        let icon: Option<String> = row.get(5)?;
        let use_count: i64 = row.get(6)?;
        let first_used_at: String = row.get(7)?;
        let last_used_at: String = row.get(8)?;
        let age_days = DateTime::parse_from_rfc3339(&last_used_at)
            .map(|date| {
                (Utc::now() - date.with_timezone(&Utc)).num_seconds().max(0) as f64 / 86_400.0
            })
            .unwrap_or(0.0);
        let score = use_count as f64 * 0.5_f64.powf(age_days / 30.0);
        Ok(json!({
            "usageType": target_type,
            "usageKey": target_key,
            "type": if target_type == "page" { "page" } else { "app" },
            "id": if target_type == "page" { target_key.clone() } else { String::new() },
            "title": title,
            "path": target_path.clone().unwrap_or_default(),
            "breadcrumb": if target_type == "page" { target_path.unwrap_or_default() } else { String::new() },
            "url": url.unwrap_or_default(),
            "icon": icon.unwrap_or_default(),
            "iconUrl": "",
            "useCount": use_count,
            "firstUsedAt": first_used_at,
            "lastUsedAt": last_used_at,
            "score": score
        }))
    };
    let rows = statement
        .query_map([target_type], map_row)
        .map_err(|error| error.to_string())?;
    for row in rows {
        entries.push(row.map_err(|error| error.to_string())?);
    }

    let mut frequent: Vec<Value> = entries
        .iter()
        .filter(|entry| entry.get("useCount").and_then(Value::as_i64).unwrap_or(0) >= 3)
        .cloned()
        .collect();
    frequent.sort_by(|left, right| {
        number(right, "score")
            .partial_cmp(&number(left, "score"))
            .unwrap_or(Ordering::Equal)
    });
    frequent.truncate(6);
    let frequent_keys: HashSet<String> = frequent
        .iter()
        .map(|entry| {
            format!(
                "{}:{}",
                text_field(entry, "usageType"),
                text_field(entry, "usageKey")
            )
        })
        .collect();
    let mut recent: Vec<Value> = entries
        .into_iter()
        .filter(|entry| {
            !frequent_keys.contains(&format!(
                "{}:{}",
                text_field(entry, "usageType"),
                text_field(entry, "usageKey")
            ))
        })
        .collect();
    recent.sort_by(|left, right| {
        text_field(right, "lastUsedAt").cmp(&text_field(left, "lastUsedAt"))
    });
    recent.truncate(6);

    // Resolve native icons only for the final cards, not every historical row.
    let icon_paths: Vec<String> = frequent
        .iter()
        .chain(recent.iter())
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("app"))
        .filter_map(|entry| {
            entry
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    let icons = application_icon_data_urls(state, &icon_paths);
    for entry in frequent.iter_mut().chain(recent.iter_mut()) {
        let path = entry.get("path").and_then(Value::as_str).unwrap_or("");
        if let Some(icon) = icons.get(path) {
            entry
                .as_object_mut()
                .expect("usage entry is an object")
                .insert("iconUrl".to_string(), Value::String(icon.clone()));
        }
    }
    Ok(json!({ "frequent": frequent, "recent": recent }))
}

fn text_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

#[tauri::command]
fn open_settings(app: tauri::AppHandle, initial_url: Option<String>) -> Result<Value, String> {
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
        .unwrap_or_else(|| "settings.html".to_string());
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
    // On macOS, the native collection behavior is configured below.  The
    // generic Tauri helper maps to `CanJoinAllSpaces`, which can leave an
    // agent window on the desktop Space instead of the Space containing the
    // currently active fullscreen app.
    #[cfg(not(target_os = "macos"))]
    let _ = window.set_visible_on_all_workspaces(true);
    #[cfg(not(target_os = "macos"))]
    let _ = window.set_always_on_top(true);
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
    let _ = handle.run_on_main_thread(move || match panel_handle.get_webview_panel("main") {
        Ok(panel) => panel.show_and_make_key(),
        Err(error) => eprintln!("[flowhub-tauri] 显示 macOS Panel 失败：{error:?}"),
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            toggle_main(app);
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
    let builder = builder.on_tray_icon_event(|_app, event| {
        if let TrayIconEvent::Click {
            id,
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            if id.0 == ORGANIZER_CONTROL_ID {
                if let Err(error) = toggle_menu_bar_organizer() {
                    eprintln!("[flowhub-tauri] 无法切换菜单栏隐藏区：{error}");
                }
            }
        }
    });

    builder
        .setup(|app| {
            let state = initialize_state().map_err(std::io::Error::other)?;
            let config = hydrated_config(&state).map_err(std::io::Error::other)?;
            app.manage(state);
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
            if std::env::var("FLOWHUB_TAURI_ORGANIZER_SMOKE_TEST").as_deref() == Ok("1") {
                configure_organizer_items(true, false).map_err(std::io::Error::other)?;
                toggle_menu_bar_organizer().map_err(std::io::Error::other)?;
                configure_organizer_items(false, false).map_err(std::io::Error::other)?;
            }
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
                        eprintln!("[flowhub-tauri] 主窗口获得焦点");
                        focus_state.store(true, AtomicOrdering::Release);
                    } else if let WindowEvent::Focused(false) = event {
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
                            if !blur_window.is_focused().unwrap_or(false) {
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

            if std::env::var("FLOWHUB_TAURI_SMOKE_TEST").as_deref() == Ok("1") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(700));
                    handle.exit(0);
                });
            }
            updater::schedule_initial_check(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            search_applications,
            load_application_icons,
            activate_target,
            hide_main_window,
            get_proxy_info,
            search_usage,
            open_settings,
            open_accessibility_settings,
            get_config_path_info,
            get_storage_info,
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
            updater::get_update_state,
            updater::check_for_updates,
            updater::download_update,
            updater::quit_and_install_update,
            send_test_notification,
            toggle_menu_bar_items
        ])
        .run(tauri::generate_context!())
        .expect("FlowHub failed to run");
}

#[cfg(test)]
mod tests {
    use super::*;

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

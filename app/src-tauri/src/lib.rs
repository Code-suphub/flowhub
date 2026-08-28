use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const DEFAULT_CONFIG: &str = include_str!("../../../config.json");
struct AppState {
    root_dir: PathBuf,
    config_path: PathBuf,
    storage_dir: PathBuf,
    db_path: PathBuf,
}

fn app_support_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|path| path.join("FlowHub Tauri"))
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
    ["FlowHub", "Web Organization", "Electron"]
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

fn initialize_state() -> Result<AppState, String> {
    let root_dir = app_support_dir()?;
    let config_path = root_dir.join("config.json");
    let storage_dir = root_dir.join("clipboard");
    let db_path = storage_dir.join("weborg.db");
    fs::create_dir_all(&storage_dir).map_err(|error| error.to_string())?;

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
    if !db_path.exists() {
        if let Some(source) = find_legacy_database(&legacy_config) {
            fs::copy(source, &db_path)
                .map_err(|error| format!("复制现有 FlowHub 数据库失败：{error}"))?;
        }
    }

    let state = AppState {
        root_dir,
        config_path,
        storage_dir,
        db_path,
    };
    initialize_database(&state)?;
    import_json_catalog_if_needed(&state)?;
    Ok(state)
}

fn database(state: &AppState) -> Result<Connection, String> {
    Connection::open(&state.db_path).map_err(|error| error.to_string())
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
    let Some(config) = read_json(&state.config_path) else {
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

fn hydrated_config(state: &AppState) -> Result<Value, String> {
    let mut config = read_json(&state.config_path)
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
    let mut connection = database(&state)?;
    let count = replace_catalog(&mut connection, &items)?;

    let settings = ensure_object_path(&mut config, &["plugins", "web", "settings"])?;
    settings.insert("items".to_string(), Value::Array(Vec::new()));
    settings.insert(
        "catalogStorage".to_string(),
        Value::String("sqlite".to_string()),
    );
    settings.insert("catalogCount".to_string(), json!(count));
    write_json_atomic(&state.config_path, &config)?;

    let hydrated = hydrated_config(&state)?;
    let hotkey = hydrated
        .pointer("/core/hotkey")
        .and_then(Value::as_str)
        .unwrap_or("Alt+Space");
    let hotkey_state = register_hotkey(&app, hotkey);
    let _ = app.emit("flowhub:config", json!({ "config": hydrated, "query": "" }));
    Ok(json!({
        "ok": true,
        "config": hydrated,
        "pluginFailures": [],
        "coreState": hotkey_state,
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

#[tauri::command]
fn search_applications(query: String, limit: usize, offset: usize) -> Vec<Value> {
    let keyword = query.trim().to_lowercase();
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
            let title = file_name.trim_end_matches(".app").to_string();
            let hay = format!("{title} {file_name} {}", path.display()).to_lowercase();
            if keyword.is_empty() || hay.contains(&keyword) {
                applications.push(json!({
                    "kind": "app",
                    "title": title,
                    "fileName": file_name,
                    "path": path.to_string_lossy(),
                    "bundleId": "",
                    "hay": hay,
                    "iconUrl": ""
                }));
            }
        }
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
        .into_iter()
        .skip(offset)
        .take(limit.clamp(1, 100))
        .collect()
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

fn hide_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
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
            if content.is_empty() {
                return Ok(json!({ "ok": false, "reason": "备忘内容为空" }));
            }
            let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
            clipboard
                .set_text(content.to_string())
                .map_err(|error| error.to_string())?;
        }
        _ => {
            return Ok(
                json!({ "ok": false, "reason": format!("Tauri 迁移版暂未迁移插件：{plugin_id}") }),
            )
        }
    }
    let _ = app.emit("flowhub:usage-updated", ());
    hide_main(&app);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
fn search_usage(state: State<'_, AppState>, scope: String) -> Result<Value, String> {
    let connection = database(&state)?;
    let target_type = match scope.as_str() {
        "app" => Some("app"),
        "web" => Some("page"),
        _ => None,
    };
    let sql = if target_type.is_some() {
        "SELECT target_type, target_key, title, target_path, url, icon, use_count, first_used_at, last_used_at FROM usage_records WHERE target_type = ?"
    } else {
        "SELECT target_type, target_key, title, target_path, url, icon, use_count, first_used_at, last_used_at FROM usage_records"
    };
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
    if let Some(target_type) = target_type {
        let rows = statement
            .query_map([target_type], map_row)
            .map_err(|error| error.to_string())?;
        for row in rows {
            entries.push(row.map_err(|error| error.to_string())?);
        }
    } else {
        let rows = statement
            .query_map([], map_row)
            .map_err(|error| error.to_string())?;
        for row in rows {
            entries.push(row.map_err(|error| error.to_string())?);
        }
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
fn open_settings(app: tauri::AppHandle) -> Result<Value, String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(json!({ "ok": true }));
    }
    WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title("FlowHub 设置 · Tauri")
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
    json!({
        "available": true,
        "configuredPath": "",
        "defaultPath": state.config_path.to_string_lossy(),
        "resolvedPath": state.config_path.to_string_lossy(),
        "activePath": state.config_path.to_string_lossy()
    })
}

#[tauri::command]
fn get_storage_info(state: State<'_, AppState>) -> Value {
    json!({
        "available": true,
        "configuredPath": "",
        "defaultPath": state.storage_dir.to_string_lossy(),
        "resolvedPath": state.storage_dir.to_string_lossy(),
        "activePath": state.storage_dir.to_string_lossy(),
        "migrated": true,
        "isolatedCopy": true
    })
}

#[tauri::command]
fn open_config_path(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    app.opener()
        .open_path(state.config_path.to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())?;
    Ok(json!({ "ok": true, "path": state.config_path.to_string_lossy() }))
}

#[tauri::command]
fn open_storage_path(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    app.opener()
        .open_path(state.storage_dir.to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())?;
    Ok(json!({ "ok": true, "path": state.storage_dir.to_string_lossy() }))
}

fn toggle_main(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    let _ = window.center();
    let _ = window.show();
    let _ = window.set_focus();
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(config) = hydrated_config(&state) {
            let _ = app.emit("flowhub:config", json!({ "config": config, "query": "" }));
        }
    }
}

fn register_hotkey(app: &tauri::AppHandle, hotkey: &str) -> Value {
    let _ = app.global_shortcut().unregister_all();
    let parsed = hotkey.parse::<Shortcut>();
    match parsed {
        Ok(shortcut) => match app.global_shortcut().register(shortcut) {
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_main(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let state = initialize_state().map_err(std::io::Error::other)?;
            let config = hydrated_config(&state).map_err(std::io::Error::other)?;
            app.manage(state);

            let hotkey = config
                .pointer("/core/hotkey")
                .and_then(Value::as_str)
                .unwrap_or("Alt+Space");
            let hotkey_state = register_hotkey(app.handle(), hotkey);
            println!(
                "[flowhub-tauri] 数据目录：{}",
                app.state::<AppState>().root_dir.display()
            );
            println!("[flowhub-tauri] 快捷键状态：{hotkey_state}");

            if let Some(window) = app.get_webview_window("main") {
                let main_window = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = main_window.hide();
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            search_applications,
            activate_target,
            search_usage,
            open_settings,
            open_accessibility_settings,
            get_config_path_info,
            get_storage_info,
            open_config_path,
            open_storage_path
        ])
        .run(tauri::generate_context!())
        .expect("FlowHub Tauri failed to run");
}

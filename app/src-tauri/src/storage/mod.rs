//! Storage leases, schema/catalog access, startup migration and snapshot preparation.
//! Lock order remains config_save -> storage_access -> paths. Connections retain
//! their shared storage lease until SQLite closes; config_save owns undo recovery.
mod usage;
use crate::{
    application_fingerprint, config_save, load_application_cache, AppPaths, AppState,
    DEFAULT_CONFIG,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering},
        Mutex, RwLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};
pub(crate) use usage::{record_usage, search_usage};
fn app_support_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|path| path.join("FlowHub"))
        .ok_or_else(|| "无法确定系统应用数据目录".to_string())
}

pub(crate) fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

pub(crate) fn configured_path(config: &Value, keys: &[&str]) -> Option<PathBuf> {
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

pub(crate) fn normalize_migrated_config(mut config: Value) -> Value {
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

pub(crate) fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&temporary, format!("{text}\n")).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

// Small settings-only edits share the save gate and recovery check. They never
// acquire a database lease or change paths; full saves remain in config_save.
pub(crate) fn update_settings(
    state: &AppState,
    update: impl FnOnce(&mut Value) -> Result<(), String>,
) -> Result<Value, String> {
    let _save = state
        .config_save
        .lock()
        .map_err(|error| error.to_string())?;
    config_save::check_ready(&state.root_dir)?;
    let paths = state.paths();
    let mut config = read_json(&paths.config_path)
        .unwrap_or_else(|| serde_json::from_str(DEFAULT_CONFIG).unwrap_or_else(|_| json!({})));
    update(&mut config)?;
    write_json_atomic(&paths.config_path, &config)?;
    Ok(config)
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

pub(crate) fn initialize_state() -> Result<AppState, String> {
    let root_dir = app_support_dir()?;
    config_save::recover(&root_dir)?;
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
    let existing_store = db_path.exists();
    if existing_store {
        validate_existing_storage(&db_path)?;
    }
    if !existing_store {
        if let Some(source) = find_legacy_database(&legacy_config) {
            if let Some(source_dir) = source.parent() {
                copy_directory_contents(source_dir, &storage_dir)
                    .map_err(|error| format!("复制现有 FlowHub 数据失败：{error}"))?;
            }
        }
    }
    let image_dir = storage_dir.join("images");
    for source_root in if existing_store {
        Vec::new()
    } else {
        legacy_sources()
    } {
        let source_images = source_root.join("clipboard").join("images");
        if source_images.is_dir() {
            copy_directory_contents(&source_images, &image_dir)
                .map_err(|error| format!("复制现有剪贴板图片失败：{error}"))?;
        }
    }

    let state = AppState {
        storage_access: RwLock::new(()),
        config_save: Mutex::new(()),
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
    initialize_startup_catalog(&state, existing_store)?;
    Ok(state)
}

pub(crate) fn initialize_startup_catalog(
    state: &AppState,
    existing_store: bool,
) -> Result<(), String> {
    if !existing_store {
        initialize_database(state)?;
        import_json_catalog_if_needed(state)?;
    }
    Ok(())
}

// Drop the connection before releasing the lease. All database callers, including
// usage/catalog writes, participate in migration without per-command locking.
pub(crate) struct StorageConnection<'a> {
    connection: Connection,
    pub(crate) storage_dir: PathBuf,
    _lease: std::sync::RwLockReadGuard<'a, ()>,
}

impl std::ops::Deref for StorageConnection<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.connection
    }
}

impl std::ops::DerefMut for StorageConnection<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.connection
    }
}

pub(crate) fn database(state: &AppState) -> Result<StorageConnection<'_>, String> {
    let lease = state
        .storage_access
        .read()
        .map_err(|error| error.to_string())?;
    config_save::check_ready(&state.root_dir)?;
    let paths = state.paths();
    Ok(StorageConnection {
        connection: Connection::open(paths.db_path).map_err(|error| error.to_string())?,
        storage_dir: paths.storage_dir,
        _lease: lease,
    })
}

pub(crate) fn initialize_database(state: &AppState) -> Result<(), String> {
    let connection = database(state)?;
    initialize_schema(&connection)
}

pub(crate) fn initialize_schema(connection: &Connection) -> Result<(), String> {
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

pub(crate) fn catalog_count(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row("SELECT COUNT(*) FROM web_catalog_nodes", [], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())
}

pub(crate) fn catalog_meta(connection: &Connection, key: &str) -> String {
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

pub(crate) fn replace_catalog(
    connection: &mut Connection,
    items: &[Value],
) -> Result<usize, String> {
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

pub(crate) fn catalog_items(connection: &Connection) -> Result<Vec<Value>, String> {
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
    let connection = database(state)?;
    let mut config = read_json(&state.paths().config_path)
        .unwrap_or_else(|| serde_json::from_str(DEFAULT_CONFIG).unwrap_or_else(|_| json!({})));
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

pub(crate) fn count_catalog_nodes(node: &Value) -> usize {
    1 + node
        .get("children")
        .and_then(Value::as_array)
        .map(|children| children.iter().map(count_catalog_nodes).sum())
        .unwrap_or(0)
}

pub(crate) fn ensure_object_path<'a>(
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

// Caller holds exclusive storage access. Stage the complete snapshot so a failed
// copy cannot leave a partial database that a retry mistakes for an existing store.
fn copy_storage_snapshot(source: &Path, target: &Path) -> Result<(), String> {
    static SNAPSHOT_ID: AtomicU64 = AtomicU64::new(0);
    let staging = target.with_file_name(format!(
        ".flowhub-migration-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        SNAPSHOT_ID.fetch_add(1, AtomicOrdering::Relaxed)
    ));
    fs::create_dir(&staging).map_err(|error| error.to_string())?;
    let result = (|| {
        for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            if matches!(
                name.to_str(),
                Some("weborg.db" | "weborg.db-wal" | "weborg.db-shm" | "weborg.db-journal")
            ) {
                continue;
            }
            let destination = staging.join(name);
            if entry.path().is_dir() {
                copy_directory_contents(&entry.path(), &destination)?;
            } else {
                fs::copy(entry.path(), destination).map_err(|error| error.to_string())?;
            }
        }
        let connection =
            Connection::open(source.join("weborg.db")).map_err(|error| error.to_string())?;
        connection
            .backup("main", staging.join("weborg.db"), None)
            .map_err(|error| error.to_string())?;
        initialize_schema(
            &Connection::open(staging.join("weborg.db")).map_err(|error| error.to_string())?,
        )?;
        // On macOS rename atomically replaces an empty destination directory.
        fs::rename(&staging, target).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

#[cfg(test)]
pub(crate) fn switch_storage(state: &AppState, target: &Path) -> Result<Value, String> {
    let _exclusive = state
        .storage_access
        .write()
        .map_err(|error| error.to_string())?;
    let result = prepare_storage(state, target)?;
    let active = PathBuf::from(result["activePath"].as_str().unwrap());
    let mut paths = state.paths.write().expect("FlowHub paths lock poisoned");
    paths.storage_dir = active.clone();
    paths.db_path = active.join("weborg.db");
    Ok(result)
}

// Read-only validation must precede schema initialization or recovery-journal
// writes. Reject unsupported stores rather than guessing how to upgrade them.
pub(crate) fn validate_existing_storage(path: &Path) -> Result<(), String> {
    let validate = || -> Result<(), String> {
        let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        let integrity: String = db
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if integrity != "ok" {
            return Err(integrity);
        }
        for (table, columns) in [
            ("usage_records", "id,target_type,target_key,title,target_path,url,icon,use_count,first_used_at,last_used_at"),
            ("clipboard_records", "id,kind,hash,content,file_name,source_name,file_paths,file_types,size,created_at,last_seen_at,copy_count"),
            ("web_catalog_nodes", "id,parent_id,sort_order,title,url,note,data_json"),
            ("web_catalog_meta", "key,value"),
        ] {
            let kind: String = db.query_row("SELECT type FROM sqlite_master WHERE name=?", [table], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if kind != "table" { return Err(format!("{table} 必须是数据表")); }
            db.prepare(&format!("SELECT {columns} FROM {table} LIMIT 0")).map_err(|e| e.to_string())?;
        }
        let mut query = db
            .prepare("SELECT data_json FROM web_catalog_nodes")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let value: Value = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            if !value.is_object() {
                return Err("网页目录节点必须是对象".into());
            }
        }
        let items = catalog_items(&db)?;
        validate_catalog(&items)?;
        if items.iter().map(count_catalog_nodes).sum::<usize>() as i64 != catalog_count(&db)? {
            return Err("网页目录含孤立节点或循环引用".into());
        }
        Ok(())
    };
    validate()
        .map_err(|e| format!("无法打开目标 FlowHub 数据库（未知格式、版本不兼容或数据损坏）：{e}"))
}

// Caller holds exclusive storage access; preparing a destination never publishes it.
pub(crate) fn prepare_storage(state: &AppState, target: &Path) -> Result<Value, String> {
    let current = state.paths();
    if current.storage_dir == target {
        return Ok(
            json!({ "operation": "save", "migrated": false, "activePath": target.to_string_lossy() }),
        );
    }
    if target.starts_with(&current.storage_dir) || current.storage_dir.starts_with(target) {
        return Err("新的存放位置不能与当前数据目录互相嵌套".to_string());
    }
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    // Resolve aliases before copying, including a target reached through a symlink.
    let resolved_source =
        fs::canonicalize(&current.storage_dir).map_err(|error| error.to_string())?;
    let resolved_target = fs::canonicalize(target).map_err(|error| error.to_string())?;
    if resolved_source == resolved_target {
        return Ok(
            json!({ "operation": "save", "migrated": false, "activePath": current.storage_dir.to_string_lossy() }),
        );
    }
    if resolved_target.starts_with(&resolved_source)
        || resolved_source.starts_with(&resolved_target)
    {
        return Err("新的存放位置不能与当前数据目录互相嵌套".to_string());
    }
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
        copy_storage_snapshot(&current.storage_dir, target)?;
    }
    if !migrated {
        validate_existing_storage(&target_db)?;
    }
    Ok(
        json!({ "operation": if migrated { "migrate" } else { "open" },
        "migrated": migrated, "activePath": target.to_string_lossy() }),
    )
}

pub(crate) fn validate_catalog(items: &[Value]) -> Result<(), String> {
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

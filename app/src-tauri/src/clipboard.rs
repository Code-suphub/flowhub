use crate::{application_icon_data_urls, database, hide_main, AppState};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use clipboard_rs::{
    common::RustImage, Clipboard, ClipboardContext, ClipboardHandler, ClipboardWatcher,
    ClipboardWatcherContext, ContentFormat, RustImageData, WatcherShutdown,
};
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use image::ImageFormat;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Cursor,
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};

pub struct ClipboardRuntime {
    shutdown: Mutex<Option<(WatcherShutdown, thread::JoinHandle<()>)>>,
    suppressed: Mutex<Option<(String, Instant)>>,
    writer: Mutex<Option<ClipboardWriter>>,
}

impl ClipboardRuntime {
    pub fn new() -> Self {
        Self {
            shutdown: Mutex::new(None),
            suppressed: Mutex::new(None),
            writer: Mutex::new(None),
        }
    }

    fn suppress(&self, signature: String) {
        *self
            .suppressed
            .lock()
            .expect("clipboard suppression lock poisoned") =
            Some((signature, Instant::now() + Duration::from_secs(2)));
    }

    fn should_suppress(&self, signature: &str) -> bool {
        let mut guard = self
            .suppressed
            .lock()
            .expect("clipboard suppression lock poisoned");
        let Some((expected, expires_at)) = guard.as_ref() else {
            return false;
        };
        if Instant::now() > *expires_at {
            *guard = None;
            return false;
        }
        if expected == signature {
            *guard = None;
            return true;
        }
        false
    }
}

struct ClipboardChangeHandler {
    app: tauri::AppHandle,
}

impl ClipboardHandler for ClipboardChangeHandler {
    fn on_clipboard_change(&mut self) {
        if let Err(error) = capture_clipboard(&self.app) {
            eprintln!("[flowhub][clipboard] 读取剪贴板失败：{error}");
            crate::diagnostics::record_event(
                &self.app,
                "clipboard_capture_failed",
                json!({"stage": "read_or_store"}),
            );
        }
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn signature(kind: &str, hash: &str) -> String {
    format!("{kind}:{hash}")
}

fn normalize_file_path(value: &str) -> String {
    if value.starts_with("file://") {
        if let Ok(url) = url::Url::parse(value) {
            if let Ok(path) = url.to_file_path() {
                return path.to_string_lossy().to_string();
            }
        }
    }
    value.to_string()
}

fn image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_lowercase().as_str(),
                "png"
                    | "jpg"
                    | "jpeg"
                    | "gif"
                    | "webp"
                    | "bmp"
                    | "tif"
                    | "tiff"
                    | "heic"
                    | "heif"
                    | "avif"
                    | "svg"
                    | "ico"
            )
        })
        .unwrap_or(false)
}

fn add_text(
    state: &AppState,
    text: &str,
    hash: &str,
    timing: &mut CaptureTiming,
    now: &str,
) -> Result<(), String> {
    let connection = timing.measure("dbOpen", || database(state))?;
    timing.measure("dbExecute", || connection.execute(
            "INSERT INTO clipboard_records(kind, hash, content, size, created_at, last_seen_at, copy_count)
             VALUES ('text', ?, ?, ?, ?, ?, 1)
             ON CONFLICT(kind, hash) DO UPDATE SET last_seen_at = excluded.last_seen_at, copy_count = clipboard_records.copy_count + 1",
            params![hash, text, text.len() as i64, now, now],
        ))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn add_image(state: &AppState, bytes: &[u8], hash: &str, now: &str) -> Result<(), String> {
    let connection = database(state)?;
    let image_dir = connection.storage_dir.join("images");
    fs::create_dir_all(&image_dir).map_err(|error| error.to_string())?;
    let file_name = format!("{hash}.png");
    let image_path = image_dir.join(&file_name);
    if !image_path.exists() {
        fs::write(&image_path, bytes).map_err(|error| error.to_string())?;
    }
    connection
        .execute(
            "INSERT INTO clipboard_records(kind, hash, file_name, size, created_at, last_seen_at, copy_count)
             VALUES ('image', ?, ?, ?, ?, ?, 1)
             ON CONFLICT(kind, hash) DO UPDATE SET last_seen_at = excluded.last_seen_at, copy_count = clipboard_records.copy_count + 1",
            params![hash, file_name, bytes.len() as i64, now, now],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn add_files(state: &AppState, paths: &[String], hash: &str, now: &str) -> Result<(), String> {
    let types: Vec<&str> = paths
        .iter()
        .map(|path| {
            if image_file(Path::new(path)) {
                "image"
            } else {
                "file"
            }
        })
        .collect();
    let size = paths
        .iter()
        .filter_map(|path| fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .sum::<u64>();
    database(state)?
        .execute(
            "INSERT INTO clipboard_records(kind, hash, file_paths, file_types, size, created_at, last_seen_at, copy_count)
             VALUES ('file', ?, ?, ?, ?, ?, ?, 1)
             ON CONFLICT(kind, hash) DO UPDATE SET file_paths = excluded.file_paths, file_types = excluded.file_types,
               size = excluded.size, last_seen_at = excluded.last_seen_at, copy_count = clipboard_records.copy_count + 1",
            params![
                hash,
                serde_json::to_string(paths).map_err(|error| error.to_string())?,
                serde_json::to_string(&types).map_err(|error| error.to_string())?,
                size as i64,
                now,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

const WRITE_QUEUE_CAPACITY: usize = 64;
const WRITE_QUEUE_BYTES: usize = 64 * 1024 * 1024;

enum ClipboardPayload {
    Text(String),
    Image(Vec<u8>),
    Files(Vec<String>),
}

struct PendingClipboard {
    payload: ClipboardPayload,
    hash: String,
    captured_at: String,
    queued_at: Instant,
    capture_report: Value,
    reservation: QueueReservation,
}

// Reservation survives dequeue so the byte budget includes the in-flight write.
struct QueueReservation {
    bytes: usize,
    budget: Arc<AtomicUsize>,
}
impl QueueReservation {
    fn reserve(budget: &Arc<AtomicUsize>, bytes: usize) -> Result<Self, String> {
        budget
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes)
                    .filter(|next| *next <= WRITE_QUEUE_BYTES)
            })
            .map_err(|_| "clipboard write queue memory limit reached".to_string())?;
        Ok(Self {
            bytes,
            budget: budget.clone(),
        })
    }
}
impl Drop for QueueReservation {
    fn drop(&mut self) {
        self.budget.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

#[derive(Clone)]
struct ClipboardWriter {
    sender: SyncSender<PendingClipboard>,
    budget: Arc<AtomicUsize>,
    worker: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
}
impl ClipboardWriter {
    fn start(app: tauri::AppHandle) -> Result<Self, String> {
        let (sender, receiver) = mpsc::sync_channel::<PendingClipboard>(WRITE_QUEUE_CAPACITY);
        let worker = thread::Builder::new()
            .name("clipboard-writer".into())
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    let queue_wait_ms = job.queued_at.elapsed().as_secs_f64() * 1000.0;
                    crate::diagnostics::record_event(
                        &app,
                        "clipboard_capture_timing",
                        job.capture_report.clone(),
                    );
                    let mut timing = CaptureTiming::new(&app);
                    timing.event = "clipboard_persistence_timing";
                    timing.bytes = job.reservation.bytes;
                    timing.phases.push(("queueWait", queue_wait_ms));
                    let state = app.state::<AppState>();
                    let result = match &job.payload {
                        ClipboardPayload::Text(text) => {
                            timing.kind = "text";
                            add_text(&state, text, &job.hash, &mut timing, &job.captured_at)
                        }
                        ClipboardPayload::Image(bytes) => {
                            timing.kind = "image";
                            timing.measure("storeImage", || {
                                add_image(&state, bytes, &job.hash, &job.captured_at)
                            })
                        }
                        ClipboardPayload::Files(paths) => {
                            timing.kind = "file";
                            timing.measure("storeFiles", || {
                                add_files(&state, paths, &job.hash, &job.captured_at)
                            })
                        }
                    };
                    match result {
                        Ok(()) => {
                            timing.outcome = "stored";
                            let _ = timing
                                .measure("emit", || app.emit("flowhub:clipboard-updated", ()));
                        }
                        Err(_) => {
                            crate::diagnostics::record_event(
                                &app,
                                "clipboard_persistence_failed",
                                json!({"kind": timing.kind}),
                            );
                            eprintln!("[flowhub][clipboard] queued clipboard persistence failed");
                        }
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            sender,
            budget: Arc::new(AtomicUsize::new(0)),
            worker: Arc::new(Mutex::new(Some(worker))),
        })
    }

    // Only call after the watcher has joined, so no producer clone survives.
    fn finish(self) -> Result<(), String> {
        drop(self.sender);
        if let Some(worker) = self.worker.lock().map_err(|e| e.to_string())?.take() {
            worker
                .join()
                .map_err(|_| "clipboard writer panicked".to_string())?;
        }
        Ok(())
    }
    fn enqueue(
        &self,
        payload: ClipboardPayload,
        hash: String,
        captured_at: &str,
        timing: &mut CaptureTiming,
    ) -> Result<(), String> {
        let bytes = match &payload {
            ClipboardPayload::Text(value) => value.len(),
            ClipboardPayload::Image(value) => value.len(),
            ClipboardPayload::Files(paths) => paths.iter().map(String::len).sum(),
        };
        timing.bytes = bytes;
        timing.outcome = "queued";
        let report = timing.report();
        timing.outcome = "error";
        self.submit(payload, hash, captured_at, bytes, report)?;
        timing.outcome = "queued";
        timing.emit_on_drop = false;
        Ok(())
    }
}

impl ClipboardWriter {
    fn submit(
        &self,
        payload: ClipboardPayload,
        hash: String,
        captured_at: &str,
        bytes: usize,
        capture_report: Value,
    ) -> Result<(), String> {
        let reservation = QueueReservation::reserve(&self.budget, bytes)?;
        let job = PendingClipboard {
            payload,
            hash,
            captured_at: captured_at.into(),
            queued_at: Instant::now(),
            capture_report,
            reservation,
        };
        self.sender
            .try_send(job)
            .map_err(|_| "clipboard write queue full or unavailable".to_string())
    }
}

// Opt-in diagnostic timings contain no clipboard content, paths or hashes.
struct CaptureTiming<'a> {
    app: &'a tauri::AppHandle,
    started: Instant,
    phases: Vec<(&'static str, f64)>,
    kind: &'static str,
    bytes: usize,
    outcome: &'static str,
    event: &'static str,
    emit_on_drop: bool,
}

impl<'a> CaptureTiming<'a> {
    fn new(app: &'a tauri::AppHandle) -> Self {
        Self {
            app,
            started: Instant::now(),
            phases: Vec::new(),
            kind: "unknown",
            bytes: 0,
            outcome: "error",
            event: "clipboard_capture_timing",
            emit_on_drop: true,
        }
    }
    fn measure<T>(&mut self, phase: &'static str, work: impl FnOnce() -> T) -> T {
        let started = Instant::now();
        let result = work();
        self.phases
            .push((phase, started.elapsed().as_secs_f64() * 1000.0));
        result
    }
}

impl CaptureTiming<'_> {
    fn report(&self) -> Value {
        json!({ "totalMs": self.started.elapsed().as_secs_f64() * 1000.0,
            "phases": self.phases, "kind": self.kind, "bytes": self.bytes, "outcome": self.outcome })
    }
}
impl Drop for CaptureTiming<'_> {
    fn drop(&mut self) {
        if self.emit_on_drop {
            crate::diagnostics::record_event(self.app, self.event, self.report());
        }
    }
}

fn capture_clipboard(app: &tauri::AppHandle) -> Result<(), String> {
    let mut timing = CaptureTiming::new(app);
    let context = timing
        .measure("context", ClipboardContext::new)
        .map_err(|error| error.to_string())?;
    let captured_at = Utc::now().to_rfc3339();
    let runtime = app.state::<ClipboardRuntime>();
    let writer = runtime
        .writer
        .lock()
        .expect("clipboard writer lock poisoned")
        .clone()
        .ok_or("clipboard writer unavailable")?;
    let mut changed = false;
    let mut captured = false;
    let mut failed_formats = Vec::new();

    // An advertised format may be empty or unreadable. Only stop after actually
    // reading a payload; an intentional self-copy suppression still counts.
    if timing.measure("hasFiles", || context.has(ContentFormat::Files)) {
        match timing.measure("readFiles", || context.get_files()) {
            Ok(paths) => {
                let files: Vec<String> = paths
                    .into_iter()
                    .map(|path| normalize_file_path(&path))
                    .filter(|path| !path.is_empty())
                    .collect();
                if !files.is_empty() {
                    captured = true;
                    timing.kind = "file";
                    let hash = timing.measure("hash", || sha256(files.join("\0").as_bytes()));
                    if !runtime.should_suppress(&signature("file", &hash)) {
                        writer.enqueue(
                            ClipboardPayload::Files(files),
                            hash,
                            &captured_at,
                            &mut timing,
                        )?;
                        changed = true;
                    }
                } else {
                    failed_formats.push("files_empty");
                }
            }
            Err(_) => failed_formats.push("files_read"),
        }
    }
    if !captured && timing.measure("hasImage", || context.has(ContentFormat::Image)) {
        match timing
            .measure("readImage", || context.get_image())
            .and_then(|image| timing.measure("encodePng", || image.to_png()))
        {
            Ok(png) if !png.get_bytes().is_empty() => {
                captured = true;
                let bytes = png.get_bytes();
                timing.kind = "image";
                timing.bytes = bytes.len();
                let hash = timing.measure("hash", || sha256(bytes));
                if !runtime.should_suppress(&signature("image", &hash)) {
                    writer.enqueue(
                        ClipboardPayload::Image(bytes.to_vec()),
                        hash,
                        &captured_at,
                        &mut timing,
                    )?;
                    changed = true;
                }
            }
            _ => failed_formats.push("image_read"),
        }
    }
    if !captured && timing.measure("hasText", || context.has(ContentFormat::Text)) {
        match timing.measure("readText", || context.get_text()) {
            Ok(text) if !text.trim().is_empty() => {
                captured = true;
                timing.kind = "text";
                timing.bytes = text.len();
                let hash = timing.measure("hash", || sha256(text.as_bytes()));
                if !runtime.should_suppress(&signature("text", &hash)) {
                    writer.enqueue(
                        ClipboardPayload::Text(text),
                        hash,
                        &captured_at,
                        &mut timing,
                    )?;
                    changed = true;
                }
            }
            Ok(_) => {}
            Err(_) => failed_formats.push("text_read"),
        }
    }
    if !failed_formats.is_empty() {
        crate::diagnostics::record_event(
            app,
            "clipboard_capture_fallback",
            json!({"failedFormats": failed_formats, "recovered": captured}),
        );
    }

    timing.outcome = if changed {
        "queued"
    } else if captured {
        "suppressed"
    } else {
        "empty_or_unsupported"
    };
    Ok(())
}

pub fn start_monitor(app: &tauri::AppHandle) -> Result<(), String> {
    let runtime = app.state::<ClipboardRuntime>();
    let mut shutdown = runtime
        .shutdown
        .lock()
        .expect("clipboard monitor lock poisoned");
    if shutdown.is_some() {
        return Ok(());
    }
    // Stop joins the watcher before closing and draining this writer.
    let mut writer = runtime
        .writer
        .lock()
        .expect("clipboard writer lock poisoned");
    if writer.is_none() {
        *writer = Some(ClipboardWriter::start(app.clone())?);
    }
    drop(writer);
    #[cfg(target_os = "macos")]
    let mut watcher = ClipboardWatcherContext::new_with_interval(Duration::from_millis(100))
        .map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let mut watcher = ClipboardWatcherContext::new().map_err(|error| error.to_string())?;
    let channel = watcher
        .add_handler(ClipboardChangeHandler { app: app.clone() })
        .get_shutdown_channel();
    let worker = thread::spawn(move || watcher.start_watch());
    *shutdown = Some((channel, worker));
    Ok(())
}

pub fn stop_monitor(app: &tauri::AppHandle) -> Result<(), String> {
    let runtime = app.state::<ClipboardRuntime>();
    let mut shutdown = runtime
        .shutdown
        .lock()
        .expect("clipboard monitor lock poisoned");
    // Hold the lifecycle lock through both joins to exclude a concurrent restart.
    let watcher_result = if let Some((channel, worker)) = shutdown.take() {
        channel.stop();
        worker
            .join()
            .map_err(|_| "clipboard watcher panicked".to_string())
    } else {
        Ok(())
    };
    let writer = runtime
        .writer
        .lock()
        .expect("clipboard writer lock poisoned")
        .take();
    if let Some(writer) = writer {
        writer.finish()?;
    }
    watcher_result
}

pub fn apply_config(app: &tauri::AppHandle, config: &Value) -> Result<(), String> {
    let enabled = config
        .pointer("/plugins/clipboard/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if enabled {
        start_monitor(app)?;
    } else {
        stop_monitor(app)?;
    }
    let retention_days = config
        .pointer("/plugins/clipboard/settings/retentionDays")
        .and_then(Value::as_i64)
        .unwrap_or(30);
    cleanup(&app.state::<AppState>(), retention_days)?;
    Ok(())
}

fn parse_string_array(value: Option<String>) -> Vec<String> {
    value
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn image_data_url(storage_dir: &Path, file_name: &str) -> String {
    if file_name.is_empty()
        || Path::new(file_name)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(file_name)
    {
        return String::new();
    }
    fs::read(storage_dir.join("images").join(file_name))
        .map(|bytes| format!("data:image/png;base64,{}", BASE64.encode(bytes)))
        .unwrap_or_default()
}

pub(crate) fn native_icon_data_urls(paths: &[String]) -> HashMap<String, String> {
    if !cfg!(target_os = "macos") || paths.is_empty() {
        return HashMap::new();
    }
    const SCRIPT: &str = "ObjC.import('AppKit'); var args=$.NSProcessInfo.processInfo.arguments; var result=[]; for(var i=6;i<args.count;i++){try{var p=ObjC.unwrap(args.objectAtIndex(i));var image=$.NSWorkspace.sharedWorkspace.iconForFile(p);var bitmap=image?$.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation):null;var data=bitmap?bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG,$.NSDictionary.dictionary):null;result.push(data?ObjC.unwrap(data.base64EncodedStringWithOptions(0)):'');}catch(e){result.push('');}} console.log(JSON.stringify(result));";
    let mut command = Command::new("osascript");
    command.args(["-l", "JavaScript", "-e", SCRIPT, "--"]);
    command.args(paths);
    let Ok(output) = command.output() else {
        return HashMap::new();
    };
    let text = if output.stdout.is_empty() {
        output.stderr
    } else {
        output.stdout
    };
    let icons: Vec<String> = serde_json::from_slice(&text).unwrap_or_default();
    paths
        .iter()
        .cloned()
        .zip(icons.into_iter().map(|icon| optimize_icon_data_url(&icon)))
        .collect()
}

fn optimize_icon_data_url(base64: &str) -> String {
    if base64.is_empty() {
        return String::new();
    }
    let Ok(bytes) = BASE64.decode(base64) else {
        return String::new();
    };
    let Ok(image) = image::load_from_memory(&bytes) else {
        return format!("data:image/png;base64,{base64}");
    };
    let resized = image.thumbnail(64, 64);
    let mut output = Cursor::new(Vec::new());
    if resized.write_to(&mut output, ImageFormat::Png).is_err() {
        return format!("data:image/png;base64,{base64}");
    }
    format!(
        "data:image/png;base64,{}",
        BASE64.encode(output.into_inner())
    )
}

#[tauri::command]
pub fn search_clipboard(
    state: State<'_, AppState>,
    query: String,
    kind: String,
    limit: usize,
    offset: usize,
) -> Result<Vec<Value>, String> {
    let connection = database(&state)?;
    let mut statement = connection
        .prepare(
            "SELECT id, kind, hash, content, file_name, source_name, file_paths, file_types,
                    size, created_at, last_seen_at, copy_count
             FROM clipboard_records
             WHERE (
               ?1 = 'all'
               OR (?1 = 'text' AND kind = 'text')
               OR (?1 = 'image' AND (
                 kind = 'image'
                 OR (kind = 'file' AND json_array_length(COALESCE(file_types, '[]')) > 0
                   AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(file_types, '[]')) WHERE value <> 'image'))
               ))
               OR (?1 = 'file' AND kind = 'file' AND (
                 json_array_length(COALESCE(file_types, '[]')) = 0
                 OR EXISTS (SELECT 1 FROM json_each(COALESCE(file_types, '[]')) WHERE value <> 'image')
               ))
             )
             AND (
               ?2 = '' OR instr(lower(
                 COALESCE(content, '') || ' ' || COALESCE(source_name, '') || ' '
                 || COALESCE(file_paths, '') || ' ' || hash
               ), ?2) > 0
             )
             ORDER BY last_seen_at DESC
             LIMIT ?3 OFFSET ?4",
        )
        .map_err(|error| error.to_string())?;
    let keyword = query.trim().to_lowercase();
    let normalized_kind = match kind.as_str() {
        "text" | "image" | "file" => kind.as_str(),
        _ => "all",
    };
    let page_limit = limit.clamp(1, 100);
    let rows = statement
        .query_map(
            params![normalized_kind, keyword, page_limit as i64, offset as i64],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, i64>(11)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    let mut records = Vec::new();
    for row in rows {
        let (
            id,
            record_kind,
            hash,
            content,
            _file_name,
            source_name,
            file_paths,
            file_types,
            size,
            created_at,
            last_seen_at,
            copy_count,
        ) = row.map_err(|error| error.to_string())?;
        let paths = parse_string_array(file_paths);
        let types = parse_string_array(file_types);
        let file_names: Vec<String> = paths
            .iter()
            .map(|path| {
                Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(path)
                    .to_string()
            })
            .collect();
        let file_type = if !types.is_empty() && types.iter().all(|value| value == &types[0]) {
            types[0].clone()
        } else {
            "file".to_string()
        };
        records.push(json!({
            "id": id,
            "kind": record_kind,
            "hash": hash,
            "content": content.unwrap_or_default(),
            "sourceName": source_name.unwrap_or_default(),
            "filePaths": paths,
            "fileNames": file_names,
            "fileCount": paths.len(),
            "fileTypes": types,
            "fileType": file_type,
            "imageUrl": "",
            "fileIconUrl": "",
            "size": size,
            "createdAt": created_at,
            "lastSeenAt": last_seen_at,
            "copyCount": copy_count,
            "pluginId": "clipboard"
        }));
    }
    Ok(records)
}

#[tauri::command]
pub async fn load_clipboard_assets(
    app: tauri::AppHandle,
    ids: Vec<i64>,
) -> Result<HashMap<String, Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let unique_ids: Vec<i64> = ids
            .into_iter()
            .take(100)
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        if unique_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let connection = database(&state)?;
        let mut records = Vec::new();
        let mut statement = connection
            .prepare("SELECT kind, file_name, file_paths FROM clipboard_records WHERE id = ?")
            .map_err(|error| error.to_string())?;
        for id in unique_ids {
            let record = statement
                .query_row([id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .optional()
                .map_err(|error| error.to_string())?;
            if let Some((kind, file_name, file_paths)) = record {
                let first_path = parse_string_array(file_paths)
                    .into_iter()
                    .next()
                    .unwrap_or_default();
                records.push((id, kind, file_name.unwrap_or_default(), first_path));
            }
        }
        let icon_paths: Vec<String> = records
            .iter()
            .filter(|(_, kind, _, path)| kind == "file" && !path.is_empty())
            .map(|(_, _, _, path)| path.clone())
            .collect();
        let icons = application_icon_data_urls(&state, &icon_paths);
        Ok(records
            .into_iter()
            .map(|(id, kind, file_name, path)| {
                let image_url = if kind == "image" {
                    image_data_url(&connection.storage_dir, &file_name)
                } else {
                    String::new()
                };
                let file_icon_url = icons.get(&path).cloned().unwrap_or_default();
                (
                    id.to_string(),
                    json!({ "imageUrl": image_url, "fileIconUrl": file_icon_url }),
                )
            })
            .collect())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn send_paste() -> Result<(), String> {
    thread::sleep(Duration::from_millis(70));
    let mut enigo = Enigo::new(&Settings::default()).map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;
    enigo
        .key(modifier, Direction::Press)
        .map_err(|error| error.to_string())?;
    let key_result = enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|error| error.to_string());
    let release_result = enigo
        .key(modifier, Direction::Release)
        .map_err(|error| error.to_string());
    key_result?;
    release_result
}

pub fn paste_text(app: &tauri::AppHandle, text: &str) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Ok(json!({ "ok": false, "reason": "内容为空" }));
    }
    let hash = sha256(text.as_bytes());
    app.state::<ClipboardRuntime>()
        .suppress(signature("text", &hash));
    ClipboardContext::new()
        .and_then(|context| context.set_text(text.to_string()))
        .map_err(|error| error.to_string())?;
    hide_main(app);
    let paste = send_paste();
    Ok(match paste {
        Ok(()) => json!({ "ok": true, "pasted": true }),
        Err(reason) => json!({ "ok": true, "pasted": false, "pasteReason": reason }),
    })
}

#[tauri::command]
pub fn activate_clipboard(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<Value, String> {
    let connection = database(&state)?;
    let record = connection
        .query_row(
            "SELECT kind, hash, content, file_name, file_paths FROM clipboard_records WHERE id = ?",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((kind, hash, content, file_name, file_paths)) = record else {
        return Ok(json!({ "ok": false, "reason": "剪贴板记录不存在或已过期" }));
    };
    app.state::<ClipboardRuntime>()
        .suppress(signature(&kind, &hash));
    let context = ClipboardContext::new().map_err(|error| error.to_string())?;
    match kind.as_str() {
        "text" => context.set_text(content.unwrap_or_default()),
        "file" => {
            let files = parse_string_array(file_paths)
                .into_iter()
                .filter(|path| Path::new(path).exists())
                .collect::<Vec<_>>();
            if files.is_empty() {
                return Ok(json!({ "ok": false, "reason": "文件已不存在或无法访问" }));
            }
            context.set_files(files)
        }
        "image" => {
            let file_name = file_name.unwrap_or_default();
            let bytes = fs::read(connection.storage_dir.join("images").join(file_name))
                .map_err(|_| "图片文件不存在或已损坏".to_string())?;
            let image = RustImageData::from_bytes(&bytes).map_err(|error| error.to_string())?;
            context.set_image(image)
        }
        _ => return Ok(json!({ "ok": false, "reason": "未知剪贴板记录类型" })),
    }
    .map_err(|error| error.to_string())?;
    hide_main(&app);
    let paste = send_paste();
    Ok(match paste {
        Ok(()) => json!({ "ok": true, "pasted": true }),
        Err(reason) => json!({ "ok": true, "pasted": false, "pasteReason": reason }),
    })
}

#[tauri::command]
pub fn delete_clipboard(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<Value, String> {
    let connection = database(&state)?;
    let file_name: Option<String> = connection
        .query_row(
            "SELECT file_name FROM clipboard_records WHERE id = ?",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    let removed = connection
        .execute("DELETE FROM clipboard_records WHERE id = ?", [id])
        .map_err(|error| error.to_string())?;
    if removed == 0 {
        return Ok(json!({ "ok": false, "reason": "剪贴板记录不存在或已删除" }));
    }
    if let Some(file_name) = file_name {
        let _ = fs::remove_file(connection.storage_dir.join("images").join(file_name));
    }
    let _ = app.emit("flowhub:clipboard-updated", ());
    Ok(json!({ "ok": true }))
}

pub fn cleanup(state: &AppState, retention_days: i64) -> Result<usize, String> {
    if retention_days <= 0 {
        return Ok(0);
    }
    let cutoff = (Utc::now() - chrono::Duration::days(retention_days)).to_rfc3339();
    let connection = database(state)?;
    let mut statement = connection
        .prepare("SELECT file_name FROM clipboard_records WHERE last_seen_at < ? AND file_name IS NOT NULL")
        .map_err(|error| error.to_string())?;
    let expired: Vec<String> = statement
        .query_map([&cutoff], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect();
    drop(statement);
    let removed = connection
        .execute(
            "DELETE FROM clipboard_records WHERE last_seen_at < ?",
            [&cutoff],
        )
        .map_err(|error| error.to_string())?;
    for file_name in expired {
        let _ = fs::remove_file(connection.storage_dir.join("images").join(file_name));
    }
    Ok(removed)
}

#[cfg(test)]
mod writer_tests {
    use super::*;

    #[test]
    fn finish_waits_for_in_flight_write_and_drains_queued_images_before_migration() {
        let fixture = crate::storage_tests::Fixture::new();
        let state = fixture.state.clone();
        let (sender, receiver) = mpsc::sync_channel::<PendingClipboard>(2);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let first = receiver.recv().unwrap();
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            for job in std::iter::once(first).chain(receiver) {
                if let ClipboardPayload::Image(bytes) = job.payload {
                    add_image(&state, &bytes, &job.hash, &job.captured_at).unwrap();
                }
            }
        });
        let writer = ClipboardWriter {
            sender,
            budget: Arc::new(AtomicUsize::new(0)),
            worker: Arc::new(Mutex::new(Some(worker))),
        };
        for hash in ["one", "two"] {
            writer
                .submit(
                    ClipboardPayload::Image(vec![1, 2, 3]),
                    hash.into(),
                    "now",
                    3,
                    json!({}),
                )
                .unwrap();
        }
        entered_rx.recv().unwrap();
        let budget = writer.budget.clone();
        let (done_tx, done_rx) = mpsc::channel();
        let stopper = thread::spawn(move || {
            done_tx.send(writer.finish()).unwrap();
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release_tx.send(()).unwrap();
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        stopper.join().unwrap();
        assert_eq!(budget.load(Ordering::Acquire), 0);
        let target = fixture.root.join("target");
        crate::switch_storage(&fixture.state, &target).unwrap();
        let connection = database(&fixture.state).unwrap();
        let count: i64 = connection
            .query_row("SELECT count(*) FROM clipboard_records", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
        for hash in ["one", "two"] {
            assert_eq!(
                fs::read(target.join(format!("images/{hash}.png"))).unwrap(),
                vec![1, 2, 3]
            );
        }
    }

    #[test]
    fn blocked_writer_keeps_fifo_and_releases_budget_on_full_and_disconnect() {
        let (sender, receiver) = mpsc::sync_channel(2);
        let writer = ClipboardWriter {
            sender,
            budget: Arc::new(AtomicUsize::new(0)),
            worker: Arc::new(Mutex::new(None)),
        };
        let submit = |id: &str| {
            writer.submit(
                ClipboardPayload::Text(id.into()),
                id.into(),
                "capture-time",
                id.len(),
                json!({}),
            )
        };
        // No consumer runs: submitting must return while persistence is stalled.
        submit("one").unwrap();
        submit("two").unwrap();
        assert!(submit("three").is_err());
        assert_eq!(writer.budget.load(Ordering::Acquire), 6);
        let first = receiver.recv().unwrap();
        assert_eq!(first.hash, "one");
        assert_eq!(first.captured_at, "capture-time");
        assert_eq!(writer.budget.load(Ordering::Acquire), 6); // in-flight is charged
        drop(first);
        submit("four").unwrap();
        assert_eq!(receiver.recv().unwrap().hash, "two");
        assert_eq!(receiver.recv().unwrap().hash, "four");
        assert_eq!(writer.budget.load(Ordering::Acquire), 0);
        drop(receiver);
        assert!(submit("five").is_err());
        assert_eq!(writer.budget.load(Ordering::Acquire), 0);
    }

    #[test]
    fn queue_memory_limit_rejects_overflow_and_recovers_after_release() {
        let budget = Arc::new(AtomicUsize::new(0));
        let full = QueueReservation::reserve(&budget, WRITE_QUEUE_BYTES).unwrap();
        assert!(QueueReservation::reserve(&budget, 1).is_err());
        assert!(QueueReservation::reserve(&budget, usize::MAX).is_err());
        assert_eq!(budget.load(Ordering::Acquire), WRITE_QUEUE_BYTES);
        drop(full);
        let small = QueueReservation::reserve(&budget, 42).unwrap();
        assert_eq!(budget.load(Ordering::Acquire), 42);
        drop(small);
        assert_eq!(budget.load(Ordering::Acquire), 0);
    }
}

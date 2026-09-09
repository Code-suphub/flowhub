use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    process::Command,
};
use tauri::{Manager, State};

use crate::AppState;

fn paths(state: &AppState) -> (std::path::PathBuf, std::path::PathBuf) {
    let dir = state.storage_dir().join("diagnostics");
    (dir.join("diagnostics.jsonl"), dir.join("monitoring.json"))
}

pub(crate) fn enabled(state: &AppState) -> bool {
    let (_, config) = paths(state);
    fs::read_to_string(config)
        .ok()
        .and_then(|v| serde_json::from_str::<Value>(&v).ok())
        .and_then(|v| v.get("enabled").and_then(Value::as_bool))
        .unwrap_or(false)
}

fn append(state: &AppState, record: &Value) -> Result<(), String> {
    if !enabled(state) {
        return Ok(());
    }
    let (log, _) = paths(state);
    if let Some(parent) = log.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{record}").map_err(|error| error.to_string())
}

pub fn record_event(app: &tauri::AppHandle, event: &str, detail: Value) {
    let state = app.state::<AppState>();
    let record = json!({
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "type": "event",
        "event": event,
        "detail": detail
    });
    if let Err(error) = append(&state, &record) {
        eprintln!("[flowhub-tauri] 写入排障日志失败：{error}");
    }
}

fn snapshot() -> Value {
    let output = Command::new("ps")
        .args(["-axo", "pid=,ppid=,%cpu=,%mem=,rss=,etime=,command="])
        .output()
        .ok();
    let processes = output
        .map(|value| {
            String::from_utf8_lossy(&value.stdout)
                .lines()
                .filter(|line| {
                    line.to_lowercase().contains("flowhub")
                        || line.to_lowercase().contains("webkit")
                })
                .map(|line| json!({"raw": line.trim()}))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({"timestamp": chrono::Utc::now().to_rfc3339(), "processes": processes})
}

#[tauri::command]
pub fn get_diagnostics_state(state: State<'_, AppState>) -> Result<Value, String> {
    let (log, _) = paths(&state);
    Ok(json!({"enabled": enabled(&state), "path": log, "available": log.exists()}))
}

#[tauri::command]
pub fn set_diagnostics_enabled(state: State<'_, AppState>, value: bool) -> Result<Value, String> {
    let (log, config) = paths(&state);
    if let Some(parent) = config.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(
        &config,
        serde_json::to_vec_pretty(
            &json!({"enabled": value, "updatedAt": chrono::Utc::now().to_rfc3339()}),
        )
        .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({"ok": true, "enabled": value, "path": log}))
}

#[tauri::command]
pub fn sample_diagnostics(state: State<'_, AppState>) -> Result<Value, String> {
    if !enabled(&state) {
        return Ok(json!({"ok": false, "disabled": true}));
    }
    let record = snapshot();
    append(&state, &record)?;
    Ok(record)
}

#[tauri::command]
pub fn clear_diagnostics(state: State<'_, AppState>) -> Result<Value, String> {
    let (log, _) = paths(&state);
    if log.exists() {
        fs::write(&log, "").map_err(|e| e.to_string())?;
    }
    Ok(json!({"ok": true, "path": log}))
}

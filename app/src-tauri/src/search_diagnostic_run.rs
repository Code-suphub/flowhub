//! Explicit local QA entry. Executes the production search pipeline in its WebKit window.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use serde_json::Value;
static RUNNING: AtomicBool = AtomicBool::new(false);
static PREVIOUS_PIN: AtomicBool = AtomicBool::new(false);

pub fn start(app: &tauri::AppHandle) {
    if RUNNING.swap(true, Ordering::AcqRel) { return; }
    PREVIOUS_PIN.store(crate::LAUNCHER_PINNED.swap(true, Ordering::AcqRel), Ordering::Release);
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        crate::show_macos_window(&window);
        #[cfg(not(target_os = "macos"))]
        let _ = window.show();
        if window.eval(include_str!("../../scripts/search-stress/native-run.js")).is_ok() { return; }
    }
    finish();
}
fn finish() {
    crate::LAUNCHER_PINNED.store(PREVIOUS_PIN.load(Ordering::Acquire), Ordering::Release);
    RUNNING.store(false, Ordering::Release);
}
#[tauri::command]
pub fn save_search_diagnostic_run(app: tauri::AppHandle, report: Value) -> Result<(), String> {
    if !RUNNING.load(Ordering::Acquire) { return Err("No diagnostic run active".into()); }
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?;
        if bytes.len() > 256 * 1024 { return Err("Diagnostic report too large".into()); }
        let path = app.state::<crate::AppState>().storage_dir().join("diagnostics");
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        std::fs::write(path.join("search-native-latest.json"), bytes).map_err(|e| e.to_string())
    })();
    finish();
    result
}

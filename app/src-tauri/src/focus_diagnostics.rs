//! Explicit --focus-diagnostics session. Bounded structural events, never input values.
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::{atomic::{AtomicBool, Ordering}, Mutex}};
use tauri::Manager;
static ENABLED: AtomicBool = AtomicBool::new(false);
static EVENTS: Mutex<VecDeque<Value>> = Mutex::new(VecDeque::new());
pub fn initialize() {
    ENABLED.store(std::env::args().any(|arg| arg == "--focus-diagnostics"), Ordering::Release);
}
fn path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("flowhub-focus-{}.json", std::process::id()))
}
pub fn record(event: &'static str, detail: Value) {
    if !ENABLED.load(Ordering::Acquire) { return; }
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(mut events) = EVENTS.lock() else { return; };
        if events.len() >= 300 { events.pop_front(); }
        events.push_back(json!({"time": chrono::Utc::now().to_rfc3339(), "event":event,"detail":detail}));
        if let Ok(bytes) = serde_json::to_vec_pretty(&*events) { let _ = std::fs::write(path(), bytes); }
    });
}
#[tauri::command]
pub fn focus_diagnostics_enabled() -> bool { ENABLED.load(Ordering::Acquire) }
#[derive(serde::Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Sample {
    event: String, target: String, active: String, scope: String,
    focused: bool, sequence: u64, elapsed: f64,
    #[serde(default)]
    metrics: std::collections::HashMap<String, f64>,
}
fn known<'a>(value: &'a str, allowed: &[&str]) -> &'a str {
    if allowed.contains(&value) { value } else { "other" }
}
#[tauri::command]
pub fn record_focus_sample(app: tauri::AppHandle, sample: Sample) {
    if !ENABLED.load(Ordering::Acquire) { return; }
    let window = app.get_webview_window("main");
    let metrics: serde_json::Map<String, Value> = sample.metrics.iter()
        .filter(|(key, value)| value.is_finite() && **value >= 0.0 && ["eventDelayMs", "renderMs", "matchesMs", "markupMs", "domMs", "layoutMs", "frameWaitMs", "queryMs"].contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), json!(value))).collect();
    record("web-input", json!({
        "event":known(&sample.event,&["ready","mousedown","mouseup","click","focusin","focusout","focus","blur","after-click","after-press","error"]),
        "target":known(&sample.target,&["q","scope:all","scope:clipboard","scope:app","scope:web","scope:memo","scope:tools","kind","window","body"]),
        "active":known(&sample.active,&["q","scope:all","scope:clipboard","scope:app","scope:web","scope:memo","scope:tools","kind","body"]),
        "scope":known(&sample.scope,&["all","clipboard","app","web","memo","tools"]),
        "metrics":metrics, "documentFocused":sample.focused,"sequence":sample.sequence,"elapsed":sample.elapsed,
        "nativeFocused":window.as_ref().and_then(|w|w.is_focused().ok()),
        "nativeVisible":window.as_ref().and_then(|w|w.is_visible().ok())
    }));
}

// Observe AppKit delivery without swallowing, modifying or generating events.
#[cfg(target_os = "macos")]
pub fn install_native_monitor() {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventType};
    use objc2_foundation::NSProcessInfo;
    use std::ptr::NonNull;
    thread_local! {
        static MONITOR: std::cell::RefCell<Option<objc2::rc::Retained<objc2::runtime::AnyObject>>> = const { std::cell::RefCell::new(None) };
    }
    if !ENABLED.load(Ordering::Acquire) { return; }
    MONITOR.with(|stored| {
        if stored.borrow().is_some() { return; }
        let callback = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
            let value = unsafe { event.as_ref() };
            let received = chrono::Utc::now().to_rfc3339();
            let delay = (NSProcessInfo::processInfo().systemUptime() - value.timestamp()) * 1000.0;
            record("appkit-mouse", json!({
                "kind": if value.r#type() == NSEventType::LeftMouseDown {"down"} else {"up"},
                "receivedAt":received,"deliveryMs":delay.max(0.0),
                "keyWindow":objc2::MainThreadMarker::new().and_then(|mtm|value.window(mtm)).map(|window|window.isKeyWindow())
            }));
            event.as_ptr()
        });
        *stored.borrow_mut() = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::LeftMouseDown | NSEventMask::LeftMouseUp, &callback
        ) };
    });
}

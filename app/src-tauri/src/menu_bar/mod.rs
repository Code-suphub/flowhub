//! Menu bar lifecycle, organizer state and native command dispatch.
//! Storage handles persisted settings; config_save owns recovery readiness.
use crate::storage::{ensure_object_path, hydrated_config};
use crate::{diagnostics, open_settings, toggle_main, AppState};
#[cfg(target_os = "macos")]
use crate::{macos_accessibility, macos_item_submenu, menu_bar_icon, menu_bar_section_memory};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSAutoresizingMaskOptions, NSTextAlignment, NSVariableStatusItemLength,
    NSUserInterfaceItemIdentification};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSString, NSUserDefaults};
use serde_json::{json, Value};
use std::{
    sync::atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering},
    time::Duration,
};
#[cfg(target_os = "macos")]
use tauri::{
    menu::{MenuBuilder, MenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
#[cfg(target_os = "macos")]
const FLOWHUB_TRAY_ID: &str = "flowhub-menu-bar";
#[cfg(target_os = "macos")]
const FLOWHUB_TRAY_AUTOSAVE: &str = "FlowHub.MenuBar.V1.Main";
#[cfg(target_os = "macos")]
const FLOWHUB_ORGANIZER_MENU_ID: &str = "flowhub-organizer";
#[cfg(target_os = "macos")]
const FLOWHUB_ORGANIZER_TOGGLE_MENU_ID: &str = "flowhub-organizer-toggle";
#[cfg(target_os = "macos")]
const FLOWHUB_ORGANIZER_ITEMS_MENU_ID: &str = "flowhub-organizer-items";
#[cfg(target_os = "macos")]
const FLOWHUB_ORGANIZER_ITEM_PREFIX: &str = "flowhub-organizer-item:";
#[cfg(target_os = "macos")]
const ORGANIZER_CONTROL_ID: &str = "flowhub-organizer-control";
#[cfg(target_os = "macos")]
const ORGANIZER_GLYPH_ID: &str = "flowhub-organizer-glyph";
#[cfg(target_os = "macos")]
const ORGANIZER_COLLAPSE_AUTOSAVE: &str = "FlowHub.Organizer.V19.CollapseBoundary";
#[cfg(target_os = "macos")]
static ORGANIZER_COLLAPSE_PTR: AtomicUsize = AtomicUsize::new(0);
#[cfg(target_os = "macos")]
const ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_ID: &str = "flowhub-organizer-always-hidden-boundary";
#[cfg(target_os = "macos")]
const ORGANIZER_CONTROL_AUTOSAVE: &str = "FlowHub.Organizer.V17.Control";
#[cfg(target_os = "macos")]
const ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_AUTOSAVE: &str =
    "FlowHub.Organizer.V18.AlwaysHiddenBoundary";
#[cfg(target_os = "macos")]
static ORGANIZER_CONTROL_PTR: AtomicUsize = AtomicUsize::new(0);
#[cfg(target_os = "macos")]
static ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_PTR: AtomicUsize = AtomicUsize::new(0);
#[cfg(target_os = "macos")]
static ORGANIZER_ENABLED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static ORGANIZER_COLLAPSED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static ORGANIZER_ITEM_MOVE_ACTIVE: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
struct OrganizerItemMoveGuard;

#[cfg(target_os = "macos")]
impl Drop for OrganizerItemMoveGuard {
    fn drop(&mut self) {
        ORGANIZER_ITEM_MOVE_ACTIVE.store(false, AtomicOrdering::Release);
    }
}

pub(crate) fn config_flag(config: &Value, pointer: &str, default: bool) -> bool {
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
fn seed_organizer_position(name: &str, position: f64) {
    let defaults = NSUserDefaults::standardUserDefaults();
    let key = NSString::from_str(&format!("NSStatusItem Preferred Position {name}"));
    if defaults.objectForKey(&key).is_none() {
        defaults.setDouble_forKey(position, &key);
    }
}

#[cfg(target_os = "macos")]
fn organizer_position(name: &str) -> Option<f64> {
    let defaults = NSUserDefaults::standardUserDefaults();
    let key = NSString::from_str(&format!("NSStatusItem Preferred Position {name}"));
    defaults
        .objectForKey(&key)
        .map(|_| defaults.doubleForKey(&key))
}

#[cfg(target_os = "macos")]
fn set_organizer_position(name: &str, position: f64) {
    let defaults = NSUserDefaults::standardUserDefaults();
    let key = NSString::from_str(&format!("NSStatusItem Preferred Position {name}"));
    defaults.setDouble_forKey(position, &key);
}

#[cfg(target_os = "macos")]
fn organizer_item_snapshot(item: Option<&tray_icon::TrayIcon>) -> Value {
    let mut detail = json!({ "available": item.is_some() });
    if let Some(item) = item {
        if let Some(status_item) = item.ns_status_item() {
            detail["visible"] = json!(status_item.isVisible());
            detail["length"] = json!(status_item.length());
            if let Some(main_thread) = objc2::MainThreadMarker::new() {
                if let Some(button) = status_item.button(main_thread) {
                    let button_frame = button.frame();
                    detail["hidden"] = json!(button.isHidden());
                    detail["enabled"] = json!(button.isEnabled());
                    detail["alignment"] = json!(button.alignment().0);
                    detail["title"] = json!(button.title().to_string());
                    detail["buttonFrame"] = json!({
                        "x": button_frame.origin.x,
                        "y": button_frame.origin.y,
                        "width": button_frame.size.width,
                        "height": button_frame.size.height
                    });
                    let subviews = button.subviews();
                    detail["glyph"] = organizer_glyph_snapshot(&button);
                    if let Some(target) = subviews.iter().find(|view| view.identifier().is_none()) {
                        let event_target_frame = target.frame();
                        detail["eventTargetFrame"] = json!({
                            "x": event_target_frame.origin.x,
                            "y": event_target_frame.origin.y,
                            "width": event_target_frame.size.width,
                            "height": event_target_frame.size.height
                        });
                    }
                    if let Some(window) = button.window() {
                        let frame = window.frame();
                        if let Some(screen) = window.screen() {
                            let screen_frame = screen.frame();
                            detail["screen"] = json!({
                                "x": screen_frame.origin.x, "y": screen_frame.origin.y,
                                "width": screen_frame.size.width, "height": screen_frame.size.height,
                                "scale": screen.backingScaleFactor()
                            });
                        }
                        detail["windowId"] = json!(window.windowNumber());
                        detail["windowIgnoresMouseEvents"] = json!(window.ignoresMouseEvents());
                        detail["windowRight"] = json!(frame.origin.x + frame.size.width);
                        detail["windowFrame"] = json!({
                            "x": frame.origin.x,
                            "y": frame.origin.y,
                            "width": frame.size.width,
                            "height": frame.size.height
                        });
                    }
                }
            }
        }
    }
    detail
}

#[cfg(target_os = "macos")]
fn rect_json(rect: objc2_foundation::NSRect) -> Value {
    json!({"x":rect.origin.x,"y":rect.origin.y,"width":rect.size.width,"height":rect.size.height})
}

#[cfg(target_os = "macos")]
fn organizer_glyph_snapshot(button: &objc2_app_kit::NSStatusBarButton) -> Value {
    let views = button.subviews();
    let glyph: &objc2_app_kit::NSView = button;
    let title = button.title().to_string();
    let bounds = button.cell().map(|cell| cell.titleRectForBounds(button.bounds())).unwrap_or(button.bounds());
    let visible = glyph.visibleRect();
    let mut result = json!({
        "present":!title.is_empty(),"nativeTitle":title,"renderKind":"native-status-button-title",
        "frame":rect_json(bounds),"bounds":rect_json(bounds),
        "visibleRect":rect_json(visible),"hidden":glyph.isHidden(),
        "hiddenBySelfOrAncestor":glyph.isHiddenOrHasHiddenAncestor(),"alpha":glyph.alphaValue(),
        "clipped": visible.size.width + 0.5 < bounds.size.width || visible.size.height + 0.5 < bounds.size.height,
        "screenVisibilityConfirmed":false,
        "evidence":"view-geometry-only; window visibility does not prove screen pixels"
    });
    if let Some(window) = glyph.window() {
        let screen_rect = window.convertRectToScreen(glyph.convertRect_toView(bounds, None));
        result["screenRect"] = rect_json(screen_rect);
        result["windowId"] = json!(window.windowNumber());
        result["windowVisible"] = json!(window.isVisible());
        result["windowOcclusionState"] = json!(window.occlusionState().bits());
        result["windowAlpha"] = json!(window.alphaValue());
        let point = objc2_foundation::NSPoint::new(bounds.origin.x + bounds.size.width / 2.0, bounds.origin.y + bounds.size.height / 2.0);
        let in_button = glyph.convertPoint_toView(point, Some(button));
        // NSView hitTest takes coordinates in its superview.
        let in_parent = button.convertPoint_toView(in_button, unsafe { button.superview() }.as_deref());
        result["hitMouseResponder"] = json!(button.hitTest(in_parent).is_some_and(|hit|
            views.iter().any(|v| v.identifier().is_none() && std::ptr::eq(&*hit, &*v))));
        if let Some(screen) = window.screen() {
            let frame = screen.frame();
            let width = (screen_rect.origin.x + screen_rect.size.width).min(frame.origin.x + frame.size.width)
                - screen_rect.origin.x.max(frame.origin.x);
            let height = (screen_rect.origin.y + screen_rect.size.height).min(frame.origin.y + frame.size.height)
                - screen_rect.origin.y.max(frame.origin.y);
            result["screenFrame"] = rect_json(frame);
            result["screenScale"] = json!(screen.backingScaleFactor());
            result["intersectsAssignedScreen"] = json!(width > 0.0 && height > 0.0);
            result["fullyInsideAssignedScreen"] = json!(width + 0.5 >= screen_rect.size.width && height + 0.5 >= screen_rect.size.height);
        }
    }
    result
}

#[cfg(target_os = "macos")]
fn record_glyph_render(app: &tauri::AppHandle, phase: &str) {
    let result = (|| -> Result<(Value, Vec<u8>), String> {
        let mtm = objc2::MainThreadMarker::new().ok_or("需要主线程")?;
        let tray = unsafe { organizer_tray(&ORGANIZER_CONTROL_PTR) }.ok_or("箭头状态项不存在")?;
        let button = tray.ns_status_item().and_then(|item| item.button(mtm)).ok_or("箭头按钮不存在")?;
        let geometry = organizer_glyph_snapshot(&button);
        let glyph = &*button;
        // Bound both work and capture scope to this tiny label; never capture
        // the oversized status item, desktop, other icons or clipboard content.
        let bounds = glyph.bounds();
        if bounds.size.width <= 0.0 || bounds.size.height <= 0.0
            || bounds.size.width > 64.0 || bounds.size.height > 64.0 { return Err("箭头绘制范围异常".into()); }
        let bitmap = glyph.bitmapImageRepForCachingDisplayInRect(bounds).ok_or("无法创建绘制快照")?;
        glyph.cacheDisplayInRect_toBitmapImageRep(bounds, &bitmap);
        let png = unsafe { bitmap.representationUsingType_properties(
            objc2_app_kit::NSBitmapImageFileType::PNG, &objc2_foundation::NSDictionary::new(),
        ) }.ok_or("无法编码绘制快照")?;
        Ok((geometry, png.to_vec()))
    })();
    let timestamp = chrono::Utc::now().to_rfc3339();
    let mut detail = json!({"phase":phase,"capturedAt":timestamp,"pid":std::process::id(),
        "version":app.package_info().version.to_string(),"collapsed":organizer_collapsed(),
        "captureKind":"offscreen-AppKit-arrow-button-render","screenVisibilityConfirmed":false});
    let (geometry, bytes) = match result {
        Ok(value) => value,
        Err(error) => {
            detail["error"] = json!(error);
            diagnostics::record_event(app, "menu_bar_organizer_glyph_render", detail);
            return;
        }
    };
    detail["geometry"] = geometry;
    let directory = app.state::<AppState>().storage_dir().join("diagnostics/glyph-snapshots");
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Fixed-size ring and matching metadata; older log paths may have been
        // overwritten, so compare capturedAt with the sidecar before using one.
        static WRITER: std::sync::Mutex<usize> = std::sync::Mutex::new(0);
        let mut sequence = WRITER.lock().unwrap();
        let slot = *sequence % 16;
        *sequence += 1;
        let path = directory.join(format!("glyph-{slot}.png"));
        let saved = (|| -> Result<(), String> {
            let image = image::load_from_memory(&bytes).map_err(|e| e.to_string())?.to_rgba8();
            let pixels = image.pixels().filter(|pixel| pixel.0[3] > 0).count();
            detail["nonTransparentPixels"] = json!(pixels);
            detail["renderHasNonTransparentPixels"] = json!(pixels > 0);
            detail["pixelWidth"] = json!(image.width());
            detail["pixelHeight"] = json!(image.height());
            std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
            detail["snapshotPath"] = json!(path);
            std::fs::write(path.with_extension("json"), serde_json::to_vec_pretty(&detail).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            Ok(())
        })();
        if let Err(error) = saved { detail["snapshotError"] = json!(error); }
        diagnostics::record_event(&handle, "menu_bar_organizer_glyph_render", detail);
    });
}

#[cfg(target_os = "macos")]
fn organizer_window_id(pointer: &AtomicUsize) -> Option<u32> {
    let tray = unsafe { organizer_tray(pointer) }?;
    let status_item = tray.ns_status_item()?;
    let main_thread = objc2::MainThreadMarker::new()?;
    let button = status_item.button(main_thread)?;
    let window = button.window()?;
    u32::try_from(window.windowNumber()).ok()
}

#[cfg(target_os = "macos")]
pub(crate) fn organizer_window_ids() -> Result<(u32, u32, u32), String> {
    let control = organizer_window_id(&ORGANIZER_CONTROL_PTR)
        .ok_or_else(|| "菜单栏控制箭头尚未就绪".to_string())?;
    // Expanded: the arrow is the boundary, with no adjacent invisible item.
    // Collapsed: a separate temporary spacer keeps the arrow's view small.
    let boundary = organizer_window_id(&ORGANIZER_COLLAPSE_PTR).unwrap_or(control);
    let always_hidden_boundary = organizer_window_id(&ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_PTR)
        .ok_or_else(|| "始终隐藏分界尚未就绪".to_string())?;
    Ok((control, boundary, always_hidden_boundary))
}

#[cfg(target_os = "macos")]
fn record_organizer_state(app: &tauri::AppHandle, phase: &str) {
    if !diagnostics::enabled(&app.state::<AppState>()) { return; }
    let control = organizer_item_snapshot(unsafe { organizer_tray(&ORGANIZER_CONTROL_PTR) });
    let boundary = if ORGANIZER_COLLAPSE_PTR.load(AtomicOrdering::Acquire) == 0 {
        control.clone()
    } else { organizer_item_snapshot(unsafe { organizer_tray(&ORGANIZER_COLLAPSE_PTR) }) };
    let always_hidden_boundary =
        organizer_item_snapshot(unsafe { organizer_tray(&ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_PTR) });
    let detail = json!({
        "phase": phase,
        "pid": std::process::id(),
        "version": app.package_info().version.to_string(),
        "enabled": ORGANIZER_ENABLED.load(AtomicOrdering::Acquire),
        "collapsed": ORGANIZER_COLLAPSED.load(AtomicOrdering::Acquire),
        "controlSymbol": if ORGANIZER_COLLAPSED.load(AtomicOrdering::Acquire) { "‹" } else { "›" },
        "mainThread": objc2::MainThreadMarker::new().is_some(),
        "layoutMode": "fixed-arrow-collapse-only-spacer",
        "control": control,
        "boundary": boundary,
        "alwaysHiddenBoundary": always_hidden_boundary
    });
    diagnostics::record_event(app, "menu_bar_organizer", detail);
    if phase.ends_with(":after_800ms") || phase.ends_with(":after_3000ms") {
        record_glyph_render(app, phase);
    }
    if phase.ends_with(":after_800ms") {
        let inventory = organizer_window_ids().and_then(|ids| {
            let items = macos_accessibility::menu_bar_items()?;
            Ok(json!({
                "phase": phase,
                "count": items.len(),
                "currentRowCount": macos_accessibility::items_in_menu_bar_row(&items, ids.1).map(|row| row.len()).ok(),
                "controlWindowId": ids.0,
                "boundaryWindowId": ids.1,
                "alwaysHiddenBoundaryWindowId": ids.2,
                "controlFound": items.iter().any(|item| item.window_id == ids.0),
                "boundaryFound": items.iter().any(|item| item.window_id == ids.1),
                "alwaysHiddenBoundaryFound": items.iter().any(|item| item.window_id == ids.2),
            }))
        });
        diagnostics::record_event(
            app,
            "menu_bar_item_inventory_probe",
            inventory.unwrap_or_else(|error| json!({ "phase": phase, "error": error })),
        );
    }
}

#[cfg(target_os = "macos")]
fn schedule_organizer_observation(app: &tauri::AppHandle, phase: &str) {
    if !diagnostics::enabled(&app.state::<AppState>()) { return; }
    record_organizer_state(app, &format!("{phase}:immediate"));
    for delay_ms in [150_u64, 800_u64, 3000_u64] {
        let handle = app.clone();
        let phase = format!("{phase}:after_{delay_ms}ms");
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay_ms));
            let callback_handle = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                record_organizer_state(&callback_handle, &phase);
            });
        });
    }
}

#[cfg(target_os = "macos")]
fn configure_organizer_items(
    app: &tauri::AppHandle,
    enabled: bool,
    collapsed: bool,
) -> Result<(), String> {
    if ORGANIZER_ITEM_MOVE_ACTIVE.load(AtomicOrdering::Acquire) {
        return Err("正在移动菜单栏图标，请稍后切换".into());
    }
    // Drop the temporary spacer before expanding. There is no one-point
    // divider at all while users arrange the visible icons.
    if !enabled || !collapsed {
        let pointer = ORGANIZER_COLLAPSE_PTR.swap(0, AtomicOrdering::AcqRel);
        if pointer != 0 { unsafe { drop(Box::from_raw(pointer as *mut tray_icon::TrayIcon)); } }
    }
    // Keep the old arrow's autosave identity, preserving its position.
    // No separate ordinary divider remains for icons to get trapped behind.
    if ORGANIZER_CONTROL_PTR.load(AtomicOrdering::Acquire) == 0 {
        seed_organizer_position(ORGANIZER_CONTROL_AUTOSAVE, 1.0);
        let control = tray_icon::TrayIconBuilder::new()
            .with_id(ORGANIZER_CONTROL_ID).with_title("›")
            .with_tooltip("展开或收起菜单栏隐藏区")
            .build().map_err(|error| error.to_string())?;
        set_organizer_autosave_name(&control, ORGANIZER_CONTROL_AUTOSAVE);
        ORGANIZER_CONTROL_PTR.store(Box::into_raw(Box::new(control)) as usize, AtomicOrdering::Release);
    }
    if ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_PTR.load(AtomicOrdering::Acquire) == 0 {
        seed_organizer_position(ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_AUTOSAVE, 10_000.0);
        let boundary = tray_icon::TrayIconBuilder::new()
            .with_id(ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_ID).with_title("")
            .build().map_err(|error| error.to_string())?;
        set_organizer_autosave_name(&boundary, ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_AUTOSAVE);
        ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_PTR.store(Box::into_raw(Box::new(boundary)) as usize, AtomicOrdering::Release);
    }
    let control = unsafe { organizer_tray(&ORGANIZER_CONTROL_PTR) }.unwrap();
    let always = unsafe { organizer_tray(&ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_PTR) }.unwrap();
    control.set_visible(enabled).map_err(|error| error.to_string())?;
    always.set_visible(enabled).map_err(|error| error.to_string())?;
    if enabled {
        set_organizer_autosave_name(control, ORGANIZER_CONTROL_AUTOSAVE);
        set_organizer_autosave_name(always, ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_AUTOSAVE);
        let mtm = objc2::MainThreadMarker::new().ok_or("菜单栏布局需要主线程")?;
        let item = control.ns_status_item().ok_or("菜单栏箭头尚未就绪")?;
        let button = item.button(mtm).ok_or("菜单栏按钮尚未就绪")?;
        // Use ordinary native title rendering on a permanently small button.
        // The temporary spacer is the only item that changes to a huge width.
        for view in button.subviews().iter() {
            if view.identifier().is_some_and(|id| id.to_string() == ORGANIZER_GLYPH_ID) {
                view.removeFromSuperview();
            } else {
                view.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable
                    | NSAutoresizingMaskOptions::ViewHeightSizable);
            }
        }
        button.setAlignment(NSTextAlignment::Center);
        item.setLength(NSVariableStatusItemLength);
        control.set_title(Some(if collapsed { "‹" } else { "›" }));
        if let Some(item) = always.ns_status_item() { item.setLength(10_000.0); }
        if collapsed && ORGANIZER_COLLAPSE_PTR.load(AtomicOrdering::Acquire) == 0 {
            let position = organizer_position(ORGANIZER_CONTROL_AUTOSAVE).unwrap_or(1.0);
            set_organizer_position(ORGANIZER_COLLAPSE_AUTOSAVE, position + 1.0);
            let spacer = tray_icon::TrayIconBuilder::new()
                .with_id("flowhub-collapse-spacer").with_title("")
                .build().map_err(|error| error.to_string())?;
            set_organizer_autosave_name(&spacer, ORGANIZER_COLLAPSE_AUTOSAVE);
            if let Some(item) = spacer.ns_status_item() { item.setLength(10_000.0); }
            ORGANIZER_COLLAPSE_PTR.store(Box::into_raw(Box::new(spacer)) as usize, AtomicOrdering::Release);
        }
    }
    ORGANIZER_ENABLED.store(enabled, AtomicOrdering::Release);
    ORGANIZER_COLLAPSED.store(collapsed, AtomicOrdering::Release);
    schedule_organizer_observation(app, if collapsed { "collapse" } else { "expand" });
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn apply_menu_bar_organizer(app: &tauri::AppHandle, config: &Value) -> Value {
    let enabled = config_flag(config, "/core/menuBar/organizerEnabled", false);
    let collapsed = enabled && config_flag(config, "/core/menuBar/collapseOnLaunch", false);
    let handle = app.clone();
    let callback_handle = handle.clone();
    let _ = handle.run_on_main_thread(move || {
        if let Err(error) = configure_organizer_items(&callback_handle, enabled, collapsed) {
            eprintln!("[flowhub-tauri] 菜单栏整理器配置失败：{error}");
        } else {
            schedule_flowhub_menu_refresh(&callback_handle);
        }
    });
    json!({ "enabled": enabled, "collapsed": collapsed })
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn apply_menu_bar_organizer(_app: &tauri::AppHandle, _config: &Value) -> Value {
    json!({ "enabled": false, "collapsed": false, "unsupported": true })
}

#[cfg(target_os = "macos")]
fn toggle_menu_bar_organizer(app: &tauri::AppHandle) -> Result<bool, String> {
    if !ORGANIZER_ENABLED.load(AtomicOrdering::Acquire) {
        return Err("请先在设置中启用菜单栏整理".to_string());
    }
    let collapsed = !ORGANIZER_COLLAPSED.load(AtomicOrdering::Acquire);
    configure_organizer_items(app, true, collapsed)?;
    Ok(collapsed)
}

#[cfg(target_os = "macos")]
fn enable_menu_bar_organizer(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let config = persist_organizer_enabled(&state)?;
    apply_menu_bar_organizer(app, &config);
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn persist_organizer_enabled(state: &AppState) -> Result<Value, String> {
    crate::storage::update_settings(state, |config| {
        ensure_object_path(config, &["core", "menuBar"])?
            .insert("organizerEnabled".to_string(), Value::Bool(true));
        Ok(())
    })
}

#[tauri::command]
pub(crate) async fn toggle_menu_bar_items(app: tauri::AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let _ = sender.send(toggle_menu_bar_organizer(&handle));
        })
        .map_err(|error| error.to_string())?;
        let collapsed = receiver.await.map_err(|error| error.to_string())??;
        return Ok(json!({ "ok": true, "collapsed": collapsed }));
    }
    #[cfg(not(target_os = "macos"))]
    Ok(json!({ "ok": false, "reason": "菜单栏整理仅支持 macOS" }))
}

#[cfg(target_os = "macos")]
pub(crate) fn managed_menu_bar_items(
    boundary_id: u32,
    always_boundary_id: u32,
) -> Result<Vec<(macos_accessibility::MenuBarItem, &'static str)>, String> {
    let all_items = macos_accessibility::menu_bar_items()?;
    let all_items = macos_accessibility::items_in_menu_bar_row(&all_items, boundary_id)?;
    let boundary = all_items.iter().find(|item| item.window_id == boundary_id);
    let always_boundary = all_items
        .iter()
        .find(|item| item.window_id == always_boundary_id);
    let current_pid = std::process::id() as i32;
    Ok(all_items
        .iter()
        .filter(|item| {
            item.owner_pid != current_pid
                && item.owner_name != "Window Server"
                && item.title != "Menubar"
        })
        .map(|item| {
            let item_max_x = item.x + item.width;
            let section = if always_boundary.is_some_and(|divider| item_max_x <= divider.x + 1.0) {
                "alwaysHidden"
            } else if boundary.is_some_and(|divider| item_max_x <= divider.x + 1.0) {
                "hidden"
            } else {
                "visible"
            };
            (item.clone(), section)
        })
        .collect())
}

#[cfg(target_os = "macos")]
pub(crate) fn menu_bar_item_display_name(item: &macos_accessibility::MenuBarItem) -> String {
    match item.title.as_str() {
        "Clock" => "时钟".to_string(),
        "BentoBox" => "控制中心".to_string(),
        "WiFi" => "无线局域网".to_string(),
        "Bluetooth" => "蓝牙".to_string(),
        "Battery" => "电池".to_string(),
        "FocusModes" => "专注模式".to_string(),
        "Sound" => "声音".to_string(),
        title if !title.is_empty() => title.to_string(),
        _ if !item.accessibility_label.is_empty() => item.accessibility_label.clone(),
        _ if !item.owner_name.is_empty() => item.owner_name.clone(),
        _ => "未命名图标".to_string(),
    }
}

#[tauri::command]
pub(crate) async fn list_menu_bar_items(app: tauri::AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        if !ORGANIZER_ENABLED.load(AtomicOrdering::Acquire) {
            return Ok(json!({
                "ok": true,
                "trusted": macos_accessibility::is_trusted(),
                "organizerEnabled": false,
                "items": []
            }));
        }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(organizer_window_ids());
        })
        .map_err(|error| error.to_string())?;
        let (control_id, boundary_id, always_boundary_id) =
            receiver.await.map_err(|error| error.to_string())??;
        let items = managed_menu_bar_items(boundary_id, always_boundary_id)?
            .into_iter()
            // Omit only these fixed entries from management UI, not from the
            // underlying inventory used for geometry and diagnostics.
            .filter(|(item, _)| {
                !macos_accessibility::is_fixed_menu_bar_entry(
                    &item.owner_name,
                    &item.title,
                    &item.accessibility_id,
                )
            })
            .map(|(item, section)| {
                let display_name = menu_bar_item_display_name(&item);
                let mut value = serde_json::to_value(item).unwrap_or_else(|_| json!({}));
                value["section"] = json!(section);
                value["displayName"] = json!(display_name);
                value
            })
            .collect::<Vec<_>>();
        diagnostics::record_event(
            &app,
            "menu_bar_item_inventory",
            json!({
                "count": items.len(),
                "controlWindowId": control_id,
                "boundaryWindowId": boundary_id,
                "alwaysHiddenBoundaryWindowId": always_boundary_id,
                "alwaysHiddenCount": items.iter().filter(|item| item.get("section") == Some(&json!("alwaysHidden"))).count(),
            }),
        );
        return Ok(json!({
            "ok": true,
            "trusted": macos_accessibility::is_trusted(),
            "organizerEnabled": true,
            "items": items
        }));
    }
    #[cfg(not(target_os = "macos"))]
    Ok(
        json!({ "ok": false, "trusted": false, "organizerEnabled": false, "items": [], "reason": "逐项控制仅支持 macOS" }),
    )
}

#[tauri::command]
pub(crate) async fn set_menu_bar_item_hidden(
    app: tauri::AppHandle,
    window_id: u32,
    hidden: bool,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        if !ORGANIZER_ENABLED.load(AtomicOrdering::Acquire) {
            return Ok(json!({ "ok": false, "reason": "请先启用菜单栏隐藏分区" }));
        }
        if !macos_accessibility::is_trusted() {
            return Ok(json!({ "ok": false, "reason": "请先授予 FlowHub 辅助功能权限" }));
        }
        if ORGANIZER_ITEM_MOVE_ACTIVE.swap(true, AtomicOrdering::AcqRel) {
            return Ok(json!({ "ok": false, "reason": "另一个菜单栏图标正在移动，请稍后重试" }));
        }
        let _move_guard = OrganizerItemMoveGuard;

        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(organizer_window_ids());
        })
        .map_err(|error| error.to_string())?;
        let (control_id, boundary_id, always_boundary_id) =
            receiver.await.map_err(|error| error.to_string())??;
        let memory_path = app
            .state::<AppState>()
            .root_dir
            .join("menu-bar-sections.json");
        let handle = app.clone();
        let move_result = tauri::async_runtime::spawn_blocking(move || {
            use menu_bar_section_memory::{Identity, Memory, Section};
            // Require both dividers to exist before trusting section geometry.
            let inventory = macos_accessibility::menu_bar_items()?;
            let inventory = macos_accessibility::items_in_menu_bar_row(&inventory, boundary_id)?;
            if ![control_id, boundary_id, always_boundary_id]
                .iter()
                .all(|id| inventory.iter().any(|item| item.window_id == *id))
            {
                return Err("菜单栏分界尚未就绪".to_string());
            }
            let boundary = inventory
                .iter()
                .find(|item| item.window_id == boundary_id)
                .unwrap();
            let always_boundary = inventory
                .iter()
                .find(|item| item.window_id == always_boundary_id)
                .unwrap();
            let item = inventory
                .iter()
                .find(|item| item.window_id == window_id)
                .ok_or_else(|| "菜单栏图标已不存在".to_string())?;
            let section = if item.x + item.width <= always_boundary.x + 1.0 {
                Section::AlwaysHidden
            } else if item.x + item.width <= boundary.x + 1.0 {
                Section::Hidden
            } else {
                Section::Visible
            };
            // The main FlowHub icon is not movable through this UI, but it must
            // participate in ordering so restores cannot cross it on the next cycle.
            let own_anchors: Vec<_> = inventory
                .iter()
                .filter(|item| {
                    item.owner_pid == std::process::id() as i32
                        && ![control_id, boundary_id, always_boundary_id].contains(&item.window_id)
                })
                .map(|item| item.window_id)
                .collect();
            let main_anchor = (own_anchors.len() == 1).then(|| own_anchors[0]);
            let identities: Vec<_> = inventory
                .iter()
                .map(|item| Identity {
                    owner: item.owner_name.clone(),
                    title: if Some(item.window_id) == main_anchor {
                        "flowhub-main-anchor".into()
                    } else {
                        item.title.clone()
                    },
                    accessibility_id: item.accessibility_id.clone(),
                    stable_id: if Some(item.window_id) == main_anchor {
                        "flowhub-main-anchor".into()
                    } else {
                        item.stable_id.clone()
                    },
                })
                .collect();
            let index = inventory
                .iter()
                .position(|item| item.window_id == window_id)
                .unwrap();
            let mut memory = Memory::load(&memory_path).map_err(|error| {
                diagnostics::record_event(
                    &handle,
                    "menu_bar_section_memory_error",
                    json!({"error": error}),
                );
                error
            })?;
            let plan = memory.prepare(&identities, index, section, hidden);
            let section_of = |item: &macos_accessibility::MenuBarItem| {
                if item.x + item.width <= always_boundary.x + 1.0 {
                    Section::AlwaysHidden
                } else if item.x + item.width <= boundary.x + 1.0 {
                    Section::Hidden
                } else {
                    Section::Visible
                }
            };
            let manageable = |item: &macos_accessibility::MenuBarItem| {
                item.owner_pid != std::process::id() as i32
                    && item.owner_name != "Window Server"
                    && item.title != "Menubar"
                    && item.movable
                    && item.hideable
            };
            let usable_anchor = |item: &macos_accessibility::MenuBarItem| {
                manageable(item) || Some(item.window_id) == main_anchor
            };
            if hidden && section != Section::AlwaysHidden {
                let mut ordered: Vec<_> = inventory
                    .iter()
                    .enumerate()
                    .filter(|(_, i)| usable_anchor(i) && section_of(i) == section)
                    .collect();
                ordered.sort_by(|a, b| a.1.x.total_cmp(&b.1.x));
                memory.remember_order(
                    &identities[index],
                    section,
                    &ordered
                        .iter()
                        .map(|(i, _)| &identities[*i])
                        .collect::<Vec<_>>(),
                );
            }
            let anchor = if !hidden && section == Section::AlwaysHidden {
                let candidates: Vec<_> = inventory
                    .iter()
                    .enumerate()
                    .filter(|(_, i)| usable_anchor(i))
                    .collect();
                let current: Vec<_> = candidates
                    .iter()
                    .map(|(i, item)| (&identities[*i], section_of(item)))
                    .collect();
                memory
                    .order_anchor(&identities[index], plan.destination, &current)
                    .map(|(i, left)| (candidates[i].1.window_id, left))
            } else {
                None
            };
            // Persist before dragging, including collision tombstones. A failed or
            // partially completed drag must not erase the original section.
            memory.save(&memory_path).map_err(|error| {
                diagnostics::record_event(
                    &handle,
                    "menu_bar_section_memory_error",
                    json!({"error": error}),
                );
                error
            })?;
            let (target_id, place_left) =
                anchor.unwrap_or_else(|| plan.target(control_id, always_boundary_id));
            diagnostics::record_event(
                &handle,
                "menu_bar_section_restore_plan",
                json!({
                    "windowId": window_id, "currentSection": section,
                    "destination": plan.destination, "fallbackReason": plan.fallback_reason,
                    "targetWindowId": target_id, "placeLeft": place_left,
                    "orderAnchorFound": anchor.is_some(),
                }),
            );
            // Keep both dividers unchanged: unrelated hidden items must never be exposed.
            macos_accessibility::move_menu_bar_item(&handle, window_id, target_id, place_left, true)
        })
        .await
        .map_err(|error| error.to_string())?;

        match move_result {
            Ok(()) => {
                diagnostics::record_event(
                    &app,
                    "menu_bar_item_visibility_changed",
                    json!({ "windowId": window_id, "hidden": hidden, "ok": true }),
                );
                schedule_organizer_observation(
                    &app,
                    if hidden {
                        "item_always_hidden"
                    } else {
                        "item_shown"
                    },
                );
                schedule_flowhub_menu_refresh(&app);
                Ok(json!({ "ok": true, "hidden": hidden }))
            }
            Err(error) => {
                diagnostics::record_event(
                    &app,
                    "menu_bar_item_visibility_changed",
                    json!({ "windowId": window_id, "hidden": hidden, "ok": false, "error": error }),
                );
                Ok(json!({ "ok": false, "reason": error }))
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    Ok(json!({ "ok": false, "reason": "逐项控制仅支持 macOS" }))
}

#[tauri::command]
pub(crate) fn get_menu_bar_management_state() -> Value {
    #[cfg(target_os = "macos")]
    {
        let trusted = macos_accessibility::is_trusted();
        return json!({
            "supported": true,
            "trusted": trusted,
            "nativeControl": true,
            "mode": if trusted { "combined" } else { "native" }
        });
    }
    #[cfg(not(target_os = "macos"))]
    json!({ "supported": false, "trusted": false, "nativeControl": false, "mode": "unsupported" })
}

#[tauri::command]
pub(crate) fn request_menu_bar_management_permission(
    app: tauri::AppHandle,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let trusted = macos_accessibility::request_trust();
        if !trusted {
            app.opener()
                .open_url(
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
                    None::<&str>,
                )
                .map_err(|error| error.to_string())?;
        }
        return Ok(json!({ "ok": true, "trusted": trusted }));
    }
    #[cfg(not(target_os = "macos"))]
    Ok(json!({ "ok": false, "trusted": false, "reason": "辅助功能增强仅支持 macOS" }))
}

#[cfg(target_os = "macos")]
pub(crate) fn schedule_flowhub_menu_refresh(app: &tauri::AppHandle) {
    let Ok(config) = hydrated_config(&app.state::<AppState>()) else {
        return;
    };
    let handle = app.clone();
    let callback_handle = handle.clone();
    let _ = handle.run_on_main_thread(move || {
        if let Err(error) = apply_menu_bar(&callback_handle, &config) {
            eprintln!("[flowhub-tauri] 菜单栏菜单刷新失败：{error}");
        }
    });
}

#[cfg(target_os = "macos")]
fn build_organizer_menu(
    app: &tauri::AppHandle,
) -> Result<tauri::menu::Submenu<tauri::Wry>, String> {
    let enabled = ORGANIZER_ENABLED.load(AtomicOrdering::Acquire);
    // Native child menu: hover/click expands beside the organizer menu instead
    // of launching an unrelated always-on-top webview window.
    let items_menu = SubmenuBuilder::with_id(app, FLOWHUB_ORGANIZER_ITEMS_MENU_ID, "逐个图标控制")
        .item(
            &MenuItem::with_id(
                app,
                "flowhub-items-loading",
                "正在读取图标…",
                false,
                None::<&str>,
            )
            .map_err(|error| error.to_string())?,
        )
        .build()
        .map_err(|error| error.to_string())?;
    SubmenuBuilder::with_id(app, FLOWHUB_ORGANIZER_MENU_ID, "菜单栏整理")
        .text(
            FLOWHUB_ORGANIZER_TOGGLE_MENU_ID,
            if !enabled {
                "启用隐藏分区"
            } else if ORGANIZER_COLLAPSED.load(AtomicOrdering::Acquire) {
                "展开隐藏区"
            } else {
                "收起隐藏区"
            },
        )
        .separator()
        .item(&items_menu)
        .text("flowhub-organizer-open-settings", "在设置中管理…")
        .build()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn toggle_menu_bar_panel(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("menu-bar-panel") {
        if window.is_visible().map_err(|error| error.to_string())? {
            return window.hide().map_err(|error| error.to_string());
        }
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        window
            .emit("menu-bar-panel-opened", ())
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        &app,
        "menu-bar-panel",
        WebviewUrl::App("menu-bar-panel.html".into()),
    )
    .title("菜单栏图标")
    .inner_size(340.0, 570.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .center()
    .build()
    .map_err(|error| error.to_string())?;
    if let Some(monitor) = window
        .current_monitor()
        .map_err(|error| error.to_string())?
    {
        let scale = monitor.scale_factor();
        let origin = monitor.position().to_logical::<f64>(scale);
        let size = monitor.size().to_logical::<f64>(scale);
        window
            .set_position(tauri::LogicalPosition::new(
                origin.x + size.width - 356.0,
                origin.y + 48.0,
            ))
            .map_err(|error| error.to_string())?;
    }
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn apply_menu_bar(app: &tauri::AppHandle, config: &Value) -> Result<Value, String> {
    // Updating the parent menu while its child is tracking dismisses the entire
    // cascade. The child refreshes row state in-place and refreshes on close.
    if macos_item_submenu::is_tracking() {
        macos_item_submenu::defer_refresh();
        return Ok(json!({ "enabled": true, "refreshDeferred": true }));
    }
    if !config_flag(config, "/core/menuBar/enabled", true) {
        let _ = app.remove_tray_by_id(FLOWHUB_TRAY_ID);
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
    menu = menu.text("flowhub-desktop-widgets", "打开桌面组件…");
    let plugins = app.state::<crate::plugin_runtime::Runtime>().status_plugins();
    if !plugins.is_empty() {
        let mut monitors = SubmenuBuilder::new(app, "插件监控");
        for (id, title) in plugins {
            let plugin_menu = SubmenuBuilder::new(app, title)
                .text(format!("flowhub-widget:{id}"), "打开桌面监控")
                .text(format!("flowhub-plugin:{id}"), "打开插件")
                .build().map_err(|error| error.to_string())?;
            monitors = monitors.item(&plugin_menu);
        }
        menu = menu.item(&monitors.build().map_err(|error| error.to_string())?);
    }
    menu = menu.separator();
    let organizer_menu = build_organizer_menu(app)?;
    menu = menu.item(&organizer_menu);
    menu = menu.separator();
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
    let runtime = app.state::<crate::updater::UpdateRuntime>();
    let (label, enabled) = crate::updater::menu_label(&runtime.snapshot());
    let update = MenuItem::with_id(app, "flowhub-update", label, enabled, None::<&str>)
        .map_err(|error| error.to_string())?;
    menu = menu.item(&update);
    *runtime.menu_item.lock().unwrap() = Some(update);
    if show_quit {
        menu = menu.text("flowhub-quit", "退出 FlowHub");
    }
    let menu = menu.build().map_err(|error| error.to_string())?;
    if let Some(tray) = app.tray_by_id(FLOWHUB_TRAY_ID) {
        // Recreating the status item reapplies its saved position and moves it
        // across the icon just revealed. Menu-only refreshes must preserve it.
        let before = tray
            .with_inner_tray_icon(|tray| organizer_item_snapshot(Some(tray)))
            .map_err(|error| error.to_string())?;
        tray.set_menu(Some(menu))
            .map_err(|error| error.to_string())?;
        let submenu_app = app.clone();
        tray.with_inner_tray_icon(move |tray| macos_item_submenu::install(&submenu_app, tray))
            .map_err(|error| error.to_string())??;
        let after = tray
            .with_inner_tray_icon(|tray| organizer_item_snapshot(Some(tray)))
            .map_err(|error| error.to_string())?;
        diagnostics::record_event(
            app,
            "flowhub_menu_refreshed",
            json!({
                "mode": "in-place", "before": before, "after": after,
            }),
        );
        return Ok(json!({ "enabled": true }));
    }
    #[cfg(target_os = "macos")]
    let icon = menu_bar_icon::image();
    #[cfg(not(target_os = "macos"))]
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "FlowHub 缺少菜单栏图标".to_string())?;
    let control_position = organizer_position(ORGANIZER_CONTROL_AUTOSAVE).unwrap_or(1.0);
    set_organizer_position(FLOWHUB_TRAY_AUTOSAVE, (control_position - 1.0).max(0.0));
    let tray = TrayIconBuilder::with_id(FLOWHUB_TRAY_ID)
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
            "flowhub-desktop-widgets" => {
                if let Err(error) = crate::plugin_canvas::open(app, "") {
                    eprintln!("[flowhub-tauri] 无法打开桌面组件：{error}");
                }
            }
            id if id.starts_with("flowhub-widget:") => {
                if let Err(error) = crate::plugin_canvas::open(app, &id["flowhub-widget:".len()..]) {
                    eprintln!("[flowhub-tauri] 无法打开插件监控：{error}");
                }
            }
            id if id.starts_with("flowhub-plugin:") => {
                crate::plugin_status::open_plugin(app, &id["flowhub-plugin:".len()..]);
            }
            "flowhub-update" => {
                // Use the settings controller for progress, errors and its unsaved
                // configuration guard. A newly created webview must finish loading.
                let _ = crate::open_settings_window(app.clone(), None, true);
            }
            FLOWHUB_ORGANIZER_TOGGLE_MENU_ID => {
                let result = if ORGANIZER_ENABLED.load(AtomicOrdering::Acquire) {
                    toggle_menu_bar_organizer(app).map(|_| ())
                } else {
                    enable_menu_bar_organizer(app)
                };
                if let Err(error) = result {
                    eprintln!("[flowhub-tauri] 菜单栏整理操作失败：{error}");
                }
            }
            "flowhub-organizer-request-permission" => {
                let _ = request_menu_bar_management_permission(app.clone());
            }
            "flowhub-organizer-refresh" => schedule_flowhub_menu_refresh(app),
            "flowhub-organizer-open-settings" => {
                let _ = open_settings(app.clone(), None);
            }
            "flowhub-quit" => app.exit(0),
            id if id.starts_with(FLOWHUB_ORGANIZER_ITEM_PREFIX) => {
                let payload = &id[FLOWHUB_ORGANIZER_ITEM_PREFIX.len()..];
                let Some((window_id, action)) = payload.split_once(':') else {
                    return;
                };
                let Ok(window_id) = window_id.parse::<u32>() else {
                    return;
                };
                let hidden = action == "hide";
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    match set_menu_bar_item_hidden(handle.clone(), window_id, hidden).await {
                        Ok(result) if result.get("ok").and_then(Value::as_bool) == Some(true) => {}
                        Ok(result) => eprintln!(
                            "[flowhub-tauri] 菜单栏单项操作失败：{}",
                            result
                                .get("reason")
                                .and_then(Value::as_str)
                                .unwrap_or("未知错误")
                        ),
                        Err(error) => {
                            eprintln!("[flowhub-tauri] 菜单栏单项操作失败：{error}")
                        }
                    }
                });
            }
            _ => {}
        })
        .build(app)
        .map_err(|error| error.to_string())?;
    tray.with_inner_tray_icon(|tray| set_organizer_autosave_name(tray, FLOWHUB_TRAY_AUTOSAVE))
        .map_err(|error| error.to_string())?;
    let submenu_app = app.clone();
    tray.with_inner_tray_icon(move |tray| macos_item_submenu::install(&submenu_app, tray))
        .map_err(|error| error.to_string())??;
    Ok(json!({ "enabled": true }))
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn apply_menu_bar(_app: &tauri::AppHandle, _config: &Value) -> Result<Value, String> {
    Ok(json!({ "enabled": false, "unsupported": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_tests::Fixture;
    use std::fs;

    #[test]
    fn organizer_edit_and_catalog_reads_wait_for_recovery() {
        let f = Fixture::new();
        let path = f.state.paths().config_path;
        let original = json!({"core": {"menuBar": {"organizerEnabled": false}}, "custom": 42});
        crate::storage::write_json_atomic(&path, &original).unwrap();
        let journal = f.root.join(".flowhub-config-save");
        fs::create_dir(&journal).unwrap();
        crate::storage::write_json_atomic(
            &journal.join("journal.json"),
            &json!({"committed": false, "files": []}),
        )
        .unwrap();
        assert!(persist_organizer_enabled(&f.state)
            .unwrap_err()
            .contains("尚待恢复"));
        assert!(crate::storage::hydrated_config(&f.state)
            .unwrap_err()
            .contains("尚待恢复"));
        assert_eq!(crate::storage::read_json(&path).unwrap(), original);
        crate::config_save::recover(&f.root).unwrap();
        let saved = persist_organizer_enabled(&f.state).unwrap();
        assert_eq!(saved["custom"], 42);
        assert_eq!(saved["core"]["menuBar"]["organizerEnabled"], true);
        assert!(crate::storage::hydrated_config(&f.state).is_ok());
    }

    #[test]
    fn organizer_edit_releases_save_gate_after_validation_and_write_errors() {
        let f = Fixture::new();
        let path = f.state.paths().config_path;
        crate::storage::write_json_atomic(&path, &json!({"core": false})).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(persist_organizer_enabled(&f.state).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(f.state.config_save.try_lock().is_ok());
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(persist_organizer_enabled(&f.state).is_err());
        assert!(f.state.config_save.try_lock().is_ok());
        fs::remove_dir(&path).unwrap();
        assert!(persist_organizer_enabled(&f.state).is_ok());
        assert!(crate::storage::database(&f.state).is_ok());
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn on_tray_event(app: &tauri::AppHandle, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        id,
        button,
        button_state,
        ..
    } = &event
    {
        if id.0 == ORGANIZER_CONTROL_ID {
            diagnostics::record_event(
                app,
                "menu_bar_organizer_click_raw",
                json!({
                    "id": id.0,
                    "button": format!("{button:?}"),
                    "buttonState": format!("{button_state:?}"),
                }),
            );
        }
    }
    if let TrayIconEvent::Click {
        id,
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        if id.0 == ORGANIZER_CONTROL_ID {
            diagnostics::record_event(
                app,
                "menu_bar_organizer_click",
                json!({
                    "id": id.0,
                    "collapsedBefore": ORGANIZER_COLLAPSED.load(AtomicOrdering::Acquire),
                }),
            );
            if let Err(error) = toggle_menu_bar_organizer(app) {
                eprintln!("[flowhub-tauri] 无法切换菜单栏隐藏区：{error}");
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn run_smoke_test(app: &tauri::AppHandle) -> Result<(), String> {
    if let Ok(smoke_test) = std::env::var("FLOWHUB_TAURI_ORGANIZER_SMOKE_TEST") {
        if smoke_test == "single-control" {
            return run_single_control_smoke(app);
        }
        configure_organizer_items(app, true, false)?;
        let menu_bar_items = macos_accessibility::menu_bar_items()?;
        let organizer_ids = organizer_window_ids()?;
        println!(
            "[flowhub-tauri] 菜单栏图标枚举：{}",
            json!({
                "count": menu_bar_items.len(),
                "organizerWindowIds": organizer_ids,
                "items": menu_bar_items,
            })
        );
        toggle_menu_bar_organizer(app)?;
        if smoke_test == "1" {
            configure_organizer_items(app, false, false)?;
        }
    }
    Ok(())
}

// Explicit native QA: exercise the real tray-icon mouse-up handler and wait for
// AppKit layout between transitions. Never posts input to other applications.
#[cfg(target_os = "macos")]
fn run_single_control_smoke(app: &tauri::AppHandle) -> Result<(), String> {
    let enabled = ORGANIZER_ENABLED.load(AtomicOrdering::Acquire);
    let collapsed = ORGANIZER_COLLAPSED.load(AtomicOrdering::Acquire);
    configure_organizer_items(app, true, false)?;
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut passed = true;
        for phase in 0..5 {
            std::thread::sleep(Duration::from_millis(900));
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            let _ = handle.run_on_main_thread(move || {
                let result = (|| -> Result<Value, String> {
                    let ids = organizer_window_ids()?;
                    if (ids.0 == ids.1) == organizer_collapsed() || ids.0 == ids.2 {
                        return Err("展开时存在额外分界，或收起时缺少临时占位".into());
                    }
                    if organizer_collapsed() != (phase % 2 == 1) {
                        return Err("原生鼠标事件未切换收起状态".into());
                    }
                    let tray = unsafe { organizer_tray(&ORGANIZER_CONTROL_PTR) }.unwrap();
                    let snapshot = organizer_item_snapshot(Some(tray));
                    let mtm = objc2::MainThreadMarker::new().unwrap();
                    let button = tray.ns_status_item().unwrap().button(mtm).unwrap();
                    let width = button.bounds().size.width;
                    if width <= 0.0 || width > 100.0 {
                        return Err("箭头绘制宽度不是固定的小尺寸".into());
                    }
                    let window = button.window().ok_or("箭头窗口缺失")?;
                    let screen = window.screen().ok_or("箭头不在显示器上")?;
                    let glyph_x = window.frame().origin.x + button.frame().origin.x + width - 4.0;
                    let screen_frame = screen.frame();
                    if glyph_x < screen_frame.origin.x || glyph_x > screen_frame.origin.x + screen_frame.size.width {
                        return Err("箭头右侧点击位置落在屏幕外".into());
                    }
                    let targets = button.subviews();
                    if targets.count() == 0 { return Err("鼠标响应层缺失".into()); }
                    let target = targets.iter().find(|view| view.identifier().is_none())
                        .ok_or("鼠标响应层缺失")?;
                    let glyph = &*button;
                    if button.title().to_string() != if organizer_collapsed() { "‹" } else { "›" } {
                        return Err("原生箭头文字错误".into());
                    }
                    let hit_point = objc2_foundation::NSPoint::new(width - 9.0, 10.0);
                    let hit = button.hitTest(hit_point).ok_or("箭头位置没有命中响应层")?;
                    if !std::ptr::eq(&*hit, &*target) {
                        return Err("箭头标签遮挡了鼠标响应层".into());
                    }
                    // Capture actual AppKit drawing, not just a guessed title
                    // rectangle. Files contain only the small arrow label.
                    let bitmap = glyph.bitmapImageRepForCachingDisplayInRect(glyph.bounds())
                        .ok_or("无法创建箭头绘制快照")?;
                    glyph.cacheDisplayInRect_toBitmapImageRep(glyph.bounds(), &bitmap);
                    let png = unsafe { bitmap.representationUsingType_properties(
                        objc2_app_kit::NSBitmapImageFileType::PNG,
                        &objc2_foundation::NSDictionary::new(),
                    ) }.ok_or("无法编码箭头快照")?;
                    let image_path = std::env::temp_dir().join(format!("flowhub-glyph-phase-{phase}.png"));
                    if !png.writeToFile_atomically(&NSString::from_str(&image_path.to_string_lossy()), true) {
                        return Err("无法写入箭头快照".into());
                    }
                    if (target.frame().size.width - button.bounds().size.width).abs() > 1.0 {
                        return Err("鼠标响应层没有跟随宽度变化".into());
                    }
                    if phase < 4 {
                        use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
                        let point = objc2_foundation::NSPoint::new(button.bounds().size.width - 4.0, 10.0);
                        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                            NSEventType::LeftMouseUp, point, NSEventModifierFlags::empty(),
                            0.0, button.window().unwrap().windowNumber(), None, 1, 1, 0.0,
                        ).ok_or("无法构造原生测试事件")?;
                        target.mouseUp(&event);
                    }
                    Ok(json!({"phase":phase,"control":snapshot,"ids":ids}))
                })();
                let _ = tx.send(result);
            });
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ok(snapshot)) => println!("single-control-qa {snapshot}"),
                error => { eprintln!("single-control-qa FAILED {error:?}"); passed = false; break; }
            }
        }
        let restore = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let result = configure_organizer_items(&restore, enabled, collapsed);
            println!("single-control-qa complete passed={} restored={}", passed, result.is_ok());
        });
    });
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn open_native_menu(app: &tauri::AppHandle) {
    // Diagnostic entry to the real status-item menu, not the
    // overlay shortcut: exercise native submenu handoff in QA.
    if let Some(tray) = app.tray_by_id(FLOWHUB_TRAY_ID) {
        let _ = tray.with_inner_tray_icon(|tray| {
            if let Some(mtm) = objc2::MainThreadMarker::new() {
                if let Some(button) = tray.ns_status_item().and_then(|status| status.button(mtm)) {
                    // Nil sender is valid for the status button's AppKit action.
                    unsafe {
                        button.performClick(None);
                    }
                }
            }
        });
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn organizer_collapsed() -> bool {
    ORGANIZER_COLLAPSED.load(AtomicOrdering::Acquire)
}

#[cfg(target_os = "macos")]
pub(crate) fn organizer_enabled() -> bool {
    ORGANIZER_ENABLED.load(AtomicOrdering::Acquire)
}

#[cfg(target_os = "macos")]
pub(crate) fn organizer_item_move_active() -> bool {
    ORGANIZER_ITEM_MOVE_ACTIVE.load(AtomicOrdering::Acquire)
}

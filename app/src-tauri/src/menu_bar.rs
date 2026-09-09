//! Menu bar lifecycle, organizer state and native command dispatch.
//! Storage handles persisted settings; config_save owns recovery readiness.
use crate::storage::{ensure_object_path, hydrated_config};
use crate::{diagnostics, open_settings, toggle_main, AppState};
#[cfg(target_os = "macos")]
use crate::{macos_accessibility, macos_item_submenu, menu_bar_icon, menu_bar_section_memory};
#[cfg(target_os = "macos")]
use objc2::Message;
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSLayoutAttribute, NSLayoutConstraint, NSLayoutConstraintOrientation,
    NSVariableStatusItemLength,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSString, NSUserDefaults};
use serde_json::{json, Value};
use std::{
    sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering as AtomicOrdering},
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
const ORGANIZER_BOUNDARY_ID: &str = "flowhub-organizer-boundary";
#[cfg(target_os = "macos")]
const ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_ID: &str = "flowhub-organizer-always-hidden-boundary";
#[cfg(target_os = "macos")]
const ORGANIZER_CONTROL_AUTOSAVE: &str = "FlowHub.Organizer.V17.Control";
#[cfg(target_os = "macos")]
const ORGANIZER_BOUNDARY_AUTOSAVE: &str = "FlowHub.Organizer.V17.Boundary";
#[cfg(target_os = "macos")]
const ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_AUTOSAVE: &str =
    "FlowHub.Organizer.V18.AlwaysHiddenBoundary";
#[cfg(target_os = "macos")]
static ORGANIZER_CONTROL_PTR: AtomicUsize = AtomicUsize::new(0);
#[cfg(target_os = "macos")]
static ORGANIZER_BOUNDARY_PTR: AtomicUsize = AtomicUsize::new(0);
#[cfg(target_os = "macos")]
static ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_PTR: AtomicUsize = AtomicUsize::new(0);
#[cfg(target_os = "macos")]
static ORGANIZER_BOUNDARY_CONSTRAINT_PTR: AtomicUsize = AtomicUsize::new(0);
#[cfg(target_os = "macos")]
static ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_CONSTRAINT_PTR: AtomicUsize = AtomicUsize::new(0);
#[cfg(target_os = "macos")]
static ORGANIZER_ENABLED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static ORGANIZER_COLLAPSED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static ORGANIZER_POSITION_WATCHER_STARTED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static ORGANIZER_ITEM_MOVE_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static ORGANIZER_LAST_CONTROL_POSITION: AtomicU64 = AtomicU64::new(u64::MAX);
#[cfg(target_os = "macos")]
static ORGANIZER_LAST_BOUNDARY_POSITION: AtomicU64 = AtomicU64::new(u64::MAX);

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
fn set_organizer_item_length(tray: &tray_icon::TrayIcon, length: f64) {
    if let Some(status_item) = tray.ns_status_item() {
        status_item.setLength(length);
    }
}

#[cfg(target_os = "macos")]
fn capture_organizer_minimum_width_constraint(
    tray: &tray_icon::TrayIcon,
    constraint_pointer: &AtomicUsize,
) {
    if constraint_pointer.load(AtomicOrdering::Acquire) != 0 {
        return;
    }
    let Some(status_item) = tray.ns_status_item() else {
        return;
    };
    let Some(main_thread) = objc2::MainThreadMarker::new() else {
        return;
    };
    let Some(button) = status_item.button(main_thread) else {
        return;
    };
    let Some(window) = button.window() else {
        return;
    };
    let Some(content_view) = window.contentView() else {
        return;
    };
    let constraints = content_view
        .constraintsAffectingLayoutForOrientation(NSLayoutConstraintOrientation::Horizontal);
    let Some(button_superview) = (unsafe { button.superview() }) else {
        return;
    };
    let superview_ptr = objc2::rc::Retained::as_ptr(&button_superview) as *const ();
    for constraint in constraints.iter() {
        let second_item = unsafe { constraint.secondItem() };
        let is_status_item_width_constraint = second_item
            .as_ref()
            .is_some_and(|item| objc2::rc::Retained::as_ptr(item) as *const () == superview_ptr);
        if is_status_item_width_constraint {
            let retained = constraint.retain();
            let original_constant = retained.constant();
            let pointer = Box::into_raw(Box::new((retained, original_constant)));
            constraint_pointer.store(pointer as usize, AtomicOrdering::Release);
            break;
        }
    }
}

#[cfg(target_os = "macos")]
unsafe fn organizer_boundary_constraint(
    constraint_pointer: &AtomicUsize,
) -> Option<&'static (objc2::rc::Retained<NSLayoutConstraint>, f64)> {
    let address = constraint_pointer.load(AtomicOrdering::Acquire);
    (address != 0)
        .then(|| unsafe { &*(address as *const (objc2::rc::Retained<NSLayoutConstraint>, f64)) })
}

#[cfg(target_os = "macos")]
fn set_organizer_boundary_collapsed(
    tray: &tray_icon::TrayIcon,
    constraint_pointer: &AtomicUsize,
    collapsed: bool,
) {
    let Some(status_item) = tray.ns_status_item() else {
        return;
    };
    capture_organizer_minimum_width_constraint(tray, constraint_pointer);
    status_item.setLength(if collapsed { 10_000.0 } else { 1.0 });
    // Remove the separator's native width padding through its layout constraint,
    // rather than resizing only the active display's NSWindow. Apply this after
    // setLength, which restores AppKit's padding. Leave collapsed layout native.
    if let Some((constraint, original_constant)) =
        unsafe { organizer_boundary_constraint(constraint_pointer) }
    {
        let is_width_padding = constraint.firstAttribute() == NSLayoutAttribute::Width
            && constraint.secondAttribute() == NSLayoutAttribute::Width
            && (0.0..=32.0).contains(original_constant);
        if is_width_padding && !collapsed {
            constraint.setConstant(0.0);
        }
        constraint.setActive(true);
    }
}

#[cfg(target_os = "macos")]
fn recreate_collapsed_organizer_boundary(
    app: &tauri::AppHandle,
    control_position: f64,
) -> Result<(), String> {
    let constraint_pointer = ORGANIZER_BOUNDARY_CONSTRAINT_PTR.swap(0, AtomicOrdering::AcqRel);
    if constraint_pointer != 0 {
        unsafe {
            drop(Box::from_raw(
                constraint_pointer as *mut (objc2::rc::Retained<NSLayoutConstraint>, f64),
            ));
        }
    }
    let boundary_pointer = ORGANIZER_BOUNDARY_PTR.swap(0, AtomicOrdering::AcqRel);
    if boundary_pointer != 0 {
        unsafe {
            drop(Box::from_raw(boundary_pointer as *mut tray_icon::TrayIcon));
        }
    }
    let repaired_position = control_position + 1.0;
    set_organizer_position(ORGANIZER_BOUNDARY_AUTOSAVE, repaired_position);

    let boundary = tray_icon::TrayIconBuilder::new()
        .with_id(ORGANIZER_BOUNDARY_ID)
        .with_title("")
        .build()
        .map_err(|error| error.to_string())?;
    set_organizer_autosave_name(&boundary, ORGANIZER_BOUNDARY_AUTOSAVE);
    capture_organizer_minimum_width_constraint(&boundary, &ORGANIZER_BOUNDARY_CONSTRAINT_PTR);
    boundary
        .set_icon_with_as_template(None, true)
        .map_err(|error| error.to_string())?;
    boundary.set_title(Some(""));
    set_organizer_boundary_collapsed(&boundary, &ORGANIZER_BOUNDARY_CONSTRAINT_PTR, true);
    let boundary = Box::into_raw(Box::new(boundary));
    ORGANIZER_BOUNDARY_PTR.store(boundary as usize, AtomicOrdering::Release);
    ORGANIZER_LAST_BOUNDARY_POSITION.store(repaired_position.to_bits(), AtomicOrdering::Release);
    schedule_organizer_observation(app, "position_repair");
    Ok(())
}

#[cfg(target_os = "macos")]
fn start_organizer_position_watcher(app: &tauri::AppHandle) {
    if ORGANIZER_POSITION_WATCHER_STARTED.swap(true, AtomicOrdering::AcqRel) {
        return;
    }
    if let Some(position) = organizer_position(ORGANIZER_CONTROL_AUTOSAVE) {
        ORGANIZER_LAST_CONTROL_POSITION.store(position.to_bits(), AtomicOrdering::Release);
    }
    if let Some(position) = organizer_position(ORGANIZER_BOUNDARY_AUTOSAVE) {
        ORGANIZER_LAST_BOUNDARY_POSITION.store(position.to_bits(), AtomicOrdering::Release);
    }
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        if !ORGANIZER_ENABLED.load(AtomicOrdering::Acquire) {
            continue;
        }
        if ORGANIZER_ITEM_MOVE_ACTIVE.load(AtomicOrdering::Acquire) {
            continue;
        }
        let callback_handle = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            // The worker's check can be stale by the time this queued callback
            // runs. Never repair/recreate a divider during an item drag.
            if !ORGANIZER_ENABLED.load(AtomicOrdering::Acquire)
                || ORGANIZER_ITEM_MOVE_ACTIVE.load(AtomicOrdering::Acquire)
            {
                return;
            }
            let Some(control_position) = organizer_position(ORGANIZER_CONTROL_AUTOSAVE) else {
                return;
            };
            let Some(boundary_position) = organizer_position(ORGANIZER_BOUNDARY_AUTOSAVE) else {
                return;
            };
            let previous_control = ORGANIZER_LAST_CONTROL_POSITION
                .swap(control_position.to_bits(), AtomicOrdering::AcqRel);
            let previous_boundary = ORGANIZER_LAST_BOUNDARY_POSITION
                .swap(boundary_position.to_bits(), AtomicOrdering::AcqRel);
            let position_changed = previous_control != u64::MAX
                && previous_boundary != u64::MAX
                && (previous_control != control_position.to_bits()
                    || previous_boundary != boundary_position.to_bits());
            if position_changed && ORGANIZER_COLLAPSED.load(AtomicOrdering::Acquire) {
                diagnostics::record_event(
                    &callback_handle,
                    "menu_bar_organizer_position_repair",
                    json!({
                        "controlPosition": control_position,
                        "boundaryPosition": boundary_position,
                    }),
                );
                if let Err(error) =
                    recreate_collapsed_organizer_boundary(&callback_handle, control_position)
                {
                    diagnostics::record_event(
                        &callback_handle,
                        "menu_bar_organizer_position_repair_failed",
                        json!({ "error": error }),
                    );
                }
            }
        });
    });
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
                    if subviews.count() > 0 {
                        let event_target_frame = subviews.objectAtIndex(0).frame();
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
    let boundary = organizer_window_id(&ORGANIZER_BOUNDARY_PTR)
        .ok_or_else(|| "普通隐藏分界尚未就绪".to_string())?;
    let always_hidden_boundary = organizer_window_id(&ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_PTR)
        .ok_or_else(|| "始终隐藏分界尚未就绪".to_string())?;
    Ok((control, boundary, always_hidden_boundary))
}

#[cfg(target_os = "macos")]
fn record_organizer_state(app: &tauri::AppHandle, phase: &str) {
    let control = organizer_item_snapshot(unsafe { organizer_tray(&ORGANIZER_CONTROL_PTR) });
    let boundary = organizer_item_snapshot(unsafe { organizer_tray(&ORGANIZER_BOUNDARY_PTR) });
    let always_hidden_boundary =
        organizer_item_snapshot(unsafe { organizer_tray(&ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_PTR) });
    let boundary_padding =
        unsafe { organizer_boundary_constraint(&ORGANIZER_BOUNDARY_CONSTRAINT_PTR) }.map(
            |(constraint, original)| {
                json!({
                    "original": original, "current": constraint.constant(),
                    "firstAttribute": constraint.firstAttribute().0,
                    "secondAttribute": constraint.secondAttribute().0
                })
            },
        );
    let detail = json!({
        "boundaryPadding": boundary_padding,
        "phase": phase,
        "enabled": ORGANIZER_ENABLED.load(AtomicOrdering::Acquire),
        "collapsed": ORGANIZER_COLLAPSED.load(AtomicOrdering::Acquire),
        "controlSymbol": if ORGANIZER_COLLAPSED.load(AtomicOrdering::Acquire) { "‹" } else { "›" },
        "mainThread": objc2::MainThreadMarker::new().is_some(),
        "layoutMode": "fixed-control-dual-boundary",
        "control": control,
        "boundary": boundary,
        "alwaysHiddenBoundary": always_hidden_boundary,
        "boundaryConstraintCaptured": ORGANIZER_BOUNDARY_CONSTRAINT_PTR.load(AtomicOrdering::Acquire) != 0
    });
    diagnostics::record_event(app, "menu_bar_organizer", detail);
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
    record_organizer_state(app, &format!("{phase}:immediate"));
    for delay_ms in [150_u64, 800_u64] {
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
    // While expanded, Cmd-drag can insert an icon between the one-point
    // divider and the separate arrow. Growing that displaced divider leaves
    // the inserted icon visible. Restore adjacency BEFORE taking tray
    // references: repair replaces (and drops) the old divider.
    if enabled && collapsed && !ORGANIZER_COLLAPSED.load(AtomicOrdering::Acquire)
        && ORGANIZER_BOUNDARY_PTR.load(AtomicOrdering::Acquire) != 0
    {
        if ORGANIZER_ITEM_MOVE_ACTIVE.load(AtomicOrdering::Acquire) {
            return Err("正在移动菜单栏图标，请稍后收起".into());
        }
        let position = organizer_position(ORGANIZER_CONTROL_AUTOSAVE)
            .ok_or_else(|| "菜单栏箭头位置尚未就绪".to_string())?;
        recreate_collapsed_organizer_boundary(app, position)?;
    }
    let control = unsafe { organizer_tray(&ORGANIZER_CONTROL_PTR) };
    let boundary = unsafe { organizer_tray(&ORGANIZER_BOUNDARY_PTR) };
    let always_hidden_boundary = unsafe { organizer_tray(&ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_PTR) };
    let (control, boundary, always_hidden_boundary) =
        match (control, boundary, always_hidden_boundary) {
            (Some(control), Some(boundary), Some(always_hidden_boundary)) => {
                (control, boundary, always_hidden_boundary)
            }
            _ => {
                seed_organizer_position(ORGANIZER_CONTROL_AUTOSAVE, 1.0);
                let control = tray_icon::TrayIconBuilder::new()
                    .with_id(ORGANIZER_CONTROL_ID)
                    .with_title(if collapsed { "‹" } else { "›" })
                    .with_tooltip("展开或收起菜单栏隐藏区")
                    .build()
                    .map_err(|error| error.to_string())?;
                set_organizer_autosave_name(&control, ORGANIZER_CONTROL_AUTOSAVE);
                let control_position =
                    organizer_position(ORGANIZER_CONTROL_AUTOSAVE).unwrap_or(1.0);
                set_organizer_position(ORGANIZER_BOUNDARY_AUTOSAVE, control_position + 1.0);
                seed_organizer_position(ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_AUTOSAVE, 10_000.0);
                let boundary = tray_icon::TrayIconBuilder::new()
                    .with_id(ORGANIZER_BOUNDARY_ID)
                    .with_title("")
                    .build()
                    .map_err(|error| error.to_string())?;
                set_organizer_autosave_name(&boundary, ORGANIZER_BOUNDARY_AUTOSAVE);
                capture_organizer_minimum_width_constraint(
                    &boundary,
                    &ORGANIZER_BOUNDARY_CONSTRAINT_PTR,
                );
                let always_hidden_boundary = tray_icon::TrayIconBuilder::new()
                    .with_id(ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_ID)
                    .with_title("")
                    .build()
                    .map_err(|error| error.to_string())?;
                set_organizer_autosave_name(
                    &always_hidden_boundary,
                    ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_AUTOSAVE,
                );
                capture_organizer_minimum_width_constraint(
                    &always_hidden_boundary,
                    &ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_CONSTRAINT_PTR,
                );
                let control = Box::into_raw(Box::new(control));
                let boundary = Box::into_raw(Box::new(boundary));
                let always_hidden_boundary = Box::into_raw(Box::new(always_hidden_boundary));
                ORGANIZER_CONTROL_PTR.store(control as usize, AtomicOrdering::Release);
                ORGANIZER_BOUNDARY_PTR.store(boundary as usize, AtomicOrdering::Release);
                ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_PTR
                    .store(always_hidden_boundary as usize, AtomicOrdering::Release);
                (unsafe { &*control }, unsafe { &*boundary }, unsafe {
                    &*always_hidden_boundary
                })
            }
        };

    if !enabled {
        control
            .set_visible(false)
            .map_err(|error| error.to_string())?;
        boundary
            .set_visible(false)
            .map_err(|error| error.to_string())?;
        always_hidden_boundary
            .set_visible(false)
            .map_err(|error| error.to_string())?;
    } else {
        control
            .set_visible(true)
            .map_err(|error| error.to_string())?;
        boundary
            .set_visible(true)
            .map_err(|error| error.to_string())?;
        always_hidden_boundary
            .set_visible(true)
            .map_err(|error| error.to_string())?;
        set_organizer_autosave_name(control, ORGANIZER_CONTROL_AUTOSAVE);
        set_organizer_autosave_name(boundary, ORGANIZER_BOUNDARY_AUTOSAVE);
        set_organizer_autosave_name(
            always_hidden_boundary,
            ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_AUTOSAVE,
        );
        set_organizer_item_length(control, NSVariableStatusItemLength);
        control
            .set_icon_with_as_template(None, true)
            .map_err(|error| error.to_string())?;
        control.set_title(Some(if collapsed { "‹" } else { "›" }));
        boundary
            .set_icon_with_as_template(None, true)
            .map_err(|error| error.to_string())?;
        boundary.set_title(Some(""));
        set_organizer_boundary_collapsed(boundary, &ORGANIZER_BOUNDARY_CONSTRAINT_PTR, collapsed);
        always_hidden_boundary
            .set_icon_with_as_template(None, true)
            .map_err(|error| error.to_string())?;
        always_hidden_boundary.set_title(Some(""));
        set_organizer_boundary_collapsed(
            always_hidden_boundary,
            &ORGANIZER_ALWAYS_HIDDEN_BOUNDARY_CONSTRAINT_PTR,
            true,
        );
    }
    ORGANIZER_ENABLED.store(enabled, AtomicOrdering::Release);
    ORGANIZER_COLLAPSED.store(collapsed, AtomicOrdering::Release);
    start_organizer_position_watcher(app);
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

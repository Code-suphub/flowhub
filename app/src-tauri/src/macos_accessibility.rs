use core_foundation::{
    array::CFArray,
    base::{CFType, CFTypeRef, TCFType},
    boolean::CFBoolean,
    dictionary::{CFDictionary, CFDictionaryRef},
    number::CFNumber,
    runloop::{kCFRunLoopDefaultMode, CFRunLoop},
    string::{CFString, CFStringRef},
};
use core_graphics::{
    display::CGDisplay,
    event::{
        CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions,
        CGEventTapPlacement, CGEventType, CGMouseButton, CallbackResult, EventField,
    },
    event_source::{CGEventSource, CGEventSourceStateID},
    geometry::{CGPoint, CGRect},
    window::{
        create_description_from_array, kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowName,
        kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID,
    },
};
use serde::Serialize;
use std::{ptr, thread, time::Duration};

type CGSConnectionID = u32;
type CGWindowID = u32;

const MOUSE_QUIET_SECONDS: f64 = 0.20;
const MOUSE_WAIT_BUDGET: Duration = Duration::from_millis(300);
const MOUSE_POLL_INTERVAL: Duration = Duration::from_millis(20);
const MOUSE_ACTIVITY_TYPES: [CGEventType; 11] = [
    CGEventType::MouseMoved,
    CGEventType::LeftMouseDragged,
    CGEventType::RightMouseDragged,
    CGEventType::OtherMouseDragged,
    CGEventType::ScrollWheel,
    CGEventType::LeftMouseDown,
    CGEventType::LeftMouseUp,
    CGEventType::RightMouseDown,
    CGEventType::RightMouseUp,
    CGEventType::OtherMouseDown,
    CGEventType::OtherMouseUp,
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MousePreflight {
    pressed_buttons: Vec<u32>,
    activity_ages_seconds: [f64; MOUSE_ACTIVITY_TYPES.len()],
}

#[derive(Debug, PartialEq)]
enum MouseWaitDecision {
    Ready,
    Wait(Duration),
    Reject(&'static str),
}

impl MousePreflight {
    fn read() -> Self {
        // CGEventSource.h: HIDSystemState tracks hardware sources, whereas
        // CombinedSessionState also includes our posted Private-source events.
        let state = CGEventSourceStateID::HIDSystemState;
        let activity_ages_seconds = MOUSE_ACTIVITY_TYPES.map(|event_type| unsafe {
            CGEventSourceSecondsSinceLastEventType(state, event_type)
        });
        // CGMouseButton is uint32_t in CGEventTypes.h. Query all 32 Quartz
        // mouse buttons (CGRemoteOperation.h), including side buttons; do not
        // transmute their indices into the crate's three-variant Rust enum.
        let pressed_buttons = (0..32)
            .filter(|&button| unsafe { CGEventSourceButtonState(state, button) })
            .collect();
        Self {
            pressed_buttons,
            activity_ages_seconds,
        }
    }

    fn rejection(&self) -> Option<&'static str> {
        if !self.pressed_buttons.is_empty() {
            Some("mouse_button_down")
        } else if self
            .activity_ages_seconds
            .iter()
            .any(|age| !age.is_finite() || *age < 0.0)
        {
            Some("invalid_mouse_activity")
        } else if self
            .activity_ages_seconds
            .iter()
            .any(|age| *age < MOUSE_QUIET_SECONDS)
        {
            Some("recent_mouse_activity")
        } else {
            None
        }
    }

    fn wait_decision(&self, elapsed: Duration) -> MouseWaitDecision {
        match self.rejection() {
            Some(reason @ ("mouse_button_down" | "invalid_mouse_activity")) => {
                MouseWaitDecision::Reject(reason)
            }
            // Check the deadline before accepting even a quiet sample: an
            // overslept worker must not silently execute a stale request.
            _ if elapsed >= MOUSE_WAIT_BUDGET => MouseWaitDecision::Reject("mouse_wait_timeout"),
            None => MouseWaitDecision::Ready,
            Some(_) => MouseWaitDecision::Wait(
                MOUSE_POLL_INTERVAL.min(MOUSE_WAIT_BUDGET - elapsed),
            ),
        }
    }
}

fn wait_for_quiet_mouse() -> (MousePreflight, Duration, Option<&'static str>) {
    let started = std::time::Instant::now();
    loop {
        let sample = MousePreflight::read();
        let elapsed = started.elapsed();
        match sample.wait_decision(elapsed) {
            MouseWaitDecision::Ready => return (sample, elapsed, None),
            MouseWaitDecision::Reject(reason) => return (sample, elapsed, Some(reason)),
            MouseWaitDecision::Wait(delay) => thread::sleep(delay),
        }
    }
}

// Restoring via a posted MouseMoved event is asynchronous: showing the cursor
// first can reveal its temporary drag position. Warp synchronously, then show.
struct CursorMoveGuard {
    point: CGPoint,
    displays: Vec<CGDisplay>,
}

impl CursorMoveGuard {
    fn new(point: CGPoint) -> Self {
        let displays = CGDisplay::active_displays()
            .unwrap_or_else(|_| vec![CGDisplay::main().id])
            .into_iter()
            .map(CGDisplay::new)
            .filter(|display| display.hide_cursor().is_ok())
            .collect();
        Self { point, displays }
    }
}

impl Drop for CursorMoveGuard {
    fn drop(&mut self) {
        let _ = CGDisplay::warp_mouse_cursor_position(self.point);
        for display in &self.displays {
            let _ = display.show_cursor();
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarItem {
    pub window_id: u32,
    pub owner_pid: i32,
    pub owner_name: String,
    pub title: String,
    pub accessibility_id: String,
    pub accessibility_label: String,
    pub stable_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub on_screen: bool,
    pub movable: bool,
    pub hideable: bool,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(
        element: CFTypeRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXValueGetValue(value: CFTypeRef, value_type: u32, output: *mut std::ffi::c_void) -> bool;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    // Signatures verified against the local SDK's CGEventSource.h; these
    // functions are not wrapped by core-graphics 0.25's event_source module.
    fn CGEventSourceButtonState(state_id: CGEventSourceStateID, button: u32) -> bool;
    fn CGEventSourceSecondsSinceLastEventType(
        state_id: CGEventSourceStateID,
        event_type: CGEventType,
    ) -> f64;
    fn CGSMainConnectionID() -> CGSConnectionID;
    fn CGSGetWindowCount(
        connection: CGSConnectionID,
        target_connection: CGSConnectionID,
        count: *mut i32,
    ) -> i32;
    fn CGSGetProcessMenuBarWindowList(
        connection: CGSConnectionID,
        target_connection: CGSConnectionID,
        capacity: i32,
        list: *mut CGWindowID,
        count: *mut i32,
    ) -> i32;
    fn CGRectMakeWithDictionaryRepresentation(
        dictionary: CFDictionaryRef,
        rect: *mut CGRect,
    ) -> bool;
}

pub fn is_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

pub fn request_trust() -> bool {
    unsafe {
        let prompt_key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let options = CFDictionary::from_CFType_pairs(&[(prompt_key, CFBoolean::true_value())]);
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef())
    }
}

fn menu_bar_window_ids() -> Result<Vec<CGWindowID>, String> {
    unsafe {
        let connection = CGSMainConnectionID();
        let mut capacity = 0_i32;
        let result = CGSGetWindowCount(connection, 0, &mut capacity);
        if result != 0 || capacity <= 0 {
            return Err(format!("CGSGetWindowCount failed: {result}"));
        }
        let mut ids = vec![0_u32; capacity as usize];
        let mut count = 0_i32;
        let result =
            CGSGetProcessMenuBarWindowList(connection, 0, capacity, ids.as_mut_ptr(), &mut count);
        if result != 0 {
            return Err(format!("CGSGetProcessMenuBarWindowList failed: {result}"));
        }
        ids.truncate(count.max(0) as usize);
        Ok(ids)
    }
}

fn dictionary_value(
    dictionary: &CFDictionary<CFString, core_foundation::base::CFType>,
    key: CFStringRef,
) -> Option<core_foundation::base::CFType> {
    let key = unsafe { CFString::wrap_under_get_rule(key) };
    dictionary.find(&key).map(|value| value.as_CFType())
}

fn dictionary_string(
    dictionary: &CFDictionary<CFString, core_foundation::base::CFType>,
    key: CFStringRef,
) -> Option<String> {
    dictionary_value(dictionary, key)
        .and_then(|value| value.downcast::<CFString>())
        .map(|value| value.to_string())
}

fn dictionary_number(
    dictionary: &CFDictionary<CFString, core_foundation::base::CFType>,
    key: CFStringRef,
) -> Option<i32> {
    dictionary_value(dictionary, key)
        .and_then(|value| value.downcast::<CFNumber>())
        .and_then(|value| value.to_i32())
}

fn dictionary_bool(
    dictionary: &CFDictionary<CFString, core_foundation::base::CFType>,
    key: CFStringRef,
) -> bool {
    dictionary_value(dictionary, key)
        .and_then(|value| value.downcast::<CFBoolean>())
        .is_some_and(|value| value == CFBoolean::true_value())
}

pub fn is_fixed_menu_bar_entry(owner_name: &str, title: &str, accessibility_id: &str) -> bool {
    matches!(owner_name, "Control Center" | "控制中心")
        && (matches!(title, "Clock" | "BentoBox")
            || matches!(
                accessibility_id,
                "com.apple.menuextra.clock" | "com.apple.menuextra.controlcenter"
            ))
}

fn item_capabilities(owner_name: &str, title: &str, accessibility_id: &str) -> (bool, bool) {
    let control_center = matches!(owner_name, "Control Center" | "控制中心");
    let immovable = is_fixed_menu_bar_entry(owner_name, title, accessibility_id)
        || (owner_name == "SystemUIServer" && title == "Siri");
    let non_hideable =
        control_center && matches!(title, "AudioVideoModule" | "FaceTime" | "MusicRecognition");
    (!immovable, !immovable && !non_hideable)
}

fn ax_attribute(element: CFTypeRef, attribute: &str) -> Option<CFType> {
    let attribute = CFString::new(attribute);
    let mut value = ptr::null();
    let result = unsafe {
        AXUIElementCopyAttributeValue(element, attribute.as_concrete_TypeRef(), &mut value)
    };
    if result != 0 || value.is_null() {
        return None;
    }
    Some(unsafe { CFType::wrap_under_create_rule(value) })
}

fn ax_string_attribute(element: CFTypeRef, attribute: &str) -> Option<String> {
    ax_attribute(element, attribute)
        .and_then(CFType::downcast_into::<CFString>)
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
}

fn control_center_accessibility_items(owner_pid: i32) -> Vec<(String, String, CGPoint)> {
    let application = unsafe { AXUIElementCreateApplication(owner_pid) };
    if application.is_null() {
        return Vec::new();
    }
    let _application_guard = unsafe { CFType::wrap_under_create_rule(application) };
    let Some(menu_bar) = ax_attribute(application, "AXExtrasMenuBar") else {
        return Vec::new();
    };
    let Some(children) = ax_attribute(menu_bar.as_CFTypeRef(), "AXChildren")
        .and_then(CFType::downcast_into::<CFArray>)
    else {
        return Vec::new();
    };
    children
        .get_all_values()
        .into_iter()
        .filter_map(|element| {
            let accessibility_id = ax_string_attribute(element, "AXIdentifier").unwrap_or_default();
            let description = ax_string_attribute(element, "AXDescription").unwrap_or_default();
            let label = match accessibility_id.as_str() {
                "com.apple.menuextra.clock" => "时钟".to_string(),
                "com.apple.menuextra.controlcenter" => "控制中心".to_string(),
                "com.apple.menuextra.battery" => "电池".to_string(),
                _ => description,
            };
            let position = ax_attribute(element, "AXPosition")?;
            let mut point = CGPoint::new(0.0, 0.0);
            if !unsafe {
                AXValueGetValue(
                    position.as_CFTypeRef(),
                    1,
                    &mut point as *mut _ as *mut std::ffi::c_void,
                )
            } {
                return None;
            }
            Some((accessibility_id, label, point))
        })
        .collect()
}

fn window_id_array(ids: &[CGWindowID]) -> CFArray<CGWindowID> {
    // CFArray stores pointer-sized slots. Passing &[u32] makes CFArrayCreate
    // read pairs of IDs and run beyond the allocation on 64-bit macOS.
    let slots: Vec<usize> = ids.iter().map(|&id| id as usize).collect();
    let array = CFArray::from_copyable(&slots);
    unsafe { CFArray::wrap_under_get_rule(array.as_concrete_TypeRef()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_foundation::array::CFArrayGetValueAtIndex;

    fn quiet_mouse() -> MousePreflight {
        MousePreflight {
            pressed_buttons: Vec::new(),
            activity_ages_seconds: [MOUSE_QUIET_SECONDS; MOUSE_ACTIVITY_TYPES.len()],
        }
    }

    #[test]
    fn mouse_preflight_requires_all_buttons_released() {
        for button in 0..32 {
            let mut sample = quiet_mouse();
            sample.pressed_buttons.push(button);
            assert_eq!(sample.rejection(), Some("mouse_button_down"));
        }
    }

    #[test]
    fn mouse_preflight_checks_every_activity_and_quiet_boundary() {
        assert_eq!(quiet_mouse().rejection(), None);
        for index in 0..MOUSE_ACTIVITY_TYPES.len() {
            let mut sample = quiet_mouse();
            for age in [0.0, MOUSE_QUIET_SECONDS - 0.001] {
                sample.activity_ages_seconds[index] = age;
                assert_eq!(sample.rejection(), Some("recent_mouse_activity"));
            }
            for age in [MOUSE_QUIET_SECONDS, 3600.0, f64::MAX] {
                sample.activity_ages_seconds[index] = age;
                assert_eq!(sample.rejection(), None);
            }
        }
    }

    #[test]
    fn mouse_preflight_rejects_invalid_activity_readings() {
        for index in 0..MOUSE_ACTIVITY_TYPES.len() {
            for age in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                let mut sample = quiet_mouse();
                sample.activity_ages_seconds[index] = age;
                assert_eq!(sample.rejection(), Some("invalid_mouse_activity"));
            }
        }
    }

    #[test]
    fn mouse_wait_allows_click_release_to_settle() {
        let mut sample = quiet_mouse();
        let release = MOUSE_ACTIVITY_TYPES
            .iter()
            .position(|kind| matches!(kind, CGEventType::LeftMouseUp))
            .unwrap();
        for ms in (0..200).step_by(20) {
            sample.activity_ages_seconds[release] = ms as f64 / 1000.0;
            assert_eq!(sample.wait_decision(Duration::from_millis(ms)),
                MouseWaitDecision::Wait(MOUSE_POLL_INTERVAL));
        }
        sample.activity_ages_seconds[release] = 0.2;
        assert_eq!(sample.wait_decision(Duration::from_millis(200)), MouseWaitDecision::Ready);
    }

    #[test]
    fn mouse_wait_never_extends_budget_for_continued_activity_or_oversleep() {
        let mut sample = quiet_mouse();
        sample.activity_ages_seconds[0] = 0.0;
        for ms in (0..300).step_by(20) {
            assert_eq!(sample.wait_decision(Duration::from_millis(ms)),
                MouseWaitDecision::Wait(MOUSE_POLL_INTERVAL));
        }
        assert_eq!(sample.wait_decision(Duration::from_millis(295)),
            MouseWaitDecision::Wait(Duration::from_millis(5)));
        for ms in [300, 301, 3000] {
            for state in [&sample, &quiet_mouse()] {
                assert_eq!(state.wait_decision(Duration::from_millis(ms)),
                    MouseWaitDecision::Reject("mouse_wait_timeout"));
            }
        }
    }

    #[test]
    fn mouse_wait_rejects_held_buttons_and_invalid_readings_without_waiting() {
        let mut sample = quiet_mouse();
        sample.pressed_buttons.push(0);
        for ms in [0, 100, 300] {
            assert_eq!(sample.wait_decision(Duration::from_millis(ms)),
                MouseWaitDecision::Reject("mouse_button_down"));
        }
        sample.pressed_buttons.clear();
        sample.activity_ages_seconds[0] = f64::NAN;
        assert_eq!(sample.wait_decision(Duration::ZERO),
            MouseWaitDecision::Reject("invalid_mouse_activity"));
    }

    #[test]
    fn fixed_entry_filter_only_excludes_clock_and_control_center_entry() {
        for owner in ["Control Center", "控制中心"] {
            assert!(is_fixed_menu_bar_entry(owner, "Clock", ""));
            assert!(is_fixed_menu_bar_entry(owner, "BentoBox", ""));
            assert!(is_fixed_menu_bar_entry(
                owner,
                "",
                "com.apple.menuextra.clock"
            ));
            assert!(is_fixed_menu_bar_entry(
                owner,
                "",
                "com.apple.menuextra.controlcenter"
            ));
            for (title, id) in [
                ("Battery", "com.apple.menuextra.battery"),
                ("WiFi", ""),
                ("Sound", ""),
                ("", ""),
            ] {
                assert!(!is_fixed_menu_bar_entry(owner, title, id));
            }
        }
        assert!(!is_fixed_menu_bar_entry("Third Party Clock", "Clock", ""));
    }

    #[test]
    fn window_ids_keep_pointer_sized_slots_without_skipping_ids() {
        for ids in [vec![], vec![42], vec![42, 44, 46, 52765, u32::MAX]] {
            let array = window_id_array(&ids);
            assert_eq!(array.len() as usize, ids.len());
            for (index, &id) in ids.iter().enumerate() {
                let slot =
                    unsafe { CFArrayGetValueAtIndex(array.as_concrete_TypeRef(), index as isize) };
                assert_eq!(slot as usize, id as usize);
            }
        }
    }

    fn fixture(window_id: u32, x: f64, width: f64) -> MenuBarItem {
        MenuBarItem {
            window_id,
            x,
            width,
            y: 0.0,
            height: 37.0,
            owner_pid: 1,
            owner_name: String::new(),
            title: String::new(),
            accessibility_id: String::new(),
            accessibility_label: String::new(),
            stable_id: String::new(),
            on_screen: true,
            movable: true,
            hideable: true,
        }
    }

    #[test]
    fn visibility_waits_for_divider_animation_to_finish() {
        let battery = fixture(46, 1196.0, 42.0);
        let mut items = vec![battery, fixture(2, 1185.0, 26.0)];
        assert!(!item_reached_target(&items, 46, 2, false));
        items[1].x = 1170.0;
        assert!(item_reached_target(&items, 46, 2, false));
        assert!(!item_reached_target(&items, 999, 2, false));
        assert!(!item_reached_target(&items, 46, 999, false));
    }

    #[test]
    fn order_restore_requires_adjacency_not_just_the_correct_side() {
        let mut items = vec![fixture(1, -5000.0, 34.0), fixture(2, 900.0, 34.0)];
        assert!(item_reached_target(&items, 1, 2, true));
        assert!(!placement_reached(&items, 1, 2, true, true));
        items[0].x = 866.0;
        assert!(placement_reached(&items, 1, 2, true, true));
        assert!(!placement_reached(&items, 1, 2, false, true));
        items[0].x = 934.0;
        assert!(placement_reached(&items, 1, 2, false, true));
    }

    #[test]
    fn hidden_placement_uses_full_bounds_even_offscreen() {
        let mut items = vec![fixture(46, -4205.0, 42.0), fixture(2, -4163.0, 5016.0)];
        assert!(item_reached_target(&items, 46, 2, true));
        items[0].x += 10.0;
        assert!(!item_reached_target(&items, 46, 2, true));
    }
}

pub fn menu_bar_items() -> Result<Vec<MenuBarItem>, String> {
    let ids = menu_bar_window_ids()?;
    let descriptions = create_description_from_array(window_id_array(&ids))
        .ok_or_else(|| "CGWindowListCreateDescriptionFromArray failed".to_string())?;
    let mut items = Vec::with_capacity(descriptions.len().max(0) as usize);
    for dictionary in descriptions.iter() {
        let Some(window_id) = dictionary_number(&dictionary, unsafe { kCGWindowNumber }) else {
            continue;
        };
        let owner_pid = dictionary_number(&dictionary, unsafe { kCGWindowOwnerPID }).unwrap_or(0);
        let owner_name =
            dictionary_string(&dictionary, unsafe { kCGWindowOwnerName }).unwrap_or_default();
        let title = dictionary_string(&dictionary, unsafe { kCGWindowName }).unwrap_or_default();
        let Some(bounds_value) = dictionary_value(&dictionary, unsafe { kCGWindowBounds }) else {
            continue;
        };
        let Some(bounds_dictionary) = bounds_value.downcast::<CFDictionary>() else {
            continue;
        };
        let mut bounds = CGRect::new(
            &core_graphics::geometry::CGPoint::new(0.0, 0.0),
            &core_graphics::geometry::CGSize::new(0.0, 0.0),
        );
        if !unsafe {
            CGRectMakeWithDictionaryRepresentation(
                bounds_dictionary.as_concrete_TypeRef(),
                &mut bounds,
            )
        } {
            continue;
        }
        items.push(MenuBarItem {
            window_id: window_id as u32,
            owner_pid,
            stable_id: format!("{owner_name}\u{1f}{title}"),
            owner_name,
            title,
            accessibility_id: String::new(),
            accessibility_label: String::new(),
            x: bounds.origin.x,
            y: bounds.origin.y,
            width: bounds.size.width,
            height: bounds.size.height,
            on_screen: dictionary_bool(&dictionary, unsafe { kCGWindowIsOnscreen }),
            movable: true,
            hideable: true,
        });
    }
    items.sort_by(|left, right| {
        left.y
            .total_cmp(&right.y)
            .then_with(|| right.x.total_cmp(&left.x))
    });
    let control_center_pid = items
        .iter()
        .find(|item| matches!(item.owner_name.as_str(), "Control Center" | "控制中心"))
        .map(|item| item.owner_pid);
    if let Some(owner_pid) = control_center_pid {
        let labels = control_center_accessibility_items(owner_pid);
        for (accessibility_id, accessibility_label, point) in labels {
            // AX children need not follow window order (for example when the
            // recording indicator appears). Match the actual button geometry.
            let Some(item) = items.iter_mut().find(|item| {
                item.owner_pid == owner_pid
                    && point.x >= item.x
                    && point.x < item.x + item.width
                    && point.y >= item.y
                    && point.y < item.y + item.height
            }) else {
                continue;
            };
            item.accessibility_id = accessibility_id;
            item.accessibility_label = accessibility_label;
            item.stable_id = format!(
                "{}\u{1f}{}\u{1f}{}",
                item.owner_name, item.title, item.accessibility_id
            );
        }
    }
    for item in &mut items {
        let (movable, hideable) =
            item_capabilities(&item.owner_name, &item.title, &item.accessibility_id);
        item.movable = movable;
        item.hideable = hideable;
    }
    Ok(items)
}

fn targeted_mouse_event(
    source: CGEventSource,
    event_type: CGEventType,
    point: CGPoint,
    owner_pid: i32,
    window_id: u32,
    command_down: bool,
) -> Result<CGEvent, String> {
    let event = CGEvent::new_mouse_event(source, event_type, point, CGMouseButton::Left)
        .map_err(|_| "无法创建菜单栏移动事件".to_string())?;
    event.set_flags(if command_down {
        CGEventFlags::CGEventFlagCommand
    } else {
        CGEventFlags::CGEventFlagNull
    });
    event.set_integer_value_field(EventField::EVENT_TARGET_UNIX_PROCESS_ID, owner_pid as i64);
    event.set_integer_value_field(EventField::EVENT_SOURCE_USER_DATA, crate::macos_item_submenu::synthetic_marker(window_id));
    event.set_integer_value_field(
        EventField::MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER,
        window_id as i64,
    );
    event.set_integer_value_field(
        EventField::MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER_THAT_CAN_HANDLE_THIS_EVENT,
        window_id as i64,
    );
    // Private field used by WindowServer for the target menu bar window.
    event.set_integer_value_field(0x33, window_id as i64);
    Ok(event)
}

// Wait for session delivery before forwarding to the owner. Posting both back
// to back races WindowServer's drag setup, especially for off-screen windows.
fn post_menu_bar_event(event: &CGEvent, owner_pid: i32) -> Result<(), String> {
    let received = std::cell::Cell::new(false);
    let marker = event.get_integer_value_field(EventField::EVENT_SOURCE_USER_DATA);
    CGEventTap::with_enabled(
        CGEventTapLocation::Session,
        CGEventTapPlacement::TailAppendEventTap,
        CGEventTapOptions::ListenOnly,
        vec![event.get_type()],
        |_, _, incoming| {
            if !received.get()
                && incoming.get_integer_value_field(EventField::EVENT_SOURCE_USER_DATA) == marker
            {
                event.post_to_pid(owner_pid);
                received.set(true);
            }
            CallbackResult::Keep
        },
        || {
            event.post(CGEventTapLocation::Session);
            let started = std::time::Instant::now();
            while !received.get() && started.elapsed() < Duration::from_millis(100) {
                CFRunLoop::run_in_mode(
                    unsafe { kCFRunLoopDefaultMode },
                    Duration::from_millis(10),
                    true,
                );
            }
        },
    )
    .map_err(|_| "无法监听菜单栏事件，请检查辅助功能权限".to_string())?;
    if received.get() {
        Ok(())
    } else {
        Err("菜单栏事件投递超时".to_string())
    }
}

pub fn move_menu_bar_item(
    app: &tauri::AppHandle,
    window_id: u32,
    target_window_id: u32,
    place_left_of_target: bool,
    require_adjacent: bool,
) -> Result<(), String> {
    if !is_trusted() {
        return Err("请先授予 FlowHub 辅助功能权限".to_string());
    }
    let source = CGEventSource::new(CGEventSourceStateID::Private)
        .map_err(|_| "无法创建系统输入事件源".to_string())?;
    let pointer_source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "无法读取系统输入事件源".to_string())?;
    let mut moved = false;
    for _attempt in 0..3 {
        let items = menu_bar_items()?;
        let item = items
            .iter()
            .find(|item| item.window_id == window_id)
            .ok_or_else(|| "目标图标已变化，请刷新后重试".to_string())?;
        let Some(target) = items.iter().find(|item| item.window_id == target_window_id) else {
            // WindowServer may publish the replacement status-item window a few
            // frames after AppKit reports its new window number.
            thread::sleep(Duration::from_millis(80));
            continue;
        };
        if !item.movable {
            return Err("这个系统图标不能移动".to_string());
        }
        let reached = |items: &[MenuBarItem]| placement_reached(items, window_id, target_window_id, place_left_of_target, require_adjacent);
        let already_moved = reached(&items);
        if already_moved {
            moved = true;
            break;
        }

        // A negative hidden-window coordinate is clamped to the Apple menu by
        // session hit testing. Target the owning window explicitly from outside
        // the desktop, as opposed to clicking the visible menu bar underneath.
        let start = CGPoint::new(20_000.0, 20_000.0);
        let target_x = if place_left_of_target {
            target.x
        } else {
            target.x + target.width
        };
        let end = CGPoint::new(target_x, target.y + target.height / 2.0);
        let mouse_down = targeted_mouse_event(
            source.clone(),
            CGEventType::LeftMouseDown,
            start,
            item.owner_pid,
            item.window_id,
            true,
        )?;
        let mouse_up = targeted_mouse_event(
            source.clone(),
            CGEventType::LeftMouseUp,
            end,
            item.owner_pid,
            target.window_id,
            false,
        )?;

        let mut pointer_samples = Vec::new();
        // Start-only check on EVERY attempt, immediately before hiding/posting.
        // Wait synchronously up to 300ms; no queued retry or cursor guard on
        // rejection (and thus no warp). A held button is rejected immediately.
        // This is not atomic with posting and does not protect against physical
        // mouse movement during the transaction or its final cursor restore.
        let (preflight, preflight_wait, rejection) = wait_for_quiet_mouse();
        if let Some(reason) = rejection {
            crate::diagnostics::record_event(
                app,
                "menu_bar_item_move_preflight_rejected",
                serde_json::json!({
                    "windowId": window_id, "targetId": target_window_id,
                    "hidden": place_left_of_target, "attempt": _attempt,
                    "reason": reason, "retryable": true,
                    "sourceState": "HIDSystemState", "preflight": preflight,
                    "activityTypes": MOUSE_ACTIVITY_TYPES.map(|kind| format!("{kind:?}")),
                    "quietThresholdMs": MOUSE_QUIET_SECONDS * 1000.0,
                    "waitBudgetMs": MOUSE_WAIT_BUDGET.as_millis(),
                    "actualWaitMs": preflight_wait.as_millis(),
                    "protectionScope": "start-only",
                    "eventsPostedThisAttempt": false, "cursorTouchedThisAttempt": false,
                }),
            );
            return Err(match reason {
                "mouse_button_down" => "鼠标按键仍按住，本次移动未开始；请松开并静止至少 200 毫秒后重试",
                "mouse_wait_timeout" => "等待鼠标静止超时（上限 300 毫秒），本轮移动未开始；请停止移动或滚动后重试",
                _ => "无法确认鼠标空闲，本次移动未开始；请稍后重试",
            }.to_string());
        }
        // The user may have moved during the quiet wait. Restore only to the
        // position read AFTER it succeeds, never to a pre-wait position.
        let original_pointer = CGEvent::new(pointer_source.clone())
            .map_err(|_| "无法读取鼠标位置".to_string())?
            .location();
        let started = std::time::Instant::now();
        let cursor_guard = CursorMoveGuard::new(original_pointer);
        let cursor_hidden = !cursor_guard.displays.is_empty();
        let mut delivery_error = None;
        for (event, delay) in [(&mouse_down, 55_u64), (&mouse_up, 30_u64)] {
            crate::diagnostics::record_event(app, "menu_bar_item_event_post", serde_json::json!({
                "windowId": window_id, "attempt": _attempt,
                "eventType": format!("{:?}", event.get_type()),
                "submenuTracking": crate::macos_item_submenu::is_tracking(),
            }));
            if let Err(error) = post_menu_bar_event(event, item.owner_pid) {
                // Always release the synthetic button, including tap failure.
                mouse_up.post(CGEventTapLocation::Session);
                mouse_up.post_to_pid(item.owner_pid);
                thread::sleep(Duration::from_millis(30));
                delivery_error = Some(error);
                break;
            }
            for _ in 0..(delay / 10) {
                thread::sleep(Duration::from_millis(10));
                if let Ok(pointer) = CGEvent::new(pointer_source.clone()) {
                    let point = pointer.location();
                    pointer_samples.push(serde_json::json!({"x": point.x, "y": point.y}));
                }
            }
        }
        drop(cursor_guard);
        let cursor_transaction_ms = started.elapsed().as_millis();
        let pointer_restored = CGEvent::new(pointer_source.clone()).ok().map(|event| {
            let p = event.location();
            serde_json::json!({"x": p.x, "y": p.y})
        });
        // Wait for layout after releasing the cursor, not while it is hidden.
        thread::sleep(Duration::from_millis(110));
        let layout_started = std::time::Instant::now();
        let mut updated = menu_bar_items()?;
        // Status windows animate independently. Do not re-drag an item that is
        // already in place while the divider is still sliding into its final frame.
        while !reached(&updated)
            && delivery_error.is_none()
            && layout_started.elapsed() < Duration::from_millis(1000)
        {
            thread::sleep(Duration::from_millis(50));
            updated = menu_bar_items()?;
        }
        crate::diagnostics::record_event(
            app,
            "menu_bar_item_direct_move",
            serde_json::json!({
                "windowId": window_id, "targetId": target_window_id,
                "hidden": place_left_of_target, "attempt": _attempt,
                "strategy": "direct-target-synchronous-cursor-restore",
                "mousePreflight": preflight,
                "mousePreflightWaitMs": preflight_wait.as_millis(),
                "mousePreflightWaitBudgetMs": MOUSE_WAIT_BUDGET.as_millis(),
                "mousePreflightProtectionScope": "start-only",
                "mouseQuietThresholdMs": MOUSE_QUIET_SECONDS * 1000.0,
                "cursorHidden": cursor_hidden,
                "cursorTransactionMs": cursor_transaction_ms,
                "pointerRestored": pointer_restored,
                "deliveryError": delivery_error,
                "layoutWaitMs": layout_started.elapsed().as_millis(),
                "pointerBefore": {"x": original_pointer.x, "y": original_pointer.y},
                "pointerSamples": pointer_samples,
                "before": items, "after": updated,
            }),
        );
        if let Some(error) = delivery_error {
            return Err(error);
        }
        moved = reached(&updated);
        if moved {
            break;
        }
    }

    if moved {
        Ok(())
    } else {
        Err(format!(
            "macOS 未接受这次图标移动（目标分界窗口 {target_window_id}）"
        ))
    }
}

fn item_reached_target(
    items: &[MenuBarItem],
    window_id: u32,
    target_id: u32,
    hidden: bool,
) -> bool {
    let item = items.iter().find(|item| item.window_id == window_id);
    let target = items.iter().find(|item| item.window_id == target_id);
    match (item, target) {
        (Some(item), Some(target)) if hidden => item.x + item.width <= target.x + 1.0,
        (Some(item), Some(target)) => item.x + 1.0 >= target.x + target.width,
        _ => false,
    }
}

fn placement_reached(items: &[MenuBarItem], item_id: u32, target_id: u32, left: bool, adjacent: bool) -> bool {
    if !adjacent { return item_reached_target(items, item_id, target_id, left); }
    let Some(item) = items.iter().find(|i| i.window_id == item_id) else { return false };
    let Some(target) = items.iter().find(|i| i.window_id == target_id) else { return false };
    let gap = if left { target.x - (item.x + item.width) } else { item.x - (target.x + target.width) };
    (-1.0..=4.0).contains(&gap)
}

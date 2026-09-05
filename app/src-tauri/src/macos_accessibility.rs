use core_foundation::{
    array::CFArray,
    base::{CFType, CFTypeRef, TCFType},
    boolean::CFBoolean,
    dictionary::{CFDictionary, CFDictionaryRef},
    number::CFNumber,
    string::{CFString, CFStringRef},
};
use core_graphics::{
    display::CGDisplay,
    event::{CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField},
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

struct MouseLocationGuard {
    source: CGEventSource,
    point: CGPoint,
}

pub struct VisualUpdateGuard {
    hidden_displays: Vec<CGDisplay>,
}

impl VisualUpdateGuard {
    pub fn new() -> Self {
        let display_ids =
            CGDisplay::active_displays().unwrap_or_else(|_| vec![CGDisplay::main().id]);
        let hidden_displays = display_ids
            .into_iter()
            .map(CGDisplay::new)
            .filter(|display| display.hide_cursor().is_ok())
            .collect();
        Self { hidden_displays }
    }
}

impl Drop for VisualUpdateGuard {
    fn drop(&mut self) {
        for display in &self.hidden_displays {
            let _ = display.show_cursor();
        }
    }
}

impl Drop for MouseLocationGuard {
    fn drop(&mut self) {
        if let Ok(event) = CGEvent::new_mouse_event(
            self.source.clone(),
            CGEventType::MouseMoved,
            self.point,
            CGMouseButton::Left,
        ) {
            event.post(CGEventTapLocation::HID);
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

fn item_capabilities(owner_name: &str, title: &str, accessibility_id: &str) -> (bool, bool) {
    let control_center = matches!(owner_name, "Control Center" | "控制中心");
    let immovable = (control_center
        && (matches!(title, "Clock" | "BentoBox")
            || matches!(
                accessibility_id,
                "com.apple.menuextra.clock" | "com.apple.menuextra.controlcenter"
            )))
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
    event.set_integer_value_field(EventField::EVENT_SOURCE_USER_DATA, window_id as i64);
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

pub fn move_menu_bar_item(
    window_id: u32,
    target_window_id: u32,
    place_left_of_target: bool,
) -> Result<(), String> {
    if !is_trusted() {
        return Err("请先授予 FlowHub 辅助功能权限".to_string());
    }
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "无法创建系统输入事件源".to_string())?;
    let original_pointer = CGEvent::new(source.clone())
        .map_err(|_| "无法读取鼠标位置".to_string())?
        .location();
    let _mouse_location_guard = MouseLocationGuard {
        source: source.clone(),
        point: original_pointer,
    };
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
        let already_moved = if place_left_of_target {
            item.x + item.width <= target.x + 1.0
        } else {
            item.x + 1.0 >= target.x + target.width
        };
        if already_moved {
            moved = true;
            break;
        }

        let start = CGPoint::new(item.x + item.width / 2.0, item.y + item.height / 2.0);
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
        let mouse_dragged = targeted_mouse_event(
            source.clone(),
            CGEventType::LeftMouseDragged,
            end,
            item.owner_pid,
            target.window_id,
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

        mouse_down.post(CGEventTapLocation::Session);
        // Off-screen status windows are skipped by session hit testing. Deliver
        // the targeted event to their owner as well so a hidden item can start a move.
        if !item.on_screen {
            mouse_down.post_to_pid(item.owner_pid);
        }
        thread::sleep(Duration::from_millis(55));
        if item.on_screen {
            mouse_dragged.post(CGEventTapLocation::Session);
        }
        thread::sleep(Duration::from_millis(75));
        mouse_up.post(CGEventTapLocation::Session);
        if !item.on_screen {
            mouse_up.post_to_pid(item.owner_pid);
        }
        thread::sleep(Duration::from_millis(140));
        let updated = menu_bar_items()?;
        let updated_item = updated
            .iter()
            .find(|candidate| candidate.window_id == window_id);
        let updated_target = updated
            .iter()
            .find(|candidate| candidate.window_id == target_window_id);
        moved = match (updated_item, updated_target) {
            (Some(item), Some(target)) if place_left_of_target => {
                item.x + item.width <= target.x + 1.0
            }
            (Some(item), Some(target)) => item.x + 1.0 >= target.x + target.width,
            _ => false,
        };
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

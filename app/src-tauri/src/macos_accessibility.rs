use core_foundation::{
    array::CFArray,
    base::TCFType,
    boolean::CFBoolean,
    dictionary::{CFDictionary, CFDictionaryRef},
    number::CFNumber,
    string::{CFString, CFStringRef},
};
use core_graphics::{
    event::{CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField},
    event_source::{CGEventSource, CGEventSourceStateID},
    geometry::{CGPoint, CGRect},
    window::{
        create_description_from_array, kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowName,
        kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID,
    },
};
use serde::Serialize;
use std::{thread, time::Duration};

type CGSConnectionID = u32;
type CGWindowID = u32;

struct MouseLocationGuard {
    source: CGEventSource,
    point: CGPoint,
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

fn item_capabilities(owner_name: &str, title: &str) -> (bool, bool) {
    let immovable = (owner_name == "Control Center" && matches!(title, "Clock" | "BentoBox"))
        || (owner_name == "SystemUIServer" && title == "Siri");
    let non_hideable = owner_name == "Control Center"
        && matches!(title, "AudioVideoModule" | "FaceTime" | "MusicRecognition");
    (!immovable, !immovable && !non_hideable)
}

pub fn menu_bar_items() -> Result<Vec<MenuBarItem>, String> {
    let ids = menu_bar_window_ids()?;
    let descriptions = create_description_from_array(CFArray::from_copyable(&ids))
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
        let (movable, hideable) = item_capabilities(&owner_name, &title);
        items.push(MenuBarItem {
            window_id: window_id as u32,
            owner_pid,
            stable_id: format!("{owner_name}\u{1f}{title}"),
            owner_name,
            title,
            x: bounds.origin.x,
            y: bounds.origin.y,
            width: bounds.size.width,
            height: bounds.size.height,
            on_screen: dictionary_bool(&dictionary, unsafe { kCGWindowIsOnscreen }),
            movable,
            hideable,
        });
    }
    items.sort_by(|left, right| {
        left.y
            .total_cmp(&right.y)
            .then_with(|| right.x.total_cmp(&left.x))
    });
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
        let target = items
            .iter()
            .find(|item| item.window_id == target_window_id)
            .ok_or_else(|| "菜单栏分界位置不可用".to_string())?;
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
        thread::sleep(Duration::from_millis(55));
        mouse_dragged.post(CGEventTapLocation::Session);
        thread::sleep(Duration::from_millis(75));
        mouse_up.post(CGEventTapLocation::Session);
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
        Err("macOS 未接受这次图标移动，请稍后重试".to_string())
    }
}

use std::{
    ffi::{c_ulong, c_void},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Mutex, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

use crate::toggle_main;

type OSStatus = i32;
type UInt32 = u32;
type ByteCount = c_ulong;
type EventRef = *mut c_void;
type EventHandlerCallRef = *mut c_void;
type EventHandlerRef = *mut c_void;
type EventTargetRef = *mut c_void;
type EventHotKeyRef = *mut c_void;

const NO_ERR: OSStatus = 0;
const EVENT_CLASS_KEYBOARD: UInt32 = 1_801_812_322;
const EVENT_HOTKEY_PRESSED: UInt32 = 5;
const EVENT_PARAM_DIRECT_OBJECT: UInt32 = 757_935_405;
const TYPE_EVENT_HOTKEY_ID: UInt32 = 1_751_869_796;
const FLOWHUB_SIGNATURE: UInt32 = u32::from_be_bytes(*b"FHUB");
const FLOWHUB_HOTKEY_ID: UInt32 = 1;
const CG_EVENT_KEY_DOWN: UInt32 = 10;
const CG_EVENT_FLAGS_CHANGED: UInt32 = 12;
const CG_EVENT_TAP_DISABLED_BY_TIMEOUT: UInt32 = 0xffff_fffe;
const CG_EVENT_TAP_DISABLED_BY_USER_INPUT: UInt32 = 0xffff_ffff;
const CG_KEYBOARD_EVENT_AUTOREPEAT: UInt32 = 8;
const CG_KEYBOARD_EVENT_KEYCODE: UInt32 = 9;
const CG_MODIFIER_MASK: u64 = (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20);

#[repr(C, packed(2))]
#[derive(Clone, Copy)]
struct EventHotKeyId {
    signature: UInt32,
    id: UInt32,
}

#[repr(C, packed(2))]
struct EventTypeSpec {
    event_class: UInt32,
    event_kind: UInt32,
}

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn GetEventParameter(
        event: EventRef,
        name: UInt32,
        desired_type: UInt32,
        actual_type: *mut UInt32,
        buffer_size: ByteCount,
        actual_size: *mut ByteCount,
        data: *mut c_void,
    ) -> OSStatus;
    fn GetApplicationEventTarget() -> EventTargetRef;
    fn InstallEventHandler(
        target: EventTargetRef,
        handler: Option<
            unsafe extern "C" fn(EventHandlerCallRef, EventRef, *mut c_void) -> OSStatus,
        >,
        event_type_count: c_ulong,
        event_types: *const EventTypeSpec,
        user_data: *mut c_void,
        handler_ref: *mut EventHandlerRef,
    ) -> OSStatus;
    fn RegisterEventHotKey(
        key_code: UInt32,
        modifiers: UInt32,
        hotkey_id: EventHotKeyId,
        target: EventTargetRef,
        options: UInt32,
        hotkey_ref: *mut EventHotKeyRef,
    ) -> OSStatus;
    fn UnregisterEventHotKey(hotkey: EventHotKeyRef) -> OSStatus;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightListenEventAccess() -> bool;
    fn CGEventTapCreate(
        tap: UInt32,
        place: UInt32,
        options: UInt32,
        events_of_interest: u64,
        callback: Option<
            unsafe extern "C" fn(*mut c_void, UInt32, *mut c_void, *mut c_void) -> *mut c_void,
        >,
        user_info: *mut c_void,
    ) -> *mut c_void;
    fn CGEventTapEnable(tap: *mut c_void, enable: bool);
    fn CGEventGetFlags(event: *mut c_void) -> u64;
    fn CGEventGetIntegerValueField(event: *mut c_void, field: UInt32) -> i64;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFAllocatorDefault: *const c_void;
    static kCFRunLoopCommonModes: *const c_void;
    static kCFRunLoopDefaultMode: *const c_void;
    fn CFMachPortCreateRunLoopSource(
        allocator: *const c_void,
        port: *mut c_void,
        order: isize,
    ) -> *mut c_void;
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopAddSource(run_loop: *mut c_void, source: *mut c_void, mode: *const c_void);
    fn CFRunLoopRun();
}

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static EVENT_TAP_SHORTCUT: OnceLock<Mutex<Option<(UInt32, u64)>>> = OnceLock::new();
static EVENT_TAP_PORT: AtomicUsize = AtomicUsize::new(0);
static LAST_TRIGGER_MILLIS: AtomicU64 = AtomicU64::new(0);

pub(crate) struct MacHotkeyRuntime {
    hotkey_ref: Mutex<Option<usize>>,
    uses_event_tap: bool,
    // Retaining this reference keeps the Carbon event handler installed for the app lifetime.
    _handler_ref: usize,
    _event_tap_ref: Option<usize>,
    _event_tap_source: Option<usize>,
}

unsafe impl Send for MacHotkeyRuntime {}
unsafe impl Sync for MacHotkeyRuntime {}

impl MacHotkeyRuntime {
    pub(crate) fn install(app: &AppHandle) -> Result<Self, String> {
        APP_HANDLE
            .set(app.clone())
            .map_err(|_| "macOS 热键处理器已经初始化".to_string())?;

        let event_type = EventTypeSpec {
            event_class: EVENT_CLASS_KEYBOARD,
            event_kind: EVENT_HOTKEY_PRESSED,
        };
        let mut handler_ref: EventHandlerRef = std::ptr::null_mut();
        let status = unsafe {
            InstallEventHandler(
                GetApplicationEventTarget(),
                Some(handle_hotkey),
                1,
                &event_type,
                std::ptr::null_mut(),
                &mut handler_ref,
            )
        };
        if status != NO_ERR {
            return Err(format!("InstallEventHandler 失败（OSStatus {status}）"));
        }

        EVENT_TAP_SHORTCUT.get_or_init(|| Mutex::new(None));
        let listen_access = unsafe { CGPreflightListenEventAccess() };
        let (event_tap_ref, event_tap_source) = if listen_access {
            install_event_tap()
        } else {
            (None, None)
        };
        let uses_event_tap = event_tap_ref.is_some();
        println!(
            "[flowhub-tauri] macOS 输入监听权限：{listen_access}，CGEventTap：{uses_event_tap}"
        );

        Ok(Self {
            hotkey_ref: Mutex::new(None),
            uses_event_tap,
            _handler_ref: handler_ref as usize,
            _event_tap_ref: event_tap_ref,
            _event_tap_source: event_tap_source,
        })
    }

    pub(crate) fn register(&self, shortcut: Shortcut) -> Result<(), String> {
        let key_code = key_to_scancode(shortcut.key)
            .ok_or_else(|| format!("macOS 不支持该快捷键主键：{}", shortcut.key))?;
        let modifiers = carbon_modifiers(shortcut.mods);

        *EVENT_TAP_SHORTCUT
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|error| error.to_string())? =
            Some((key_code, cg_event_modifiers(shortcut.mods)));

        let mut active = self.hotkey_ref.lock().map_err(|error| error.to_string())?;
        if let Some(reference) = active.take() {
            let status = unsafe { UnregisterEventHotKey(reference as EventHotKeyRef) };
            if status != NO_ERR {
                return Err(format!("UnregisterEventHotKey 失败（OSStatus {status}）"));
            }
        }

        if self.uses_event_tap {
            return Ok(());
        }

        let mut hotkey_ref: EventHotKeyRef = std::ptr::null_mut();
        let status = unsafe {
            RegisterEventHotKey(
                key_code,
                modifiers,
                EventHotKeyId {
                    signature: FLOWHUB_SIGNATURE,
                    id: FLOWHUB_HOTKEY_ID,
                },
                GetApplicationEventTarget(),
                0,
                &mut hotkey_ref,
            )
        };
        if status != NO_ERR {
            return Err(format!("RegisterEventHotKey 失败（OSStatus {status}）"));
        }
        *active = Some(hotkey_ref as usize);
        Ok(())
    }
}

unsafe extern "C" fn handle_hotkey(
    _next_handler: EventHandlerCallRef,
    event: EventRef,
    _user_data: *mut c_void,
) -> OSStatus {
    let mut hotkey_id = EventHotKeyId {
        signature: 0,
        id: 0,
    };
    let status = GetEventParameter(
        event,
        EVENT_PARAM_DIRECT_OBJECT,
        TYPE_EVENT_HOTKEY_ID,
        std::ptr::null_mut(),
        std::mem::size_of::<EventHotKeyId>() as ByteCount,
        std::ptr::null_mut(),
        &mut hotkey_id as *mut _ as *mut c_void,
    );
    let signature = hotkey_id.signature;
    let id = hotkey_id.id;
    if status == NO_ERR && signature == FLOWHUB_SIGNATURE && id == FLOWHUB_HOTKEY_ID {
        dispatch_hotkey("Carbon");
    }
    NO_ERR
}

fn install_event_tap() -> (Option<usize>, Option<usize>) {
    let event_tap = unsafe {
        CGEventTapCreate(
            1, // kCGSessionEventTap
            0, // kCGHeadInsertEventTap
            1, // kCGEventTapOptionListenOnly
            (1_u64 << CG_EVENT_KEY_DOWN) | (1_u64 << CG_EVENT_FLAGS_CHANGED),
            Some(handle_event_tap),
            std::ptr::null_mut(),
        )
    };
    if event_tap.is_null() {
        eprintln!("[flowhub-tauri] CGEventTap 创建失败，将回退到 Carbon");
        return (None, None);
    }
    let source = unsafe { CFMachPortCreateRunLoopSource(kCFAllocatorDefault, event_tap, 0) };
    if source.is_null() {
        eprintln!("[flowhub-tauri] CGEventTap RunLoopSource 创建失败，将回退到 Carbon");
        return (None, None);
    }
    EVENT_TAP_PORT.store(event_tap as usize, Ordering::Release);
    let event_tap_address = event_tap as usize;
    let source_address = source as usize;
    std::thread::Builder::new()
        .name("flowhub-hotkey-events".to_string())
        .spawn(move || unsafe {
            let run_loop = CFRunLoopGetCurrent();
            CFRunLoopAddSource(
                run_loop,
                source_address as *mut c_void,
                kCFRunLoopCommonModes,
            );
            CFRunLoopAddSource(
                run_loop,
                source_address as *mut c_void,
                kCFRunLoopDefaultMode,
            );
            CGEventTapEnable(event_tap_address as *mut c_void, true);
            CFRunLoopRun();
        })
        .map_err(|error| eprintln!("[flowhub-tauri] CGEventTap 线程启动失败：{error}"))
        .ok();
    (Some(event_tap as usize), Some(source as usize))
}

unsafe extern "C" fn handle_event_tap(
    _proxy: *mut c_void,
    event_type: UInt32,
    event: *mut c_void,
    _user_info: *mut c_void,
) -> *mut c_void {
    if matches!(
        event_type,
        CG_EVENT_TAP_DISABLED_BY_TIMEOUT | CG_EVENT_TAP_DISABLED_BY_USER_INPUT
    ) {
        let tap = EVENT_TAP_PORT.load(Ordering::Acquire) as *mut c_void;
        if !tap.is_null() {
            CGEventTapEnable(tap, true);
        }
        return event;
    }
    if event_type == CG_EVENT_FLAGS_CHANGED {
        let key_code = CGEventGetIntegerValueField(event, CG_KEYBOARD_EVENT_KEYCODE) as UInt32;
        if matches!(key_code, 49 | 55 | 56 | 58 | 59) {
            eprintln!(
                "[flowhub-tauri] Option/Space flagsChanged：keycode={key_code} flags=0x{:x}",
                CGEventGetFlags(event)
            );
        }
        return event;
    }
    if event_type != CG_EVENT_KEY_DOWN
        || CGEventGetIntegerValueField(event, CG_KEYBOARD_EVENT_AUTOREPEAT) != 0
    {
        return event;
    }

    let key_code = CGEventGetIntegerValueField(event, CG_KEYBOARD_EVENT_KEYCODE) as UInt32;
    let modifiers = CGEventGetFlags(event) & CG_MODIFIER_MASK;
    if key_code == 40 {
        eprintln!("[flowhub-tauri] K keyDown：modifiers=0x{modifiers:x}");
    }
    let matches_shortcut = EVENT_TAP_SHORTCUT
        .get()
        .and_then(|shortcut| shortcut.lock().ok())
        .and_then(|shortcut| *shortcut)
        .is_some_and(|expected| expected == (key_code, modifiers));
    if matches_shortcut {
        dispatch_hotkey("CGEventTap");
    }
    event
}

fn dispatch_hotkey(source: &str) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let previous = LAST_TRIGGER_MILLIS.swap(now, Ordering::AcqRel);
    if now.saturating_sub(previous) < 200 {
        return;
    }
    eprintln!("[flowhub-tauri] macOS 全局快捷键已触发（{source}）");
    if let Some(app) = APP_HANDLE.get() {
        toggle_main(app);
    }
}

fn carbon_modifiers(modifiers: Modifiers) -> UInt32 {
    let mut value = 0;
    if modifiers.contains(Modifiers::SHIFT) {
        value |= 512;
    }
    if modifiers.intersects(Modifiers::SUPER | Modifiers::META) {
        value |= 256;
    }
    if modifiers.contains(Modifiers::ALT) {
        value |= 2_048;
    }
    if modifiers.contains(Modifiers::CONTROL) {
        value |= 4_096;
    }
    value
}

fn cg_event_modifiers(modifiers: Modifiers) -> u64 {
    let mut value = 0;
    if modifiers.contains(Modifiers::SHIFT) {
        value |= 1 << 17;
    }
    if modifiers.contains(Modifiers::CONTROL) {
        value |= 1 << 18;
    }
    if modifiers.contains(Modifiers::ALT) {
        value |= 1 << 19;
    }
    if modifiers.intersects(Modifiers::SUPER | Modifiers::META) {
        value |= 1 << 20;
    }
    value
}

fn key_to_scancode(code: Code) -> Option<UInt32> {
    match code {
        Code::KeyA => Some(0x00),
        Code::KeyS => Some(0x01),
        Code::KeyD => Some(0x02),
        Code::KeyF => Some(0x03),
        Code::KeyH => Some(0x04),
        Code::KeyG => Some(0x05),
        Code::KeyZ => Some(0x06),
        Code::KeyX => Some(0x07),
        Code::KeyC => Some(0x08),
        Code::KeyV => Some(0x09),
        Code::KeyB => Some(0x0b),
        Code::KeyQ => Some(0x0c),
        Code::KeyW => Some(0x0d),
        Code::KeyE => Some(0x0e),
        Code::KeyR => Some(0x0f),
        Code::KeyY => Some(0x10),
        Code::KeyT => Some(0x11),
        Code::Digit1 => Some(0x12),
        Code::Digit2 => Some(0x13),
        Code::Digit3 => Some(0x14),
        Code::Digit4 => Some(0x15),
        Code::Digit6 => Some(0x16),
        Code::Digit5 => Some(0x17),
        Code::Equal => Some(0x18),
        Code::Digit9 => Some(0x19),
        Code::Digit7 => Some(0x1a),
        Code::Minus => Some(0x1b),
        Code::Digit8 => Some(0x1c),
        Code::Digit0 => Some(0x1d),
        Code::BracketRight => Some(0x1e),
        Code::KeyO => Some(0x1f),
        Code::KeyU => Some(0x20),
        Code::BracketLeft => Some(0x21),
        Code::KeyI => Some(0x22),
        Code::KeyP => Some(0x23),
        Code::Enter => Some(0x24),
        Code::KeyL => Some(0x25),
        Code::KeyJ => Some(0x26),
        Code::Quote => Some(0x27),
        Code::KeyK => Some(0x28),
        Code::Semicolon => Some(0x29),
        Code::Backslash => Some(0x2a),
        Code::Comma => Some(0x2b),
        Code::Slash => Some(0x2c),
        Code::KeyN => Some(0x2d),
        Code::KeyM => Some(0x2e),
        Code::Period => Some(0x2f),
        Code::Tab => Some(0x30),
        Code::Space => Some(0x31),
        Code::Backquote => Some(0x32),
        Code::Backspace => Some(0x33),
        Code::Escape => Some(0x35),
        Code::CapsLock => Some(0x39),
        Code::F17 => Some(0x40),
        Code::NumpadDecimal => Some(0x41),
        Code::NumpadMultiply => Some(0x43),
        Code::NumpadAdd => Some(0x45),
        Code::PrintScreen => Some(0x46),
        Code::NumLock => Some(0x47),
        Code::NumpadDivide => Some(0x4b),
        Code::NumpadEnter => Some(0x4c),
        Code::NumpadSubtract => Some(0x4e),
        Code::F18 => Some(0x4f),
        Code::F19 => Some(0x50),
        Code::NumpadEqual => Some(0x51),
        Code::Numpad0 => Some(0x52),
        Code::Numpad1 => Some(0x53),
        Code::Numpad2 => Some(0x54),
        Code::Numpad3 => Some(0x55),
        Code::Numpad4 => Some(0x56),
        Code::Numpad5 => Some(0x57),
        Code::Numpad6 => Some(0x58),
        Code::Numpad7 => Some(0x59),
        Code::F20 => Some(0x5a),
        Code::Numpad8 => Some(0x5b),
        Code::Numpad9 => Some(0x5c),
        Code::F5 => Some(0x60),
        Code::F6 => Some(0x61),
        Code::F7 => Some(0x62),
        Code::F3 => Some(0x63),
        Code::F8 => Some(0x64),
        Code::F9 => Some(0x65),
        Code::F11 => Some(0x67),
        Code::F13 => Some(0x69),
        Code::F16 => Some(0x6a),
        Code::F14 => Some(0x6b),
        Code::F10 => Some(0x6d),
        Code::F12 => Some(0x6f),
        Code::F15 => Some(0x71),
        Code::Insert => Some(0x72),
        Code::Home => Some(0x73),
        Code::PageUp => Some(0x74),
        Code::Delete => Some(0x75),
        Code::F4 => Some(0x76),
        Code::End => Some(0x77),
        Code::F2 => Some(0x78),
        Code::PageDown => Some(0x79),
        Code::F1 => Some(0x7a),
        Code::ArrowLeft => Some(0x7b),
        Code::ArrowRight => Some(0x7c),
        Code::ArrowDown => Some(0x7d),
        Code::ArrowUp => Some(0x7e),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_space_and_standard_modifiers() {
        assert_eq!(key_to_scancode(Code::Space), Some(0x31));
        assert_eq!(
            carbon_modifiers(Modifiers::SUPER | Modifiers::SHIFT),
            256 | 512
        );
        assert_eq!(
            cg_event_modifiers(Modifiers::CONTROL | Modifiers::SHIFT),
            (1 << 18) | (1 << 17)
        );
    }
}

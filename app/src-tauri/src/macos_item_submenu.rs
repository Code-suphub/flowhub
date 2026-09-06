//! Native views for the dedicated “逐个图标控制” submenu only.
//!
//! Integration (macOS): declare this module, build a *submenu* with that exact
//! title, call `install` after assigning the native tray menu, and return early
//! from `apply_menu_bar` while `is_tracking()`, calling `defer_refresh()` first.
//! Keep the settings panel entry.
//! AppKit access and installation are main-thread-only; tracking is atomic.
//! Requires macOS 10.15+ (NSSwitch). No menu-item action is installed: the switch
//! sends its action directly to its enclosing view. We do not explicitly end
//! tracking; external synthetic events may still dismiss the native menu.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use objc2::rc::{Retained, Weak};
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSColor, NSControlSize, NSEvent, NSFont, NSImageView, NSMenu, NSMenuDelegate, NSMenuItem,
    NSRunningApplication, NSSwitch, NSTextField, NSView,
};
use objc2_foundation::{NSArray, NSObjectNSDelayedPerforming};
use objc2_foundation::{NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};

#[path = "macos_item_overlay.rs"]
mod overlay;
pub use overlay::synthetic_marker;

const WIDTH: f64 = 304.0;
const HEIGHT: f64 = 34.0;
const HEADER_HEIGHT: f64 = 26.0;
static TRACKING: AtomicUsize = AtomicUsize::new(0);
static DEFERRED_REFRESH: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct Registry {
    native_root: Option<Retained<NSMenu>>,
    serial: u64,
    generation: u64,
    delegate: Weak<ItemMenuView>,
    rows: HashMap<u32, Weak<ItemRowView>>,
}

thread_local! {
    // Never keep a menu/view alive here, and never export AppKit objects to a
    // worker. A fresh generation also invalidates completions after repopulation.
    static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default());
}

struct MenuIvars {
    app: tauri::AppHandle,
    tracking: Cell<bool>,
    menu: Weak<NSMenu>,
    scheduled: Cell<bool>,
}

impl Drop for MenuIvars {
    fn drop(&mut self) {
        if self.tracking.get() {
            TRACKING.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

define_class!(
    // NSView has no additional subclassing requirements. This header view is
    // also the delegate: NSMenuItem.view retains it, NSMenu.delegate is weak.
    #[unsafe(super = NSView)]
    #[name = "FlowHubItemMenuView"]
    #[thread_kind = MainThreadOnly]
    #[ivars = MenuIvars]
    struct ItemMenuView;

    unsafe impl NSObjectProtocol for ItemMenuView {}

    impl ItemMenuView {
        #[unsafe(method(openRoot:))]
        fn open_root(&self, _sender: Option<&objc2::runtime::AnyObject>) {
            if overlay::dismiss_if_visible() { return; }
            if let Some(menu) = self.ivars().menu.load() {
                populate(self, &menu);
                overlay::show_root(self, &menu);
            }
        }
        #[unsafe(method(auditOverlay:))]
        fn audit_overlay(&self, _sender: Option<&objc2::runtime::AnyObject>) {
            overlay::audit_layout();
        }
        #[unsafe(method(showOverlay:))]
        fn show_overlay(&self, _sender: Option<&objc2::runtime::AnyObject>) {
            self.ivars().scheduled.set(false);
            if self.ivars().tracking.get() {
                if let Some(menu) = self.ivars().menu.load() {
                    overlay::show(self, &menu);
                }
            }
        }
    }

    unsafe impl NSMenuDelegate for ItemMenuView {
        #[unsafe(method(menuNeedsUpdate:))]
        fn needs_update(&self, menu: &NSMenu) {
            if !self.ivars().tracking.get() {
                populate(self, menu);
            }
        }

        #[unsafe(method(menuWillOpen:))]
        fn will_open(&self, _menu: &NSMenu) {
            if !self.ivars().tracking.replace(true) {
                TRACKING.fetch_add(1, Ordering::AcqRel);
            }
            crate::diagnostics::record_event(
                &self.ivars().app,
                "menu_bar_submenu_opened",
                serde_json::json!({"rows": _menu.numberOfItems() - 1}),
            );
            // A reused menu view need not move to a new window. Schedule from
            // the actual opening lifecycle, after tracking has become true.
            if !overlay::is_visible() && !self.ivars().scheduled.replace(true) {
                let modes = NSArray::from_retained_slice(&[
                    NSString::from_str("NSEventTrackingRunLoopMode"),
                    NSString::from_str("NSDefaultRunLoopMode"),
                    NSString::from_str("NSRunLoopCommonModes"),
                ]);
                unsafe { self.performSelector_withObject_afterDelay_inModes(sel!(showOverlay:), None, 0.0, &modes); }
            }
        }

        #[unsafe(method(menuDidClose:))]
        fn did_close(&self, _menu: &NSMenu) {
            let busy_rows = REGISTRY.with(|registry| {
                registry
                    .borrow()
                    .rows
                    .values()
                    .filter_map(Weak::load)
                    .filter(|row| row.ivars().busy.get())
                    .count()
            });
            crate::diagnostics::record_event(
                &self.ivars().app,
                "menu_bar_submenu_closed",
                serde_json::json!({"busyRows": busy_rows, "moveActive": crate::ORGANIZER_ITEM_MOVE_ACTIVE.load(Ordering::Acquire), "refreshDeferred": DEFERRED_REFRESH.load(Ordering::Acquire)}),
            );
            if self.ivars().tracking.replace(false) {
                TRACKING.fetch_sub(1, Ordering::AcqRel);
            }
            if overlay::is_visible() { return; }
            if !DEFERRED_REFRESH.swap(false, Ordering::AcqRel) {
                return;
            }
            let app = self.ivars().app.clone();
            // run_on_main_thread may execute inline when called on the UI
            // thread. Start on a worker so it queues beyond this callback.
            tauri::async_runtime::spawn(async move {
                crate::schedule_flowhub_menu_refresh(&app);
            });
        }
    }
);

struct RowIvars {
    generation: u64,
    window_id: u32,
    hidden: Cell<bool>,
    capable: Cell<bool>,
    busy: Cell<bool>,
    switch: Retained<NSSwitch>,
    status: Retained<NSTextField>,
}

define_class!(
    #[unsafe(super = NSView)]
    #[name = "FlowHubItemRowView"]
    #[thread_kind = MainThreadOnly]
    #[ivars = RowIvars]
    struct ItemRowView;

    unsafe impl NSObjectProtocol for ItemRowView {}

    impl ItemRowView {
        // Consume clicks in the row's label/empty area instead of forwarding
        // them up the menu responder chain. NSSwitch retains its own tracking;
        // these handlers do not toggle it a second time or close the menu.
        #[unsafe(method(mouseDown:))]
        fn row_mouse_down(&self, _event: &NSEvent) {}

        #[unsafe(method(mouseDragged:))]
        fn row_mouse_dragged(&self, _event: &NSEvent) {}

        #[unsafe(method(mouseUp:))]
        fn row_mouse_up(&self, _event: &NSEvent) {}

        #[unsafe(method(toggleHidden:))]
        fn toggle_hidden(&self, _sender: &NSSwitch) {
            let iv = self.ivars();
            if iv.busy.get() || !iv.capable.get() {
                return;
            }
            if !crate::ORGANIZER_ENABLED.load(Ordering::Acquire)
                || !crate::macos_accessibility::is_trusted()
            {
                iv.switch.setState(if iv.hidden.get() { 0 } else { 1 });
                iv.switch.setEnabled(false);
                iv.status.setStringValue(&NSString::from_str("整理未启用或辅助功能权限不可用"));
                return;
            }
            let app = REGISTRY.with(|registry| {
                let registry = registry.borrow();
                if registry.generation != iv.generation {
                    return None;
                }
                registry.delegate.load().map(|d| d.ivars().app.clone())
            });
            let Some(app) = app else { return };
            // A nested native tracking loop may defer our scheduled handoff.
            // Never post the first synthetic event while still in that menu.
            if !overlay::is_visible() {
                let header = REGISTRY.with(|r| r.borrow().delegate.load());
                if let Some(header) = header {
                    if let Some(menu) = header.ivars().menu.load() {
                        overlay::show(&header, &menu);
                    }
                }
                if !overlay::is_visible() {
                    iv.switch.setState(if iv.hidden.get() { 0 } else { 1 });
                    iv.status.setStringValue(&NSString::from_str("浮层未能打开，请重新打开菜单"));
                    crate::diagnostics::record_event(&app, "menu_bar_overlay_handoff_failed", serde_json::json!({"windowId": iv.window_id, "eventsPosted": false}));
                    return;
                }
            }
            let hidden = iv.switch.state() == 0;
            crate::diagnostics::record_event(&app, "menu_bar_submenu_toggle_requested", serde_json::json!({"windowId": iv.window_id, "hidden": hidden, "tracking": is_tracking()}));
            iv.busy.set(true);
            iv.switch.setEnabled(false);
            iv.status.setStringValue(&NSString::from_str("进行中…"));
            let generation = iv.generation;
            let window_id = iv.window_id;
            tauri::async_runtime::spawn(async move {
                let result = crate::set_menu_bar_item_hidden(app.clone(), window_id, hidden).await;
                // Only Rust values cross threads. Resolve weak objects afresh on
                // the main thread; never capture a Retained or a raw pointer.
                let _ = app.run_on_main_thread(move || complete(generation, window_id, result));
            });
        }
    }
);

fn rect(x: f64, y: f64, width: f64, height: f64) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
}

fn label(text: &str, frame: NSRect, mtm: MainThreadMarker) -> Retained<NSTextField> {
    let label = NSTextField::labelWithString(&NSString::from_str(text), mtm);
    label.setFrame(frame);
    label.setMaximumNumberOfLines(1);
    label.setFont(Some(&NSFont::systemFontOfSize(12.0)));
    label
}

fn secondary_label(text: &str, frame: NSRect, mtm: MainThreadMarker) -> Retained<NSTextField> {
    let field = label(text, frame, mtm);
    field.setFont(Some(&NSFont::systemFontOfSize(10.0)));
    field.setTextColor(Some(&NSColor::secondaryLabelColor()));
    field
}

fn add_view(menu: &NSMenu, title: &str, view: &NSView, mtm: MainThreadMarker) {
    // A nil action avoids NSMenu's normal selection/dismissal path. The
    // embedded NSControl owns the interaction, per NSMenuItem.h's view API.
    let item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str(title),
            None,
            &NSString::new(),
        )
    };
    item.setEnabled(true);
    item.setView(Some(view));
    menu.addItem(&item);
}

fn message(menu: &NSMenu, text: &str, mtm: MainThreadMarker) {
    let view = NSView::initWithFrame(NSView::alloc(mtm), rect(0.0, 0.0, WIDTH, HEIGHT));
    let text_label = label(text, rect(12.0, 14.0, WIDTH - 24.0, 20.0), mtm);
    view.setToolTip(Some(&NSString::from_str(text)));
    view.addSubview(&text_label);
    add_view(menu, text, &view, mtm);
}

fn populate(delegate: &ItemMenuView, menu: &NSMenu) {
    let mtm = delegate.mtm();
    let generation = REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        registry.serial = registry
            .serial
            .checked_add(1)
            .expect("menu generation exhausted");
        registry.generation = registry.serial;
        registry.rows.clear();
        registry.generation
    });
    // Keep index zero: its view owns this delegate. No cycle back to the menu.
    while menu.numberOfItems() > 1 {
        menu.removeItemAtIndex(menu.numberOfItems() - 1);
    }
    if !crate::ORGANIZER_ENABLED.load(Ordering::Acquire) {
        message(menu, "请先启用菜单栏整理", mtm);
        return;
    }
    if !crate::macos_accessibility::is_trusted() {
        message(menu, "请先在设置中授予辅助功能权限", mtm);
        return;
    }
    let inventory = crate::organizer_window_ids()
        .and_then(|(_, boundary, always)| crate::managed_menu_bar_items(boundary, always));
    let items = match inventory {
        Ok(items) => items,
        Err(error) => {
            message(menu, &format!("读取失败：{error}"), mtm);
            return;
        }
    };
    // Deliberately retain inventory order. Completion changes only this row's
    // controls, never the menu's structure, row height, or ordering.
    for (item, section) in items {
        if crate::macos_accessibility::is_fixed_menu_bar_entry(
            &item.owner_name,
            &item.title,
            &item.accessibility_id,
        ) {
            continue;
        }
        let hidden = section == "alwaysHidden";
        let title = crate::menu_bar_item_display_name(&item);
        let switch = NSSwitch::initWithFrame(NSSwitch::alloc(mtm), rect(256.0, 7.0, 36.0, 20.0));
        switch.setControlSize(NSControlSize::Small);
        switch.setState(if hidden { 0 } else { 1 });
        let capable = item.movable && item.hideable;
        switch.setEnabled(capable);
        switch.setToolTip(Some(&NSString::from_str(&format!(
            "{title}：开：恢复原分区；关：始终隐藏"
        ))));
        let status = secondary_label(
            &row_status(section, capable),
            rect(40.0, 2.0, 208.0, 13.0),
            mtm,
        );
        let row = ItemRowView::alloc(mtm).set_ivars(RowIvars {
            generation,
            window_id: item.window_id,
            hidden: Cell::new(hidden),
            capable: Cell::new(capable),
            busy: Cell::new(false),
            switch,
            status,
        });
        // SAFETY: NSView designated initializer, with initialized Rust ivars.
        let row: Retained<ItemRowView> =
            unsafe { msg_send![super(row), initWithFrame: rect(0.0, 0.0, WIDTH, HEIGHT)] };
        let name = label(&title, rect(40.0, 16.0, 208.0, 16.0), mtm);
        row.setToolTip(Some(&NSString::from_str(&title)));
        if let Some(icon) =
            NSRunningApplication::runningApplicationWithProcessIdentifier(item.owner_pid)
                .and_then(|app| app.icon())
        {
            let image =
                NSImageView::initWithFrame(NSImageView::alloc(mtm), rect(12.0, 7.0, 20.0, 20.0));
            image.setImage(Some(&icon));
            row.addSubview(&image);
        } else {
            row.addSubview(&label(
                &title.chars().next().unwrap_or('·').to_string(),
                rect(14.0, 9.0, 18.0, 18.0),
                mtm,
            ));
        }
        row.addSubview(&name);
        row.addSubview(&row.ivars().status);
        row.addSubview(&row.ivars().switch);
        // SAFETY: the selector above has the NSControl action signature. The
        // row owns the switch, whose target is weak; both live on this thread.
        unsafe {
            row.ivars().switch.setTarget(Some(&row));
            row.ivars().switch.setAction(Some(sel!(toggleHidden:)));
        }
        REGISTRY.with(|registry| {
            registry
                .borrow_mut()
                .rows
                .insert(item.window_id, Weak::from_retained(&row));
        });
        add_view(menu, &title, &row, mtm);
    }
    if menu.numberOfItems() == 1 {
        message(menu, "暂无可控制的菜单栏图标", mtm);
    }
}

fn row_status(section: &str, capable: bool) -> String {
    let state = match section {
        "alwaysHidden" => "始终隐藏",
        "hidden" => "跟随分区",
        _ => "显示",
    };
    if capable {
        state.to_string()
    } else {
        format!("{state}（不支持移动或隐藏）")
    }
}

fn operation_result(result: Result<serde_json::Value, String>) -> Result<(), String> {
    result.and_then(|value| {
        if value.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            Ok(())
        } else {
            Err(value
                .get("reason")
                .or_else(|| value.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or("操作失败")
                .to_string())
        }
    })
}

fn complete(generation: u64, window_id: u32, result: Result<serde_json::Value, String>) {
    let row = REGISTRY.with(|registry| {
        let registry = registry.borrow();
        if registry.generation != generation || registry.delegate.load().is_none() {
            return None;
        }
        registry.rows.get(&window_id).and_then(Weak::load)
    });
    let Some(row) = row else { return };
    let iv = row.ivars();
    let outcome = operation_result(result);
    // Even an unsuccessful move may have changed geometry. Reconcile against
    // fresh inventory instead of trusting either the request or its old state.
    let actual = crate::organizer_window_ids()
        .and_then(|(_, boundary, always)| crate::managed_menu_bar_items(boundary, always))
        .and_then(|items| {
            items
                .into_iter()
                .find(|(item, _)| item.window_id == window_id)
                .ok_or_else(|| "清单中已找不到此图标".to_string())
        });
    let status = match actual {
        Ok((item, section)) => {
            iv.hidden.set(section == "alwaysHidden");
            iv.capable.set(
                item.movable
                    && item.hideable
                    && !crate::macos_accessibility::is_fixed_menu_bar_entry(
                        &item.owner_name,
                        &item.title,
                        &item.accessibility_id,
                    ),
            );
            row_status(section, iv.capable.get())
        }
        Err(error) => {
            // Keep the last confirmed switch position, explicitly mark it as
            // stale, and require reopening/reloading before another operation.
            iv.capable.set(false);
            format!("状态待确认（开关保留上次状态）：{error}")
        }
    };
    let status = match outcome {
        Ok(()) => status,
        Err(error) => format!("{status}；操作失败：{error}"),
    };
    iv.switch.setState(if iv.hidden.get() { 0 } else { 1 });
    iv.status.setStringValue(&NSString::from_str(&status));
    iv.status.setToolTip(Some(&NSString::from_str(&status)));
    iv.busy.set(false);
    iv.switch.setEnabled(
        iv.capable.get()
            && crate::ORGANIZER_ENABLED.load(Ordering::Acquire)
            && crate::macos_accessibility::is_trusted(),
    );
}

fn find_submenu(menu: &NSMenu) -> Option<Retained<NSMenu>> {
    for index in 0..menu.numberOfItems() {
        let Some(item) = menu.itemAtIndex(index) else {
            continue;
        };
        if let Some(submenu) = item.submenu() {
            if item.title().to_string() == "逐个图标控制" {
                return Some(submenu);
            }
            if let Some(found) = find_submenu(&submenu) {
                return Some(found);
            }
        }
    }
    None
}

/// Call only on the main thread, after the parent tray menu has been assigned.
pub fn install(app: &tauri::AppHandle, tray: &tray_icon::TrayIcon) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("原生子菜单必须在主线程安装")?;
    if is_tracking() {
        return Err("逐个图标控制正在跟踪，关闭后再安装".to_string());
    }
    let root = tray
        .ns_status_item()
        .and_then(|status| status.menu(mtm))
        .ok_or("托盘原生菜单尚未创建")?;
    let menu = find_submenu(&root).ok_or("未找到标题为逐个图标控制的子菜单")?;
    let header = ItemMenuView::alloc(mtm).set_ivars(MenuIvars {
        app: app.clone(),
        tracking: Cell::new(false),
        menu: Weak::from_retained(&menu),
        scheduled: Cell::new(false),
    });
    // SAFETY: NSView designated initializer with initialized ivars.
    let header: Retained<ItemMenuView> =
        unsafe { msg_send![super(header), initWithFrame: rect(0.0, 0.0, WIDTH, HEADER_HEIGHT)] };
    header.addSubview(&secondary_label(
        "开：恢复原分区  ·  关：始终隐藏",
        rect(12.0, 6.0, WIDTH - 24.0, 14.0),
        mtm,
    ));
    // Only the explicitly dedicated submenu is replaced. Parent muda delegates
    // and all other entry points (including the settings panel) are untouched.
    menu.setDelegate(None);
    menu.removeAllItems();
    menu.setAutoenablesItems(false);
    add_view(&menu, "逐个图标控制", &header, mtm);
    REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        registry.delegate = Weak::from_retained(&header);
        registry.native_root = Some(root);
        registry.rows.clear();
    });
    menu.setDelegate(Some(ProtocolObject::from_ref(&*header)));
    if let Some(button) = tray.ns_status_item().and_then(|status| status.button(mtm)) {
        overlay::set_anchor(&button);
        // Use the same cascade from the FIRST click; hovering never replaces
        // native ancestors with newly positioned windows.
        if let Some(status) = tray.ns_status_item() { status.setMenu(None); }
        // tray-icon installs an input-catching child view over this button.
        // Retain it for the library's sizing/lifetime bookkeeping, but route
        // this main item's clicks through our button action instead.
        if let Some(class) = objc2::runtime::AnyClass::get(c"TaoTrayTarget") {
            for view in button.subviews() {
                if view.isKindOfClass(class) { view.setHidden(true); }
            }
        }
        unsafe {
            button.setTarget(Some(&header));
            button.setAction(Some(sel!(openRoot:)));
            button.sendActionOn(objc2_app_kit::NSEventMask::LeftMouseUp | objc2_app_kit::NSEventMask::RightMouseUp);
        }
    }
    Ok(())
}

/// True between this submenu's menuWillOpen/menuDidClose callbacks. This does
/// not claim to track ancestors: their existing muda delegates remain intact.
pub fn is_tracking() -> bool {
    TRACKING.load(Ordering::Acquire) != 0 || overlay::is_visible()
}

/// Mark a refresh skipped by apply_menu_bar. May be called from any thread.
/// Closing this submenu queues a refresh only when this flag was set.
pub fn defer_refresh() {
    DEFERRED_REFRESH.store(true, Ordering::Release);
}

/// Explicit app/diagnostic entry point; uses the same attached cascade as the menu.
pub fn open_controls(app: &tauri::AppHandle) {
    let _ = app.run_on_main_thread(|| {
        if overlay::is_visible() {
            return;
        }
        let header = REGISTRY.with(|r| r.borrow().delegate.load());
        if let Some(header) = header {
            if let Some(menu) = header.ivars().menu.load() {
                populate(&header, &menu);
                overlay::show(&header, &menu);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn section_and_capability_labels() {
        assert_eq!(row_status("hidden", true), "跟随分区");
        assert_eq!(row_status("alwaysHidden", true), "始终隐藏");
        assert_eq!(row_status("visible", true), "显示");
        assert!(row_status("visible", false).contains("不支持移动或隐藏"));
    }

    #[test]
    fn unsuccessful_value_is_an_error() {
        assert_eq!(
            operation_result(Ok(serde_json::json!({"ok": false, "reason": "移动失败"}))),
            Err("移动失败".to_string())
        );
        assert!(operation_result(Ok(serde_json::json!({}))).is_err());
        assert!(operation_result(Ok(serde_json::json!({"ok": true}))).is_ok());
        assert_eq!(
            operation_result(Err("无法移动".to_string())),
            Err("无法移动".to_string())
        );
    }
}

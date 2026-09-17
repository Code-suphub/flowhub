//! Persistent, nonactivating menu cascade. Never suppresses physical input.
//! Only this app's explicitly tagged synthetic events are ignored for dismissal.
use super::*;
use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2::Message;
use objc2::AnyThread;
use objc2_app_kit::{
    NSBackingStoreType, NSBezierPath, NSImage, NSButton, NSEventMask, NSEventType, NSPanel, NSScreen, NSScrollView,
    NSStatusBarButton, NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState,
    NSVisualEffectView, NSWindowStyleMask,
};
use objc2_app_kit::{NSWorkspace, NSWorkspaceDidActivateApplicationNotification};
use objc2_foundation::{NSNotification, NSOperationQueue};
use objc2_app_kit::{NSTrackingArea, NSTrackingAreaOptions};
use std::ptr::NonNull;

static VISIBLE: AtomicBool = AtomicBool::new(false);
const MARKER: i64 = 0x4648_5542_0000_0000;
pub fn synthetic_marker(window: u32) -> i64 {
    MARKER | window as i64
}
pub fn is_visible() -> bool {
    VISIBLE.load(Ordering::Acquire)
}
pub(super) fn dismiss_if_visible() -> bool {
    let was_visible = is_visible();
    if was_visible { close("status-item-toggle"); }
    was_visible
}

static SESSION_REVISION: AtomicUsize = AtomicUsize::new(0);
static HOVER_REVISION: AtomicUsize = AtomicUsize::new(0);

fn leave_timeout(left_at: &mut Option<u64>, now_ms: u64, inside: bool) -> bool {
    if inside { *left_at = None; return false; }
    now_ms.saturating_sub(*left_at.get_or_insert(now_ms)) >= 500
}

fn watch_pointer(app: tauri::AppHandle) {
    let revision = SESSION_REVISION.fetch_add(1, Ordering::AcqRel) + 1;
    tauri::async_runtime::spawn(async move {
        while SESSION_REVISION.load(Ordering::Acquire) == revision {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let (sender, receiver) = tokio::sync::oneshot::channel();
            if app.run_on_main_thread(move || {
                if SESSION_REVISION.load(Ordering::Acquire) != revision { let _ = sender.send(()); return; }
                let should_close = SESSION.with(|state| {
                    let mut state = state.borrow_mut();
                    let Some(session) = state.as_mut() else { return false; };
                    if crate::menu_bar::organizer_item_move_active() {
                        session.pointer_left_at = None;
                        return false;
                    }
                    let point = NSEvent::mouseLocation();
                    let contains = |frame: NSRect| point.x >= frame.origin.x && point.x <= frame.origin.x + frame.size.width
                        && point.y >= frame.origin.y && point.y <= frame.origin.y + frame.size.height;
                    let inside = session.panels.iter().any(|panel| panel.isVisible() && contains(panel.frame()))
                        || ANCHOR.with(|anchor| anchor.borrow().load().and_then(|button| button.window()).is_some_and(|window| contains(window.frame())));
                    leave_timeout(&mut session.pointer_left_at, session.opened_at.elapsed().as_millis() as u64, inside)
                });
                if should_close { close("pointer-left-timeout"); }
                let _ = sender.send(());
            }).is_err() { break; }
            if receiver.await.is_err() { break; }
        }
    });
}

fn reveal(depth: usize, submenu: bool, index: isize) {
    let revision = HOVER_REVISION.fetch_add(1, Ordering::AcqRel) + 1;
    if submenu { reveal_now(depth, submenu, index); return; }
    let app = SESSION.with(|state| state.borrow().as_ref().map(|session| session.app.clone()));
    if let Some(app) = app {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let _ = app.run_on_main_thread(move || {
                if HOVER_REVISION.load(Ordering::Acquire) != revision { return; }
                let over_child = SESSION.with(|state| state.borrow().as_ref().is_some_and(|session| {
                    let point = NSEvent::mouseLocation();
                    session.panels.iter().skip(depth + 1).any(|panel| {
                        let frame = panel.frame();
                        panel.isVisible() && point.x >= frame.origin.x && point.x <= frame.origin.x + frame.size.width
                            && point.y >= frame.origin.y && point.y <= frame.origin.y + frame.size.height
                    })
                }));
                if !over_child { reveal_now(depth, false, index); }
            });
        });
    }
}

fn reveal_now(depth: usize, submenu: bool, index: isize) {
    ACTION_ROWS.with(|rows| {
        for row in rows.borrow().iter().filter_map(Weak::load) {
            if row.ivars().depth >= depth {
                row.set_selected(row.ivars().depth == depth && row.ivars().index == index);
            }
        }
    });
    SESSION.with(|state| {
        if let Some(s) = state.borrow().as_ref() {
            let frames_before: Vec<_> = s.panels.iter().map(|p| p.frame()).collect();
            for (i, child) in s.panels.iter().enumerate().skip(depth + 1) {
                if submenu && i == depth + 1 { child.makeKeyAndOrderFront(None); }
                else { child.orderOut(None); }
            }
            crate::diagnostics::record_event(&s.app, "menu_bar_overlay_reveal", serde_json::json!({
                "depth": depth, "submenu": submenu,
                "ancestorFramesUnchanged": s.panels.iter().enumerate().take(depth + 1).all(|(i,p)| p.frame() == frames_before[i])
            }));
        }
    });
}

struct Session {
    app: tauri::AppHandle,
    opened_at: std::time::Instant,
    pointer_left_at: Option<u64>,
    panels: Vec<Retained<MenuPanel>>,
    // Keep original menu targets/delegate alive for actions and completions.
    _root: Retained<NSMenu>,
    _header: Retained<ItemMenuView>,
    monitors: Vec<Retained<AnyObject>>,
    activation: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    rows: Vec<Retained<NSView>>,
}
thread_local! {
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
    static ACTION_ROWS: RefCell<Vec<Weak<ActionRow>>> = const { RefCell::new(Vec::new()) };
    static ANCHOR: RefCell<Weak<NSStatusBarButton>> = RefCell::new(Weak::default());
}
pub fn set_anchor(button: &Retained<NSStatusBarButton>) {
    ANCHOR.with(|a| *a.borrow_mut() = Weak::from_retained(button));
}

define_class!(
    #[unsafe(super = NSPanel)]
    #[name = "FlowHubItemCascadePanel"]
    #[thread_kind = MainThreadOnly]
    struct MenuPanel;
    unsafe impl NSObjectProtocol for MenuPanel {}
    impl MenuPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key(&self) -> bool { true }
        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main(&self) -> bool { false }
    }
);

struct ActionIvars {
    menu: Retained<NSMenu>,
    index: isize,
    depth: usize,
    button: Retained<NSButton>,
    highlight: Retained<NSVisualEffectView>,
    arrow: Option<Retained<NSTextField>>,
}
define_class!(
    #[unsafe(super = NSView)]
    #[name = "FlowHubCascadeActionRow"]
    #[thread_kind = MainThreadOnly]
    #[ivars = ActionIvars]
    struct ActionRow;
    unsafe impl NSObjectProtocol for ActionRow {}
    impl ActionRow {
        #[unsafe(method(mouseEntered:))]
        fn mouse_entered(&self, _event: &NSEvent) {
            let iv = self.ivars();
            let submenu = iv.menu.itemAtIndex(iv.index).is_some_and(|item| item.isEnabled() && item.submenu().is_some());
            reveal(iv.depth, submenu, iv.index);
        }
        #[unsafe(method(mouseExited:))]
        fn mouse_exited(&self, _event: &NSEvent) {
            let iv = self.ivars();
            if !iv.menu.itemAtIndex(iv.index).is_some_and(|item| item.isEnabled() && item.submenu().is_some()) {
                self.set_selected(false);
            }
        }
        #[unsafe(method(activate:))]
        fn activate(&self, _sender: &NSButton) {
            let iv = self.ivars();
            let Some(item) = iv.menu.itemAtIndex(iv.index) else { return };
            if !item.isEnabled() { return; }
            if item.submenu().is_some() {
                // A physical click first enters the row; do not immediately
                // undo the submenu opened by mouseEntered.
                reveal(iv.depth, true, iv.index);
            } else {
                let menu = iv.menu.clone();
                let index = iv.index;
                close("menu-action");
                menu.performActionForItemAtIndex(index);
            }
        }
    }
);

impl ActionRow {
    fn set_selected(&self, selected: bool) {
        let iv = self.ivars();
        let enabled = iv.menu.itemAtIndex(iv.index).is_some_and(|item| item.isEnabled());
        let selected = selected && enabled;
        iv.highlight.setHidden(!selected);
        let color = if selected { NSColor::selectedMenuItemTextColor() }
            else if enabled { NSColor::labelColor() } else { NSColor::disabledControlTextColor() };
        iv.button.setContentTintColor(Some(&color));
        if let Some(arrow) = &iv.arrow { arrow.setTextColor(Some(&color)); }
    }
}

fn rounded_mask(size: NSSize, radius: f64) -> Retained<NSImage> {
    let image = NSImage::initWithSize(NSImage::alloc(), size);
    #[allow(deprecated)]
    image.lockFocus();
    NSColor::whiteColor().setFill();
    NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(rect(0.0, 0.0, size.width, size.height), radius, radius).fill();
    #[allow(deprecated)]
    image.unlockFocus();
    image
}

fn close(reason: &str) {
    SESSION_REVISION.fetch_add(1, Ordering::AcqRel);
    HOVER_REVISION.fetch_add(1, Ordering::AcqRel);
    let session = SESSION.with(|state| state.borrow_mut().take());
    let Some(session) = session else { return };
    VISIBLE.store(false, Ordering::Release);
    ACTION_ROWS.with(|rows| rows.borrow_mut().clear());
    for monitor in &session.monitors {
        // Tokens belong to this session only. Real input is never consumed.
        unsafe {
            NSEvent::removeMonitor(monitor);
        }
    }
    if let Some(observer) = &session.activation {
        unsafe {
            NSWorkspace::sharedWorkspace()
                .notificationCenter()
                .removeObserver(AsRef::<AnyObject>::as_ref(&**observer));
        }
    }
    for panel in &session.panels {
        panel.orderOut(None);
    }
    crate::diagnostics::record_event(
        &session.app,
        "menu_bar_overlay_closed",
        serde_json::json!({"reason": reason}),
    );
    if DEFERRED_REFRESH.swap(false, Ordering::AcqRel) {
        let app = session.app.clone();
        tauri::async_runtime::spawn(async move {
            crate::menu_bar::schedule_flowhub_menu_refresh(&app);
        });
    }
}

fn is_own_synthetic(event: &NSEvent) -> bool {
    // NSEvent's CGEvent pointer is borrowed and used only within this callback.
    unsafe extern "C" {
        fn CGEventGetIntegerValueField(event: *mut std::ffi::c_void, field: u32) -> i64;
    }
    let cg: *mut std::ffi::c_void = unsafe { msg_send![event, CGEvent] };
    if cg.is_null() {
        return false;
    }
    let marker = unsafe { CGEventGetIntegerValueField(cg, 42) };
    let pid = unsafe { CGEventGetIntegerValueField(cg, 41) };
    matches_synthetic(marker, pid, std::process::id())
}
fn matches_synthetic(marker: i64, pid: i64, own_pid: u32) -> bool {
    (marker & !0xffff_ffff) == MARKER && pid == i64::from(own_pid)
}

fn observe(event: &NSEvent, global: bool) -> bool {
    if !is_visible() {
        return false;
    }
    if is_own_synthetic(event) {
        SESSION.with(|state| {
            if let Some(s) = state.borrow().as_ref() {
                crate::diagnostics::record_event(
                    &s.app,
                    "menu_bar_overlay_ignored_synthetic",
                    serde_json::json!({"global": global}),
                );
            }
        });
        return false;
    }
    if event.r#type() == NSEventType::KeyDown {
        if event.keyCode() == 53 {
            close("escape");
            return true;
        }
        return false;
    }
    let anchor_click = !global && ANCHOR.with(|a| a.borrow().load().and_then(|b| b.window()).is_some_and(|w| w.windowNumber() == event.windowNumber()));
    let inside = anchor_click || !global
        && SESSION.with(|state| {
            state.borrow().as_ref().is_some_and(|s| {
                s.panels
                    .iter()
                    .any(|panel| panel.isVisible() && panel.windowNumber() == event.windowNumber())
            })
        });
    if !inside {
        close("outside-click");
    }
    false
}

fn panel(frame: NSRect, content: &NSView, mtm: MainThreadMarker) -> Retained<MenuPanel> {
    let allocated = MenuPanel::alloc(mtm).set_ivars(());
    let panel: Retained<MenuPanel> = unsafe {
        msg_send![super(allocated),
        initWithContentRect: frame,
        styleMask: NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
        backing: NSBackingStoreType::Buffered, defer: false]
    };
    unsafe {
        panel.setReleasedWhenClosed(false);
    }
    panel.setHidesOnDeactivate(false);
    panel.setFloatingPanel(true);
    panel.setLevel(101); // Above the status-menu level, scoped to this session.
    panel.setHasShadow(true);
    panel.setOpaque(false);
    panel.setBackgroundColor(Some(&NSColor::clearColor()));
    let background = NSVisualEffectView::initWithFrame(
        NSVisualEffectView::alloc(mtm),
        rect(0.0, 0.0, frame.size.width, frame.size.height),
    );
    background.setMaterial(NSVisualEffectMaterial::Menu);
    background.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
    background.setState(NSVisualEffectState::Active);
    background.setMaskImage(Some(&rounded_mask(frame.size, 8.0)));
    background.setWantsLayer(true);
    let layer: Option<Retained<AnyObject>> = unsafe { msg_send![&background, layer] };
    if let Some(layer) = layer {
        let _: () = unsafe { msg_send![&layer, setCornerRadius: 8.0_f64] };
        let _: () = unsafe { msg_send![&layer, setMasksToBounds: true] };
    }
    background.addSubview(content);
    panel.setContentView(Some(&background));
    panel
}

fn menu_content(
    menu: &NSMenu,
    width: f64,
    depth: usize,
    mtm: MainThreadMarker,
) -> (Retained<NSView>, f64) {
    let height = (0..menu.numberOfItems())
        .filter_map(|i| menu.itemAtIndex(i))
        .map(|item| if item.isSeparatorItem() { 9.0 } else { 27.0 })
        .sum::<f64>()
        + 12.0;
    let content = NSView::initWithFrame(NSView::alloc(mtm), rect(0.0, 0.0, width, height));
    let mut y = height - 6.0;
    for index in 0..menu.numberOfItems() {
        let Some(item) = menu.itemAtIndex(index) else {
            continue;
        };
        if item.isSeparatorItem() {
            y -= 9.0;
            let line = NSVisualEffectView::initWithFrame(
                NSVisualEffectView::alloc(mtm),
                rect(10.0, y + 4.0, width - 20.0, 1.0),
            );
            line.setMaterial(NSVisualEffectMaterial::Selection);
            content.addSubview(&line);
            continue;
        }
        y -= 27.0;
        let button = NSButton::initWithFrame(NSButton::alloc(mtm), rect(8.0, 0.0, width - 36.0, 27.0));
        let highlight = NSVisualEffectView::initWithFrame(NSVisualEffectView::alloc(mtm), rect(0.0, 0.0, width - 12.0, 27.0));
        highlight.setMaterial(NSVisualEffectMaterial::Selection);
        highlight.setBlendingMode(NSVisualEffectBlendingMode::WithinWindow);
        highlight.setState(NSVisualEffectState::Active);
        highlight.setEmphasized(true);
        highlight.setMaskImage(Some(&rounded_mask(NSSize::new(width - 12.0, 27.0), 4.0)));
        highlight.setHidden(true);
        let arrow = item.submenu().map(|_| label("›", rect(width - 35.0, 5.0, 14.0, 18.0), mtm));
        let row = ActionRow::alloc(mtm).set_ivars(ActionIvars {
            menu: menu.retain(), index, depth, button: button.clone(), highlight: highlight.clone(), arrow: arrow.clone(),
        });
        let row: Retained<ActionRow> = unsafe { msg_send![super(row), initWithFrame: rect(6.0, y, width - 12.0, 27.0)] };
        row.addSubview(&highlight);
        row.set_selected(false);
        ACTION_ROWS.with(|rows| rows.borrow_mut().push(Weak::from_retained(&row)));
        button.setTitle(&item.title());
        button.setBordered(false);
        button.setFont(Some(&NSFont::systemFontOfSize(13.0)));
        button.setAlignment(objc2_app_kit::NSTextAlignment::Left);
        button.setEnabled(item.isEnabled());
        unsafe {
            button.setTarget(Some(&row));
            button.setAction(Some(sel!(activate:)));
        }
        row.addSubview(&button);
        let tracking = unsafe { NSTrackingArea::initWithRect_options_owner_userInfo(
            NSTrackingArea::alloc(), row.bounds(),
            NSTrackingAreaOptions::MouseEnteredAndExited | NSTrackingAreaOptions::ActiveAlways,
            Some(&row), None) };
        row.addTrackingArea(&tracking);
        if let Some(arrow) = arrow { row.addSubview(&arrow); }
        content.addSubview(&row);
    }
    (content, height)
}

pub(super) fn show(header: &ItemMenuView, menu: &NSMenu) {
    show_cascade(header, menu, 2);
}
pub(super) fn show_root(header: &ItemMenuView, menu: &NSMenu) {
    show_cascade(header, menu, 0);
}
fn show_cascade(header: &ItemMenuView, menu: &NSMenu, initial_depth: usize) {
    if is_visible() {
        return;
    }
    let Some(parent) = (unsafe { menu.supermenu() }) else {
        return;
    };
    let Some(root) = (unsafe { parent.supermenu() }) else {
        return;
    };
    // The source menu may outlive a divider toggle; refresh this dynamic label
    // when opening, without rebuilding any already-visible ancestor panel.
    if let Some(toggle) = parent.itemAtIndex(0) {
        let title = if !crate::menu_bar::organizer_enabled() {
            "启用隐藏分区"
        } else if crate::menu_bar::organizer_collapsed() {
            "展开隐藏区"
        } else {
            "收起隐藏区"
        };
        toggle.setTitle(&NSString::from_str(title));
    }
    let mtm = header.mtm();
    let Some(anchor) = ANCHOR.with(|a| {
        a.borrow().load().and_then(|button| {
            button.window().map(|window| {
                window.convertRectToScreen(button.convertRect_toView(button.bounds(), None))
            })
        })
    }) else {
        return;
    };
    let screens = NSScreen::screens(mtm);
    let screen = screens
        .iter()
        .find(|s| contains(s.frame(), anchor.origin))
        .or_else(|| screens.firstObject());
    let Some(screen) = screen else { return };
    let bounds = screen.visibleFrame();
    // Measure the short organizer commands instead of imposing a 180 pt menu.
    let parent_width = (0..parent.numberOfItems())
        .filter_map(|index| parent.itemAtIndex(index))
        .filter(|item| !item.isSeparatorItem())
        .map(|item| {
            let field = label(&item.title().to_string(), rect(0.0, 0.0, 0.0, 20.0), mtm);
            field.setFont(Some(&NSFont::systemFontOfSize(13.0)));
            field.sizeToFit();
            field.frame().size.width + 48.0 // text inset, submenu arrow, outer padding
        })
        .fold(136.0_f64, f64::max).ceil();
    let widths = [root.size().width.max(180.0), parent_width, WIDTH];
    let (root_view, root_height) = menu_content(&root, widths[0], 0, mtm);
    let (parent_view, parent_height) = menu_content(&parent, widths[1], 1, mtm);
    // NSMenu continues laying out its item views while tracking unwinds.
    // Remove its ownership BEFORE reparenting; otherwise every row can be
    // reset to (0, 0) after we have positioned it in the document view.
    // Keep the native header/delegate in its original item for future opens.
    let rows: Vec<_> = (1..menu.numberOfItems()).filter_map(|i| {
        let item = menu.itemAtIndex(i)?;
        let view = item.view()?;
        item.setView(None);
        view.removeFromSuperview();
        Some(view)
    }).collect();
    let list_height = HEADER_HEIGHT + rows.len() as f64 * HEIGHT + 12.0;
    let vertical = bounds.size.width < widths.iter().sum::<f64>() + 20.0;
    let viewport_height = list_height.min(
        (bounds.size.height
            - 12.0
            - if vertical {
                root_height + parent_height + 8.0
            } else {
                0.0
            })
        .max(80.0),
    );
    let list = NSView::initWithFrame(NSView::alloc(mtm), rect(0.0, 0.0, WIDTH, list_height));
    list.addSubview(&secondary_label("开：恢复原分区  ·  关：始终隐藏", rect(12.0, list_height - 26.0, WIDTH - 24.0, 14.0), mtm));
    for (index, view) in rows.iter().enumerate() {
        view.setTranslatesAutoresizingMaskIntoConstraints(true);
        view.setAutoresizingMask(objc2_app_kit::NSAutoresizingMaskOptions::ViewNotSizable);
        view.setFrame(rect(0.0, list_height - 6.0 - HEADER_HEIGHT - (index + 1) as f64 * HEIGHT, WIDTH, HEIGHT));
        list.addSubview(view);
    }
    let scroll = NSScrollView::initWithFrame(
        NSScrollView::alloc(mtm),
        rect(0.0, 0.0, WIDTH, viewport_height),
    );
    scroll.setDrawsBackground(false);
    scroll.setHasVerticalScroller(list_height > viewport_height);
    scroll.setAutohidesScrollers(true);
    scroll.setDocumentView(Some(&list));
    list.scrollPoint(NSPoint::new(0.0, (list_height - viewport_height).max(0.0)));
    let mut frames = cascade_frames(
        anchor,
        bounds,
        [root_height, parent_height, viewport_height],
        widths,
    );
    if !vertical {
        // Cascade from each submenu's actual entry row, not the status bar top.
        let offset = |menu: &NSMenu| {
            let mut y = 6.0;
            for i in 0..menu.numberOfItems() {
                if let Some(item) = menu.itemAtIndex(i) {
                    if item.submenu().is_some() { break; }
                    y += if item.isSeparatorItem() { 9.0 } else { 27.0 };
                }
            }
            y
        };
        let parent_top = frames[0].origin.y + root_height - offset(&root);
        frames[1].origin.y = (parent_top - parent_height).max(bounds.origin.y + 6.0);
        frames[2].origin.y = (parent_top - offset(&parent) - viewport_height).max(bounds.origin.y + 6.0);
    }
    let panels = vec![
        panel(frames[0], &root_view, mtm),
        panel(frames[1], &parent_view, mtm),
        panel(frames[2], &scroll, mtm),
    ];
    ACTION_ROWS.with(|rows| {
        for row in rows.borrow().iter().filter_map(Weak::load) {
            let iv = row.ivars();
            row.set_selected(iv.depth < initial_depth && iv.menu.itemAtIndex(iv.index).is_some_and(|item| item.submenu().is_some()));
        }
    });
    for (panel, title) in panels
        .iter()
        .zip(["FlowHub 菜单", "菜单栏整理", "逐个图标控制"])
    {
        panel.setTitle(&NSString::from_str(title));
    }
    // Install session BEFORE ending native tracking; menuDidClose must not trigger a rebuild.
    VISIBLE.store(true, Ordering::Release);
    SESSION.with(|state| {
        *state.borrow_mut() = Some(Session {
            app: header.ivars().app.clone(),
            opened_at: std::time::Instant::now(),
            pointer_left_at: None,
            panels,
            _root: root.clone(),
            _header: header.retain(),
            monitors: vec![],
            activation: None,
            rows,
        })
    });
    watch_pointer(header.ivars().app.clone());
    root.cancelTrackingWithoutAnimation();
    let activation = RcBlock::new(|_: NonNull<NSNotification>| {
        if NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .is_some_and(|app| app.processIdentifier() != std::process::id() as i32)
        {
            close("application-switch");
        }
    });
    let observer = unsafe {
        NSWorkspace::sharedWorkspace()
            .notificationCenter()
            .addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidActivateApplicationNotification),
                None,
                Some(&NSOperationQueue::mainQueue()),
                &activation,
            )
    };
    let mask = NSEventMask::LeftMouseDown
        | NSEventMask::RightMouseDown
        | NSEventMask::OtherMouseDown
        | NSEventMask::KeyDown;
    let local = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
        if observe(unsafe { event.as_ref() }, false) {
            std::ptr::null_mut()
        } else {
            event.as_ptr()
        }
    });
    let global = RcBlock::new(|event: NonNull<NSEvent>| {
        observe(unsafe { event.as_ref() }, true);
    });
    let monitors = [
        unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &local) },
        NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &global),
    ]
    .into_iter()
    .flatten()
    .collect();
    SESSION.with(|state| {
        if let Some(s) = state.borrow_mut().as_mut() {
            s.monitors = monitors;
            s.activation = Some(observer);
            for panel in s.panels.iter().take(initial_depth + 1) {
                panel.orderFrontRegardless();
            }
            s.panels[initial_depth].makeKeyAndOrderFront(None);
            crate::diagnostics::record_event(
                &s.app,
                "menu_bar_overlay_opened",
                serde_json::json!({"rows": menu.numberOfItems() - 1, "panels": 3, "initialDepth": initial_depth}),
            );
        }
    });
    unsafe { header.performSelector_withObject_afterDelay(sel!(auditOverlay:), None, 0.3); }
}

pub(super) fn audit_layout() {
    SESSION.with(|state| {
        if let Some(s) = state.borrow().as_ref() {
            let frames: Vec<_> = s.rows.iter().map(|row| row.frame()).collect();
            let separated = frames.windows(2).all(|pair| pair[0].origin.y >= pair[1].origin.y + pair[1].size.height);
            crate::diagnostics::record_event(&s.app, "menu_bar_overlay_layout", serde_json::json!({
                "rowCount": frames.len(), "rowsSeparated": separated,
                "frames": frames.iter().map(|r| serde_json::json!({"x": r.origin.x, "y": r.origin.y, "height": r.size.height})).collect::<Vec<_>>()
            }));
        }
    });
}

fn contains(rect: NSRect, point: NSPoint) -> bool {
    point.x >= rect.origin.x
        && point.x <= rect.origin.x + rect.size.width
        && point.y >= rect.origin.y
        && point.y <= rect.origin.y + rect.size.height
}
fn cascade_frames(anchor: NSRect, screen: NSRect, heights: [f64; 3], widths: [f64; 3]) -> [NSRect; 3] {
    let left = screen.origin.x + 6.0;
    let right = screen.origin.x + screen.size.width - 6.0;
    let top = anchor.origin.y.min(screen.origin.y + screen.size.height);
    let total = widths.iter().sum::<f64>() + 8.0;
    if total > right - left {
        let mut next_top = top;
        return std::array::from_fn(|i| {
            let frame = rect(
                anchor.origin.x.clamp(left, (right - widths[i]).max(left)),
                next_top - heights[i],
                widths[i],
                heights[i],
            );
            next_top -= heights[i] + 4.0;
            frame
        });
    }
    let leftward = anchor.origin.x > screen.origin.x + screen.size.width / 2.0;
    let mut x = if leftward {
        (anchor.origin.x + anchor.size.width - widths[0])
            .clamp(left + total - widths[0], right - widths[0])
    } else {
        anchor.origin.x.clamp(left, (right - total).max(left))
    };
    std::array::from_fn(|i| {
        if i > 0 {
            x += if leftward {
                -widths[i] - 4.0
            } else {
                widths[i - 1] + 4.0
            };
        }
        rect(
            x,
            (top - heights[i]).max(screen.origin.y + 6.0),
            widths[i],
            heights[i],
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pointer_leave_grace_restarts_after_reentry() {
        let mut left = None;
        assert!(!leave_timeout(&mut left, 0, false));
        assert!(!leave_timeout(&mut left, 499, false));
        assert!(!leave_timeout(&mut left, 500, true));
        assert!(!leave_timeout(&mut left, 800, false));
        assert!(!leave_timeout(&mut left, 1299, false));
        assert!(leave_timeout(&mut left, 1300, false));
        assert!(!leave_timeout(&mut left, 2000, true));
    }

    #[test]
    fn filters_only_our_tagged_events() {
        assert!(matches_synthetic(synthetic_marker(314), 123, 123));
        assert!(!matches_synthetic(synthetic_marker(314), 456, 123));
        assert!(!matches_synthetic(314, 123, 123));
        assert!(!matches_synthetic(0, 0, 123));
    }
    #[test]
    fn cascade_fits_normal_and_negative_origin_screens() {
        for origin in [0.0, -1512.0] {
            for anchor_x in [10.0, 500.0, 800.0, 1290.0] {
                let screen = rect(origin, 0.0, 1512.0, 950.0);
                let frames = cascade_frames(
                    rect(origin + anchor_x, 950.0, 34.0, 32.0),
                    screen,
                    [200.0, 105.0, 480.0],
                    [278.0, 204.0, WIDTH],
                );
                for f in frames {
                    assert!(f.origin.x >= origin);
                    assert!(f.origin.x + f.size.width <= origin + 1512.0);
                    assert!(f.origin.y >= 0.0);
                }
                for pair in [(0, 1), (0, 2), (1, 2)] {
                    let a = frames[pair.0];
                    let b = frames[pair.1];
                    assert!(
                        a.origin.x + a.size.width <= b.origin.x
                            || b.origin.x + b.size.width <= a.origin.x
                    );
                }
            }
        }
    }
}

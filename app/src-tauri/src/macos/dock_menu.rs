//! Settings shortcuts in the system Dock menu. Keep Tao's application delegate
//! and add only the optional AppKit Dock-menu callback it does not implement.

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Imp, Sel};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::{NSObject, NSObjectProtocol, NSString};

struct MenuState {
    menu: Retained<NSMenu>,
    // NSMenuItem.target is not retained by AppKit.
    _target: Retained<DockActions>,
}

thread_local! {
    static STATE: RefCell<Option<MenuState>> = const { RefCell::new(None) };
}

define_class!(
    #[unsafe(super = NSObject)]
    #[name = "FlowHubDockActions"]
    #[thread_kind = MainThreadOnly]
    #[ivars = tauri::AppHandle]
    struct DockActions;

    unsafe impl NSObjectProtocol for DockActions {}

    impl DockActions {
        #[unsafe(method(openSettings:))]
        fn open_settings(&self, _sender: Option<&AnyObject>) {
            self.open(false);
        }

        #[unsafe(method(openCanvasSettings:))]
        fn open_canvas_settings(&self, _sender: Option<&AnyObject>) {
            self.open(true);
        }
    }
);

impl DockActions {
    fn open(&self, canvas: bool) {
        // A Dock action can arrive while FlowHub is hidden or inactive.
        #[allow(deprecated)]
        NSApplication::sharedApplication(self.mtm()).activateIgnoringOtherApps(true);
        let result = if canvas {
            crate::open_canvas_settings(self.ivars().clone())
        } else {
            crate::open_settings_window(self.ivars().clone(), None, false)
        };
        if let Err(error) = result {
            eprintln!("[flowhub-tauri] Dock 设置打开失败：{error}");
        }
    }
}

unsafe extern "C-unwind" fn application_dock_menu(
    _delegate: &AnyObject,
    _selector: Sel,
    _application: &NSApplication,
) -> *const NSMenu {
    // AppKit requests this on the main thread. The thread-local state owns the
    // menu for the application's lifetime; this delegate method returns +0.
    STATE.with(|state| {
        state.borrow().as_ref().map_or(std::ptr::null(), |state| {
            Retained::as_ptr(&state.menu)
        })
    })
}

pub(crate) fn install(app: &tauri::AppHandle) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("Dock 菜单必须在主线程安装")?;
    let application = NSApplication::sharedApplication(mtm);
    let delegate = application.delegate().ok_or("应用委托尚未初始化")?;
    let delegate: &AnyObject = (*delegate).as_ref();
    let selector = sel!(applicationDockMenu:);
    // Avoid replacing an existing implementation if a future Tao release adds
    // its own Dock menu. Lifecycle, reopen and URL callbacks remain untouched.
    if delegate.class().instance_method(selector).is_some() {
        return if STATE.with(|state| state.borrow().is_some()) {
            Ok(())
        } else {
            Err("应用委托已有 Dock 菜单实现".into())
        };
    }

    let target: Retained<DockActions> = unsafe {
        msg_send![super(DockActions::alloc(mtm).set_ivars(app.clone())), init]
    };
    let menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str("FlowHub"));
    menu.setAutoenablesItems(false);
    for (title, action) in [
        ("设置…", sel!(openSettings:)),
        ("桌面组件设置…", sel!(openCanvasSettings:)),
    ] {
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &NSString::from_str(title),
                Some(action),
                &NSString::new(),
            )
        };
        unsafe { item.setTarget(Some(&target)) };
        item.setEnabled(true);
        menu.addItem(&item);
    }

    // Correct Objective-C ABI: object return, self, selector, object argument.
    // class_addMethod only adds this missing selector, without swizzling Tao.
    let implementation: Imp = unsafe {
        std::mem::transmute(
            application_dock_menu
                as unsafe extern "C-unwind" fn(&AnyObject, Sel, &NSApplication) -> *const NSMenu,
        )
    };
    let added = unsafe {
        objc2::ffi::class_addMethod(
            delegate.class() as *const _ as *mut _,
            selector,
            implementation,
            c"@@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        return Err("Dock 菜单回调注册失败".into());
    }
    STATE.with(|state| *state.borrow_mut() = Some(MenuState { menu, _target: target }));
    Ok(())
}

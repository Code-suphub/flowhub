//! Own the real keyboard focus and return it to the summon source.
//! AppKit key-window flags alone do not establish WindowServer input ownership.
use objc2::{rc::Retained, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSRunningApplication, NSWorkspace,
};
use std::{
    cell::{Cell, RefCell},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
};
use tauri::Manager;
use tauri_nspanel::ManagerExt;

// Commands capture this before clipboard/database I/O; native objects stay on main.
static SOURCE_GENERATION: AtomicU64 = AtomicU64::new(0);
pub(crate) fn source_generation() -> u64 {
    SOURCE_GENERATION.load(Ordering::Acquire)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PasteReceipt {
    generation: u64,
    pid: i32,
}

#[derive(Default)]
struct ReturnContext {
    generation: u64,
    // Retain the application instance, rather than trusting a potentially reused PID.
    application: Option<Retained<NSRunningApplication>>,
}
thread_local! {
    static RETURN: RefCell<ReturnContext> = RefCell::new(ReturnContext::default());
    static CLAIMING: Cell<bool> = const { Cell::new(false) };
    static PENDING: Cell<Option<(u64, bool)>> = const { Cell::new(None) };
}

struct ClaimGuard;
impl ClaimGuard {
    fn enter() -> Option<Self> {
        CLAIMING.with(|claiming| {
            if claiming.replace(true) {
                None
            } else {
                Some(Self)
            }
        })
    }
}
impl Drop for ClaimGuard {
    fn drop(&mut self) {
        CLAIMING.with(|claiming| claiming.set(false));
    }
}

fn front_pid() -> Option<i32> {
    NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .map(|app| app.processIdentifier())
}

#[allow(deprecated)]
fn activate(application: &NSRunningApplication) -> bool {
    !application.isTerminated()
        && application
            .activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps)
}

pub(crate) fn show(app: &tauri::AppHandle, capture_return: bool, prepare: bool) {
    debug_assert!(MainThreadMarker::new().is_some());
    let Some(_claim) = ClaimGuard::enter() else {
        return;
    };
    if capture_return {
        let front = NSWorkspace::sharedWorkspace().frontmostApplication();
        let source = front
            .as_ref()
            .filter(|app| {
                app.processIdentifier() != std::process::id() as i32 && !app.isTerminated()
            })
            .cloned()
            .or_else(|| {
                if pending()
                    && front
                        .as_ref()
                        .is_some_and(|app| app.processIdentifier() == std::process::id() as i32)
                {
                    RETURN.with(|slot| slot.borrow().application.clone())
                } else {
                    None
                }
            });
        RETURN.with(|slot| {
            let mut context = slot.borrow_mut();
            context.generation = context.generation.wrapping_add(1);
            context.application = source;
            SOURCE_GENERATION.store(context.generation, Ordering::Release);
        });
    }
    let Some(session) = crate::MAIN_VISIBILITY.lock().unwrap().active_session() else {
        return;
    };
    PENDING.with(|pending| pending.set(Some((session, prepare))));
    if front_pid() == Some(std::process::id() as i32) {
        finish_pending(app);
        if !pending() {
            return;
        }
    }
    let accepted = activate(&NSRunningApplication::currentApplication());
    crate::diagnostics::focus::record(
        "native-activation",
        serde_json::json!({"accepted":accepted}),
    );
    // Activation can select a regular window (including the desktop canvas).
    // Acquire panel key status after that native activation turn has finished.
    schedule_finish(app);
}

pub(crate) fn pending() -> bool {
    PENDING.with(|pending| pending.get().is_some())
}

fn external_switch_requires_hide(
    front: Option<i32>,
    source: Option<i32>,
    pending: bool,
    own: i32,
) -> bool {
    // Workspace notifications can be delivered after a new hotkey request.
    // The old source remaining frontmost during activation is not a new switch.
    front.is_some_and(|pid| pid != own && !(pending && Some(pid) == source))
}

pub(crate) fn should_dismiss_for_external_activation() -> bool {
    let source = RETURN.with(|slot| {
        slot.borrow()
            .application
            .as_ref()
            .map(|app| app.processIdentifier())
    });
    external_switch_requires_hide(front_pid(), source, pending(), std::process::id() as i32)
}

pub(crate) fn remember_pinned_source() {
    if pending()
        || crate::MAIN_VISIBILITY
            .lock()
            .unwrap()
            .active_session()
            .is_none()
    {
        return;
    }
    let source = NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .filter(|app| app.processIdentifier() != std::process::id() as i32 && !app.isTerminated());
    if let Some(source) = source {
        RETURN.with(|slot| {
            let mut context = slot.borrow_mut();
            context.generation = context.generation.wrapping_add(1);
            context.application = Some(source);
            SOURCE_GENERATION.store(context.generation, Ordering::Release);
        });
    }
}

fn finish_pending(app: &tauri::AppHandle) {
    let Some((session, prepare)) = PENDING.with(|pending| pending.get()) else {
        return;
    };
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    if !crate::MAIN_VISIBILITY
        .lock()
        .unwrap()
        .is_current_show(session)
        || front_pid() != Some(std::process::id() as i32)
        || !NSApplication::sharedApplication(mtm).isActive()
    {
        if crate::diagnostics::focus::focus_diagnostics_enabled() {
            crate::diagnostics::focus::record(
                "native-focus-wait",
                serde_json::json!({
                    "current":crate::MAIN_VISIBILITY.lock().unwrap().is_current_show(session),
                    "frontmostSelf":front_pid()==Some(std::process::id() as i32),
                    "applicationActive":NSApplication::sharedApplication(mtm).isActive(),
                }),
            );
        }
        return;
    }
    let Ok(panel) = app.get_webview_panel("main") else {
        return;
    };
    // Do not display a writable search field until the application owns input.
    panel.as_panel().orderFrontRegardless();
    panel.make_key_window();
    if let Some(window) = app.get_webview_window("main") {
        crate::macos::launcher_focus::restore(&window, prepare);
    }
    if crate::diagnostics::focus::focus_diagnostics_enabled() {
        crate::diagnostics::focus::record(
            "native-focus-ready",
            crate::diagnostics::focus::native_window_state(panel.as_panel()),
        );
    }
    PENDING.with(|pending| {
        if pending.get() == Some((session, prepare)) {
            pending.set(None);
        }
    });
}

pub(crate) fn schedule_finish(app: &tauri::AppHandle) {
    if !pending() {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let ready = handle.clone();
        let _ = handle.run_on_main_thread(move || finish_pending(&ready));
    });
}

pub(crate) fn install(app: &tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::NSApplicationDidBecomeActiveNotification;
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSOperationQueue};
    use std::ptr::NonNull;
    let handle = app.clone();
    let callback = RcBlock::new(move |_: NonNull<NSNotification>| {
        crate::diagnostics::focus::record(
            "native-application-activated",
            serde_json::json!({"pending":pending()}),
        );
        schedule_finish(&handle);
    });
    let observer = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSApplicationDidBecomeActiveNotification),
            None,
            Some(&NSOperationQueue::mainQueue()),
            &callback,
        )
    };
    std::mem::forget(observer);
}

pub(crate) fn reclaim(app: &tauri::AppHandle) {
    if crate::MAIN_VISIBILITY
        .lock()
        .unwrap()
        .active_session()
        .is_none()
    {
        return;
    }
    let Ok(panel) = app.get_webview_panel("main") else {
        return;
    };
    if !panel.as_panel().isVisible()
        || !panel.as_panel().isKeyWindow()
        || front_pid() == Some(std::process::id() as i32)
    {
        return;
    }
    // A pinned panel can become key while another application still owns input.
    show(app, true, false);
}

pub(crate) fn hide_panel(app: &tauri::AppHandle) -> Result<(), String> {
    crate::diagnostics::focus::record("native-hide", serde_json::json!({"pending":pending()}));
    PENDING.with(|pending| pending.set(None));
    if app.get_webview_window("main").is_none() {
        return Ok(());
    }
    app.get_webview_panel("main")
        .map_err(|error| format!("无法收起启动器：{error:?}"))?
        .hide();
    Ok(())
}

pub(crate) fn return_to_source(consume: bool, restore: bool) {
    let source = RETURN.with(|slot| {
        let mut context = slot.borrow_mut();
        if consume {
            context.application.take()
        } else {
            context.application.clone()
        }
    });
    // A user-initiated application switch always wins over our return request.
    if restore && front_pid() == Some(std::process::id() as i32) {
        if let Some(source) = source {
            let _ = activate(&source);
        }
    }
}

fn on_main<T: Send + 'static>(
    app: &tauri::AppHandle,
    work: impl FnOnce(&tauri::AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    if MainThreadMarker::new().is_some() {
        return work(app);
    }
    let (tx, rx) = mpsc::sync_channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(work(&handle));
    })
    .map_err(|error| error.to_string())?;
    rx.recv().map_err(|_| "原生焦点交接中断".to_string())?
}

pub(crate) fn hide(app: &tauri::AppHandle, restore: bool) -> Result<(), String> {
    on_main(app, move |app| {
        // A new summon can supersede a hide queued by an older window event.
        if crate::MAIN_VISIBILITY
            .lock()
            .unwrap()
            .active_session()
            .is_some()
        {
            return Ok(());
        }
        hide_panel(app)?;
        return_to_source(true, restore);
        Ok(())
    })
}

fn target() -> Option<(PasteReceipt, Retained<NSRunningApplication>)> {
    RETURN.with(|slot| {
        let context = slot.borrow();
        context.application.as_ref().map(|app| {
            (
                PasteReceipt {
                    generation: context.generation,
                    pid: app.processIdentifier(),
                },
                app.clone(),
            )
        })
    })
}

pub(crate) fn prepare_paste(
    app: &tauri::AppHandle,
    show_session: Option<u64>,
    source_generation: u64,
) -> Result<PasteReceipt, String> {
    on_main(app, move |app| {
        {
            let mut visibility = crate::MAIN_VISIBILITY.lock().unwrap();
            if !paste_request_is_current(
                show_session,
                visibility.active_session(),
                source_generation,
                target().map(|(receipt, _)| receipt.generation),
            ) {
                return Err("已复制；启动器或接收应用已切换，请在目标窗口手动粘贴".into());
            }
            visibility.dismiss();
        }
        hide_panel(app)?;
        let (receipt, source) = target().ok_or("已复制；未记录接收应用，请切回目标窗口后粘贴")?;
        let front = front_pid();
        if front != Some(std::process::id() as i32) && front != Some(receipt.pid) {
            return Err("已复制；接收应用已改变，请在目标窗口手动粘贴".into());
        }
        if !activate(&source) {
            return Err("已复制；无法恢复接收应用，请手动粘贴".into());
        }
        Ok(receipt)
    })
}

fn paste_request_is_current(
    expected_session: Option<u64>,
    current_session: Option<u64>,
    expected_source: u64,
    current_source: Option<u64>,
) -> bool {
    expected_session.is_some()
        && expected_session == current_session
        && current_source == Some(expected_source)
}

fn ready(
    current: Option<PasteReceipt>,
    expected: PasteReceipt,
    front: Option<i32>,
    alive: bool,
    showing: bool,
) -> bool {
    current == Some(expected) && front == Some(expected.pid) && alive && !showing
}

pub(crate) fn verify_paste_target(
    app: &tauri::AppHandle,
    receipt: PasteReceipt,
) -> Result<(), String> {
    on_main(app, move |_| {
        let current = target();
        let showing = crate::MAIN_VISIBILITY
            .lock()
            .unwrap()
            .active_session()
            .is_some();
        let valid = ready(
            current.as_ref().map(|(receipt, _)| *receipt),
            receipt,
            front_pid(),
            current.as_ref().is_some_and(|(_, app)| !app.isTerminated()),
            showing,
        );
        if !valid {
            return Err("已复制；接收窗口尚未就绪或已切换，请手动粘贴".into());
        }
        RETURN.with(|slot| {
            slot.borrow_mut().application = None;
        });
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paste_request_cannot_follow_a_source_change_during_clipboard_io() {
        assert!(paste_request_is_current(Some(1), Some(1), 7, Some(7)));
        assert!(!paste_request_is_current(Some(1), Some(1), 7, Some(8)));
        assert!(!paste_request_is_current(Some(1), Some(2), 7, Some(7)));
        assert!(!paste_request_is_current(None, None, 7, Some(7)));
        assert!(!paste_request_is_current(Some(1), None, 7, Some(7)));
        assert!(!paste_request_is_current(Some(1), Some(1), 7, None));
    }
    #[test]
    fn delayed_external_notifications_do_not_hide_a_new_activation() {
        assert!(!external_switch_requires_hide(
            Some(10),
            Some(20),
            false,
            10
        ));
        assert!(!external_switch_requires_hide(Some(20), Some(20), true, 10));
        assert!(external_switch_requires_hide(Some(30), Some(20), true, 10));
        assert!(external_switch_requires_hide(Some(20), Some(20), false, 10));
        assert!(!external_switch_requires_hide(None, Some(20), true, 10));
    }
    #[test]
    fn activation_notifications_cannot_reenter_the_same_claim() {
        let first = ClaimGuard::enter().unwrap();
        assert!(ClaimGuard::enter().is_none());
        drop(first);
        assert!(ClaimGuard::enter().is_some());
    }
    #[test]
    fn paste_requires_the_same_live_source_and_no_new_summon() {
        let receipt = PasteReceipt {
            generation: 7,
            pid: 101,
        };
        assert!(ready(Some(receipt), receipt, Some(101), true, false));
        assert!(!ready(Some(receipt), receipt, Some(202), true, false));
        assert!(!ready(Some(receipt), receipt, None, true, false));
        assert!(!ready(Some(receipt), receipt, Some(101), false, false));
        assert!(!ready(Some(receipt), receipt, Some(101), true, true));
        assert!(!ready(None, receipt, Some(101), true, false));
        // A new summon from the same application still invalidates old paste work.
        let next = PasteReceipt {
            generation: 8,
            pid: 101,
        };
        assert!(!ready(Some(next), receipt, Some(101), true, false));
    }
}

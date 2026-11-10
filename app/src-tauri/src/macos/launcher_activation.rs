//! Own the real keyboard focus and return it to the summon source.
//! AppKit key-window flags alone do not establish WindowServer input ownership.
use objc2::{rc::Retained, MainThreadMarker};
use objc2_app_kit::{
    NSApplicationActivationOptions, NSRunningApplication, NSWindow, NSWindowCollectionBehavior,
    NSWorkspace,
};
use std::{
    cell::{Cell, RefCell},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
};
use tauri::Manager;
use tauri_nspanel::{CollectionBehavior, ManagerExt};

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

fn space_behavior(pinned: bool) -> NSWindowCollectionBehavior {
    let common = CollectionBehavior::new()
        .full_screen_auxiliary()
        .transient()
        .ignores_cycle();
    if pinned {
        common.can_join_all_spaces().into()
    } else {
        common.move_to_active_space().into()
    }
}

pub(crate) fn apply_space_behavior(window: &NSWindow) {
    debug_assert!(MainThreadMarker::new().is_some());
    let behavior = space_behavior(crate::LAUNCHER_PINNED.load(Ordering::Acquire));
    if window.collectionBehavior() != behavior {
        window.setCollectionBehavior(behavior);
    }
}

pub(crate) fn show(app: &tauri::AppHandle, capture_return: bool, prepare: bool) {
    debug_assert!(MainThreadMarker::new().is_some());
    let Some(_claim) = ClaimGuard::enter() else {
        return;
    };
    if capture_return {
        let source = external_front_application();
        RETURN.with(|slot| {
            let mut context = slot.borrow_mut();
            context.generation = context.generation.wrapping_add(1);
            context.application = source;
            SOURCE_GENERATION.store(context.generation, Ordering::Release);
        });
    }
    if crate::MAIN_VISIBILITY.lock().unwrap().active_session().is_none() {
        return;
    }
    let Ok(panel) = app.get_webview_panel("main") else {
        return;
    };
    // Move the temporary launcher to this Space only when summoned. Joining
    // all Spaces lets WindowServer show it on the destination before the
    // active-Space notification can close it.
    apply_space_behavior(panel.as_panel());
    // The nonactivating panel borrows keyboard focus in the current Space.
    // Activating the application here can take the user to a regular FlowHub
    // window on a different desktop.
    panel.make_key_and_order_front();
    if !panel.as_panel().isKeyWindow() {
        crate::hide_main(app);
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        crate::macos::launcher_focus::restore(&window, prepare);
    }
    if crate::diagnostics::focus::focus_diagnostics_enabled() {
        crate::diagnostics::focus::record(
            "native-focus-ready",
            crate::diagnostics::focus::native_window_state(panel.as_panel()),
        );
    }
}

fn external_front_application() -> Option<Retained<NSRunningApplication>> {
    NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .filter(|app| app.processIdentifier() != std::process::id() as i32 && !app.isTerminated())
}

pub(crate) fn claiming() -> bool {
    CLAIMING.with(Cell::get)
}

fn external_switch_requires_hide(front: Option<i32>, source: Option<i32>, own: i32) -> bool {
    // The summon source remains frontmost while its keyboard focus is borrowed.
    // A delayed notification for that application must not dismiss the panel.
    front.is_some_and(|pid| pid != own && Some(pid) != source)
}

pub(crate) fn should_dismiss_for_external_activation() -> bool {
    let source = RETURN.with(|slot| {
        slot.borrow()
            .application
            .as_ref()
            .map(|app| app.processIdentifier())
    });
    external_switch_requires_hide(front_pid(), source, std::process::id() as i32)
}

pub(crate) fn remember_pinned_source() {
    if claiming()
        || crate::MAIN_VISIBILITY
            .lock()
            .unwrap()
            .active_session()
            .is_none()
    {
        return;
    }
    if let Some(source) = external_front_application() {
        RETURN.with(|slot| {
            let mut context = slot.borrow_mut();
            if context.application.as_ref().is_some_and(|old| {
                !old.isTerminated() && old.processIdentifier() == source.processIdentifier()
            }) {
                return;
            }
            context.generation = context.generation.wrapping_add(1);
            context.application = Some(source);
            SOURCE_GENERATION.store(context.generation, Ordering::Release);
        });
    }
}

pub(crate) fn hide_panel(app: &tauri::AppHandle) -> Result<(), String> {
    crate::diagnostics::focus::record("native-hide", serde_json::json!({}));
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
        if front != Some(receipt.pid) && !activate(&source) {
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

#[derive(Debug, PartialEq, Eq)]
enum PasteReadiness {
    Ready,
    Waiting,
    Cancelled,
}

fn paste_readiness(
    current: Option<PasteReceipt>,
    expected: PasteReceipt,
    front: Option<i32>,
    alive: bool,
    showing: bool,
    own: i32,
) -> PasteReadiness {
    if current != Some(expected) || !alive || showing {
        return PasteReadiness::Cancelled;
    }
    match front {
        Some(pid) if pid == expected.pid => PasteReadiness::Ready,
        Some(pid) if pid != own => PasteReadiness::Cancelled,
        _ => PasteReadiness::Waiting,
    }
}

pub(crate) fn try_paste_to_source(
    app: &tauri::AppHandle,
    receipt: PasteReceipt,
    send: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<bool, String> {
    on_main(app, move |_| {
        let current = target();
        let showing = crate::MAIN_VISIBILITY
            .lock()
            .unwrap()
            .active_session()
            .is_some();
        match paste_readiness(
            current.as_ref().map(|(receipt, _)| *receipt),
            receipt,
            front_pid(),
            current.as_ref().is_some_and(|(_, app)| !app.isTerminated()),
            showing,
            std::process::id() as i32,
        ) {
            PasteReadiness::Waiting => Ok(false),
            PasteReadiness::Cancelled => Err("已复制；接收窗口已切换，请手动粘贴".into()),
            PasteReadiness::Ready => {
                RETURN.with(|slot| {
                    slot.borrow_mut().application = None;
                });
                // Recheck the live target and dispatch on the same native turn.
                send()?;
                Ok(true)
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_pinned_launchers_join_all_spaces() {
        let temporary = space_behavior(false);
        let pinned = space_behavior(true);
        assert!(temporary.contains(NSWindowCollectionBehavior::MoveToActiveSpace));
        assert!(!temporary.contains(NSWindowCollectionBehavior::CanJoinAllSpaces));
        assert!(pinned.contains(NSWindowCollectionBehavior::CanJoinAllSpaces));
        assert!(!pinned.contains(NSWindowCollectionBehavior::MoveToActiveSpace));
        assert!(temporary.contains(NSWindowCollectionBehavior::FullScreenAuxiliary));
        assert!(pinned.contains(NSWindowCollectionBehavior::FullScreenAuxiliary));
    }

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
        assert!(!external_switch_requires_hide(Some(10), Some(20), 10));
        assert!(!external_switch_requires_hide(Some(20), Some(20), 10));
        assert!(external_switch_requires_hide(Some(30), Some(20), 10));
        assert!(external_switch_requires_hide(Some(20), None, 10));
        assert!(!external_switch_requires_hide(None, Some(20), 10));
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
        let check = |current, front, alive, showing| {
            paste_readiness(current, receipt, front, alive, showing, 10)
        };
        assert_eq!(check(Some(receipt), Some(101), true, false), PasteReadiness::Ready);
        assert_eq!(check(Some(receipt), Some(10), true, false), PasteReadiness::Waiting);
        assert_eq!(check(Some(receipt), None, true, false), PasteReadiness::Waiting);
        assert_eq!(check(Some(receipt), Some(202), true, false), PasteReadiness::Cancelled);
        assert_eq!(check(Some(receipt), Some(101), false, false), PasteReadiness::Cancelled);
        assert_eq!(check(Some(receipt), Some(101), true, true), PasteReadiness::Cancelled);
        assert_eq!(check(None, Some(101), true, false), PasteReadiness::Cancelled);
        // A new summon from the same application still invalidates old paste work.
        let next = PasteReceipt {
            generation: 8,
            pid: 101,
        };
        assert_eq!(check(Some(next), Some(101), true, false), PasteReadiness::Cancelled);
    }
}

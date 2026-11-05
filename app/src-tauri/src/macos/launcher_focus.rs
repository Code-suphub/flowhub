//! NSPanel key status and DOM focus are separate from WKWebView's first responder.
use tauri::WebviewWindow;
use objc2_foundation::NSString;
use objc2_web_kit::WKWebView;

pub(crate) fn restore(window: &WebviewWindow, prepare: bool) {
    let Some(session) = crate::MAIN_VISIBILITY.lock().unwrap().active_session() else {
        return;
    };
    if let Err(error) = window.with_webview(move |webview| {
        if !crate::MAIN_VISIBILITY.lock().unwrap().is_current_show(session) {
            return;
        }
        // Tauri supplies the live WKWebView on the main thread; the platform
        // handle remains owned for this callback.
        let view = unsafe { &*webview.inner().cast::<WKWebView>() };
        let Some(panel) = view.window() else { return; };
        // Never reclaim the keyboard after the user has left or hidden us.
        if !panel.isVisible() || !panel.isKeyWindow() { return; }
        let restored = panel.makeFirstResponder(Some(view));
        crate::diagnostics::focus::record("native-input-focus", serde_json::json!({
            "restored": restored, "prepare": prepare,
        }));
        if restored {
            let script = if prepare {
                "window.prepareForShow?.(); window.restoreLauncherFocus?.();"
            } else {
                "window.restoreLauncherFocus?.();"
            };
            // with_webview holds Tauri's dispatcher mutex. Calling window.eval
            // here re-enters that dispatcher and deadlocks the main thread.
            // Use the native view already supplied by the callback instead.
            unsafe { view.evaluateJavaScript_completionHandler(&NSString::from_str(script), None); }
        }
    }) {
        eprintln!("[flowhub-tauri] 恢复启动器 WebView 焦点失败：{error}");
    }
}

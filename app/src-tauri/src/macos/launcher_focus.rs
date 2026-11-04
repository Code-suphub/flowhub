//! NSPanel key status and DOM focus are separate from WKWebView's first responder.
use tauri::WebviewWindow;

pub(crate) fn restore(window: &WebviewWindow, prepare: bool) {
    let Some(session) = crate::MAIN_VISIBILITY.lock().unwrap().active_session() else {
        return;
    };
    let main = window.clone();
    if let Err(error) = window.with_webview(move |webview| {
        if !crate::MAIN_VISIBILITY.lock().unwrap().is_current_show(session) {
            return;
        }
        // Tauri supplies the live WKWebView on the main thread. NSView is its
        // superclass; the platform handle remains owned for this callback.
        let view = unsafe { &*webview.inner().cast::<objc2_app_kit::NSView>() };
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
            if let Err(error) = main.eval(script) {
                eprintln!("[flowhub-tauri] 恢复启动器输入焦点失败：{error}");
            }
        }
    }) {
        eprintln!("[flowhub-tauri] 恢复启动器 WebView 焦点失败：{error}");
    }
}

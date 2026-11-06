// Isolated AppKit/WKWebView input regression; never opens FlowHub user data.
// Start dev:web, then: swift launcher-input-smoke.swift --url <loopback demo URL>
// --legacy verifies the contentView-first-responder failure as a control.
import AppKit
import WebKit
import CoreGraphics

final class LauncherPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
final class Container: NSView {
    override var acceptsFirstResponder: Bool { true }
    var intercepted = 0
    override func keyDown(with event: NSEvent) { intercepted += 1 }
}

@MainActor
final class InputSmoke: NSObject, WKNavigationDelegate {
    let panel = LauncherPanel(contentRect: NSRect(x: 0, y: 0, width: 620, height: 520),
        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    let container = Container(frame: NSRect(x: 0, y: 0, width: 620, height: 520))
    let webview = WKWebView(frame: NSRect(x: 0, y: 0, width: 620, height: 520))
    let other = NSWindow(contentRect: NSRect(x: 20, y: 20, width: 160, height: 80),
        styleMask: [.titled], backing: .buffered, defer: false)
    let legacy = CommandLine.arguments.contains("--legacy")
    var started = false
    var state = "{}"

    func start(_ url: URL) {
        panel.title = "FlowHub interaction QA"
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = container
        container.addSubview(webview)
        webview.autoresizingMask = [.width, .height]
        webview.navigationDelegate = self
        panel.center()
        other.title = "FlowHub QA focus target"
        webview.load(URLRequest(url: url))
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { self.finish(false, "timeout") }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !started else { return }
        started = true
        Task {
            do {
                for _ in 0..<100 {
                    if (try await evaluate("Boolean(window.prepareForShow && document.getElementById('q'))")) as? Bool == true { break }
                    try await Task.sleep(nanoseconds: 20_000_000)
                }
                try await runChecks()
            } catch { finish(false, "evaluation-failed") }
        }
    }

    func evaluate(_ script: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            webview.evaluateJavaScript(script) { value, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: value) }
            }
        }
    }

    func runChecks() async throws {
        guard CGPreflightPostEventAccess() else { finish(false, "input-permission-unavailable"); return }
        // A nonactivating panel can be key while NSApp.isActive is false.
        // Verify the panel itself; activating the app would mask that case.
        _ = try await evaluate("window.qaKeys=0; window.qaInputs=0; document.addEventListener('keydown',()=>window.qaKeys++); document.addEventListener('input',()=>window.qaInputs++); true")
        for cycle in 0..<20 {
            panel.orderOut(nil)
            other.makeKeyAndOrderFront(nil)
            // Matches tauri-nspanel's contentView -> orderFront -> makeKey.
            panel.makeFirstResponder(container)
            panel.orderFrontRegardless()
            panel.makeKey()
            if !legacy { panel.makeFirstResponder(webview) }
            // Queue DOM restoration, then type immediately without waiting
            // for JavaScript to acknowledge focus (the real summon race).
            enqueueDOMRestore()
            guard panel.isKeyWindow else { finish(false, "panel-not-key"); return }
            // Send only to this disposable process, through its AppKit event
            // queue and first responder. Never type into another user's app.
            let token = "flowhubqa"
            let source = CGEventSource(stateID: .privateState)
            for character in token {
                guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                    finish(false, "event-creation-failed"); return
                }
                let units = Array(String(character).utf16)
                units.withUnsafeBufferPointer { down.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress!) }
                down.postToPid(getpid())
                up.postToPid(getpid())
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            // WebKit dispatches text-input events asynchronously. Wait for
            // delivery instead of mistaking a queued event for dropped input.
            for _ in 0..<100 {
                if (try await evaluate("document.getElementById('q').value.length")) as? Int == token.count { break }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            let accepted = (try await evaluate("document.getElementById('q').value")) as? String == token
            state = (try await evaluate("JSON.stringify({focused:document.hasFocus(),active:document.activeElement?.id,length:document.getElementById('q').value.length,keys:window.qaKeys,inputs:window.qaInputs})")) as? String ?? "{}"
            if legacy {
                finish(!accepted && container.intercepted > 0, "legacy-control", cycles: cycle + 1)
                return
            }
            guard accepted else { finish(false, "keyboard-not-delivered", cycles: cycle + 1); return }
            let focused = (try await evaluate("document.activeElement?.id === 'q'")) as? Bool == true
            guard focused else { finish(false, "search-not-focused", cycles: cycle + 1); return }
        }
        finish(true, "show-hide-type", cycles: 20)
    }

    func enqueueDOMRestore() {
        webview.evaluateJavaScript("window.prepareForShow?.(); window.restoreLauncherFocus?.(); true", completionHandler: nil)
    }

    func finish(_ passed: Bool, _ scenario: String, cycles: Int = 0) {
        print("{\"passed\":\(passed),\"scenario\":\"\(scenario)\",\"cycles\":\(cycles),\"containerKeyEvents\":\(container.intercepted),\"state\":\(state)}")
        panel.orderOut(nil)
        other.orderOut(nil)
        exit(passed ? 0 : 1)
    }
}

let arguments = CommandLine.arguments
guard let index = arguments.firstIndex(of: "--url"), index + 1 < arguments.count,
      let url = URL(string: arguments[index + 1]), url.scheme == "http",
      ["127.0.0.1", "localhost"].contains(url.host ?? ""),
      URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "preview" && $0.value == "demo" }) == true
else { print("Pass --url with the loopback search.html?preview=demo URL"); exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let smoke = MainActor.assumeIsolated {
    let smoke = InputSmoke()
    smoke.start(url)
    return smoke
}
app.run()

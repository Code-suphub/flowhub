// Diagnostic only. Run: swift scripts/probe-menu-bar-pid.swift --self-test
// Creates/removes only its own two status items. No session posting, cursor
// warping, hiding, app activation, preference writes, or external targets.
import AppKit
import ApplicationServices
import CoreGraphics

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
       let line = String(data: data, encoding: .utf8) { print(line) }
}

guard CommandLine.arguments.contains("--self-test") else {
    emit(["mode": "permission-check", "postEventAccess": CGPreflightPostEventAccess(),
          "accessibilityTrusted": AXIsProcessTrusted()])
    exit(0)
}
guard CGPreflightPostEventAccess(), AXIsProcessTrusted() else {
    emit(["error": "permission-missing", "eventsPosted": false]); exit(2)
}

let app = NSApplication.shared
let includeDrag = CommandLine.arguments.contains("--drag")
app.setActivationPolicy(.accessory)
let first = NSStatusBar.system.statusItem(withLength: 42)
let second = NSStatusBar.system.statusItem(withLength: 42)
first.button?.title = "FH·A"
second.button?.title = "FH·B"
let frontmostBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
var sampling: Timer?
var points: [[String: Double]] = []
var before: CGPoint?
var mouseActivity = false
var itemWindow: NSWindow?
var targetWindow: NSWindow?
var originalItemX: CGFloat = 0
var originalTargetX: CGFloat = 0
let started = ProcessInfo.processInfo.systemUptime
let initialActivity = CGEventSource.counterForEventType(.hidSystemState, eventType: .mouseMoved)

func finish(_ error: String? = nil) {
    sampling?.invalidate()
    var report: [String: Any] = ["mode": "self-pid-only", "sampleCount": points.count,
        "sequence": includeDrag ? "down-drag-up" : "down-up",
        "hardwareMouseMoved": mouseActivity,
        "frontmostBefore": frontmostBefore,
        "frontmostAfter": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,
        "scope": "own-status-items-only; not-third-party-validation"]
    if CommandLine.arguments.contains("--samples") { report["samples"] = points }
    if let before {
        report["maxPointerDistance"] = points.map { hypot($0["x"]! - before.x, $0["y"]! - before.y) }.max() ?? 0
    }
    if let itemWindow, let targetWindow {
        report["itemXBefore"] = originalItemX
        report["targetXBefore"] = originalTargetX
        report["itemXAfter"] = itemWindow.frame.minX
        report["targetXAfter"] = targetWindow.frame.minX
        report["swapped"] = itemWindow.frame.maxX <= targetWindow.frame.minX + 1
    }
    if let error { report["error"] = error }
    NSStatusBar.system.removeStatusItem(first)
    NSStatusBar.system.removeStatusItem(second)
    emit(report)
    // NSApplication.stop alone may wait for another native event indefinitely.
    fflush(stdout)
    exit(error == nil ? 0 : 2)
}

DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
    guard let w1 = first.button?.window, let w2 = second.button?.window,
          w1.windowNumber > 0, w2.windowNumber > 0,
          let source = CGEventSource(stateID: .privateState),
          let position = CGEvent(source: nil)?.location,
          let primary = NSScreen.screens.first else { finish("setup-failed"); return }
    guard !(0..<32).contains(where: { CGEventSource.buttonState(.hidSystemState, button: CGMouseButton(rawValue: UInt32($0))!) }) else {
        finish("mouse-button-held; no-events-posted"); return
    }
    source.localEventsSuppressionInterval = 0
    let allLocalEvents: CGEventFilterMask = [.permitLocalMouseEvents, .permitLocalKeyboardEvents, .permitSystemDefinedEvents]
    source.setLocalEventsFilterDuringSuppressionState(allLocalEvents, state: .eventSuppressionStateSuppressionInterval)
    source.setLocalEventsFilterDuringSuppressionState(allLocalEvents, state: .eventSuppressionStateRemoteMouseDrag)
    let item = w1.frame.minX > w2.frame.minX ? w1 : w2
    let target = item === w1 ? w2 : w1
    guard NSScreen.screens.contains(where: { $0.frame.contains(item.frame) }),
          NSScreen.screens.contains(where: { $0.frame.contains(target.frame) }) else {
        finish("test-items-offscreen; no-events-posted"); return
    }
    guard CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .mouseMoved) >= 0.3 else {
        finish("mouse-active; no-events-posted"); return
    }
    itemWindow = item; targetWindow = target
    originalItemX = item.frame.minX; originalTargetX = target.frame.minX
    before = position
    let from = CGPoint(x: item.frame.midX, y: primary.frame.maxY - item.frame.midY)
    let to = CGPoint(x: target.frame.minX, y: primary.frame.maxY - target.frame.midY)
    func event(_ type: CGEventType, _ point: CGPoint, _ window: NSWindow, command: Bool) -> CGEvent? {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { return nil }
        event.flags = command ? .maskCommand : []
        for field in [CGEventField.mouseEventWindowUnderMousePointer,
                      .mouseEventWindowUnderMousePointerThatCanHandleThisEvent,
                      CGEventField(rawValue: 0x33)!] {
            event.setIntegerValueField(field, value: Int64(window.windowNumber))
        }
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(getpid()))
        return event
    }
    guard let down = event(.leftMouseDown, from, item, command: true),
          let drag = event(.leftMouseDragged, to, item, command: true),
          let up = event(.leftMouseUp, to, includeDrag ? item : target, command: false) else { finish("event-creation-failed"); return }
    sampling = Timer(timeInterval: 0.004, repeats: true) { _ in
        if let p = CGEvent(source: nil)?.location {
            points.append(["ms": (ProcessInfo.processInfo.systemUptime - started) * 1000, "x": p.x, "y": p.y])
        }
        mouseActivity = mouseActivity || CGEventSource.counterForEventType(.hidSystemState, eventType: .mouseMoved) != initialActivity
    }
    RunLoop.main.add(sampling!, forMode: .common)
    // Release on a background queue even if AppKit enters a tracking loop.
    if includeDrag {
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { drag.postToPid(getpid()) }
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + (includeDrag ? 0.10 : 0.05)) { up.postToPid(getpid()) }
    down.postToPid(getpid())
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { finish() }
}
app.run()

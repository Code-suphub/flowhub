// Explicit native QA. Show FlowHub first; run with --click to switch only
// clipboard/all six times. Without --click this only locates the controls.
// CGEvent goes through AppKit/WebKit; it is not a physical trackpad event.
import AppKit
import ApplicationServices
import CoreGraphics
import Carbon

func fail(_ message: String) -> Never { print(message); exit(2) }
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element,name as CFString,&value) == .success else { return nil }
    return value
}
guard let app = NSWorkspace.shared.runningApplications.first(where: {
    $0.executableURL?.path == "/Applications/FlowHub.app/Contents/MacOS/flowhub-tauri"
}) else { fail("FlowHub is not running") }
guard AXIsProcessTrusted() else { fail("Accessibility permission unavailable") }
let root = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetMessagingTimeout(root,1)
var controls: [String: CGPoint] = [:]
func scan(_ element: AXUIElement, _ depth: Int) {
    guard depth < 14 else { return }
    if attr(element,kAXRoleAttribute) as? String == "AXButton" {
        let name = (attr(element,kAXTitleAttribute) as? String) ?? (attr(element,kAXDescriptionAttribute) as? String) ?? ""
        if ["全部","剪切板","剪贴板"].contains(name),
           let position = attr(element,kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
           let size = attr(element,kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() {
            var p = CGPoint.zero; var s = CGSize.zero
            if AXValueGetValue(position as! AXValue,.cgPoint,&p), AXValueGetValue(size as! AXValue,.cgSize,&s), s.width > 0, s.height > 0 {
                controls[name] = CGPoint(x:p.x+s.width/2,y:p.y+s.height/2)
            }
        }
    }
    for child in (attr(element,kAXChildrenAttribute) as? [AXUIElement] ?? []) { scan(child,depth+1) }
}
for _ in 0..<10 {
    controls.removeAll(); scan(root,0)
    if controls.count >= 2 { break }
    Thread.sleep(forTimeInterval:0.1)
}
// Input-source identity only; no query text, clipboard contents or preferences.
let input = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
if let property = TISGetInputSourceProperty(input,kTISPropertyInputSourceID) {
    print("inputSource",Unmanaged<CFString>.fromOpaque(property).takeUnretainedValue())
}
print("pid",app.processIdentifier,"controls",controls.keys.sorted())
guard CommandLine.arguments.contains("--click") else { exit(0) }
guard CGPreflightPostEventAccess(), let all = controls["全部"],
      let clipboard = controls["剪切板"] ?? controls["剪贴板"] else { fail("Controls or mouse-event permission unavailable") }
let source = CGEventSource(stateID:.privateState)!
source.localEventsSuppressionInterval = 0
let hold = CommandLine.arguments.contains("--tap") ? 0.001 : 0.08
func verifyTarget(_ point: CGPoint, clipboard: Bool) {
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(),Float(point.x),Float(point.y),&hit) == .success,
          let hit else { fail("Cannot verify target") }
    var hitPid: pid_t = 0
    AXUIElementGetPid(hit,&hitPid)
    guard hitPid == app.processIdentifier else { fail("FlowHub target obscured; stopped") }
    var candidate: AXUIElement? = hit
    for _ in 0..<4 {
        guard let element = candidate else { break }
        let name = (attr(element,kAXTitleAttribute) as? String) ?? (attr(element,kAXDescriptionAttribute) as? String) ?? ""
        if attr(element,kAXRoleAttribute) as? String == "AXButton",
           (clipboard ? ["剪切板","剪贴板"].contains(name) : name == "全部") { return }
        candidate = attr(element,kAXParentAttribute).map { $0 as! AXUIElement }
    }
    fail("Target is not the expected scope button; stopped")
}
for (index,point) in [clipboard,all,clipboard,all,clipboard,all].enumerated() {
    verifyTarget(point,clipboard:index%2 == 0)
    guard !CGEventSource.buttonState(.combinedSessionState,button:.left) else { fail("Mouse button held; stopped") }
    // Fail before posting down unless the matching release is also available.
    guard let move = CGEvent(mouseEventSource:source,mouseType:.mouseMoved,mouseCursorPosition:point,mouseButton:.left),
          let down = CGEvent(mouseEventSource:source,mouseType:.leftMouseDown,mouseCursorPosition:point,mouseButton:.left),
          let up = CGEvent(mouseEventSource:source,mouseType:.leftMouseUp,mouseCursorPosition:point,mouseButton:.left) else { fail("Cannot create mouse events") }
    for event in [move,down,up] { event.flags = []; event.setIntegerValueField(.mouseEventClickState,value:1) }
    move.post(tap:.cghidEventTap)
    Thread.sleep(forTimeInterval:0.08)
    verifyTarget(point,clipboard:index%2 == 0)
    down.timestamp = DispatchTime.now().uptimeNanoseconds
    down.post(tap:.cghidEventTap)
    Thread.sleep(forTimeInterval:hold)
    // CGEvent timestamps are creation times: stamp just before delivery.
    up.timestamp = DispatchTime.now().uptimeNanoseconds
    up.post(tap:.cghidEventTap)
    Thread.sleep(forTimeInterval:0.6)
    print("posted",index+1,index%2 == 0 ? "clipboard" : "all")
}

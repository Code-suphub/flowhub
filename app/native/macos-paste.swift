import CoreGraphics
import Darwin

let source = CGEventSource(stateID: .hidSystemState)
let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true)
let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false)

guard let keyDown, let keyUp else {
    fputs("unable to create paste keyboard event\n", stderr)
    exit(1)
}

keyDown.flags = .maskCommand
keyUp.flags = .maskCommand
keyDown.post(tap: .cghidEventTap)
keyUp.post(tap: .cghidEventTap)

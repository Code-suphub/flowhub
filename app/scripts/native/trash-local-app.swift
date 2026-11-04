// Use the filesystem trash API; Finder Apple Events can wait for Automation
// permission or time out while the desktop is locked.
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: trash-local-app.swift <app-path>\n", stderr)
    exit(2)
}
do {
    var destination: NSURL?
    try FileManager.default.trashItem(
        at: URL(fileURLWithPath: CommandLine.arguments[1]),
        resultingItemURL: &destination
    )
    if let path = destination?.path { print("旧版本已移入废纸篓：\(path)") }
} catch {
    fputs("无法移走旧版本：\(error.localizedDescription)\n", stderr)
    exit(1)
}

#if FLOWHUB_CONTROL_TESTS
import Foundation
import Darwin
func peerAuthSelfCheck(client: String) -> Bool {
    let host = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
    guard let policy = ControlPolicy.create(host: host, client: client, uid: getuid()) else { return false }
    let path = "/tmp/fhc-\(UUID().uuidString.prefix(12)).sock"
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd); unlink(path) }
    var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let bytes = Array(path.utf8CString).map(UInt8.init(bitPattern:))
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    guard withUnsafePointer(to: &address, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }) == 0, listen(fd, 1) == 0 else { return false }
    let child = Process(); child.executableURL = URL(fileURLWithPath: client); child.arguments = [path]
    do { try child.run() } catch { return false }
    defer { if child.isRunning { child.terminate() }; child.waitUntilExit() }
    let peer = accept(fd, nil, nil)
    guard peer >= 0 else { return false }
    defer { close(peer) }
    guard trustedControlPeer(peer, uid: getuid(), policy: policy) else { print("expected peer was rejected"); return false }
    let wrongClient = ControlPolicy(uid: policy.uid, hostPath: policy.hostPath, hostHash: policy.hostHash, clientPath: policy.clientPath, clientHash: String(repeating: "0", count: 40))
    let wrongHost = ControlPolicy(uid: policy.uid, hostPath: policy.hostPath, hostHash: String(repeating: "0", count: 40), clientPath: policy.clientPath, clientHash: policy.clientHash)
    let wrongPath = ControlPolicy(uid: policy.uid, hostPath: policy.hostPath, hostHash: policy.hostHash, clientPath: "/different/client", clientHash: policy.clientHash)
    return !trustedControlPeer(peer, uid: getuid(), policy: wrongClient)
        && !trustedControlPeer(peer, uid: getuid(), policy: wrongHost)
        && !trustedControlPeer(peer, uid: getuid(), policy: wrongPath)
        && !trustedControlPeer(peer, uid: getuid() + 1, policy: policy)
        && !trustedControlPeer(peer, uid: getuid(), policy: nil)
}
#endif

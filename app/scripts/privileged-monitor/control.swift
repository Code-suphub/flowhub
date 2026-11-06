import Foundation
import Darwin
import Security

private func canonicalPath(_ path: String) -> String? {
    guard let resolved = path.withCString({ realpath($0, nil) }) else { return nil }
    defer { free(resolved) }
    return String(cString: resolved)
}

struct ProcessIdentity: Codable, Equatable {
    let pid: Int32
    let uid: UInt32
    let started: UInt64
    let executable: String
    static func read(_ pid: Int32) -> ProcessIdentity? {
        var bsd = proc_bsdinfo()
        guard pid > 0, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size else { return nil }
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return nil }
        return ProcessIdentity(pid: pid, uid: bsd.pbi_uid, started: UInt64(bsd.pbi_start_tvsec) * 1_000_000 + UInt64(bsd.pbi_start_tvusec), executable: String(cString: path))
    }
}
struct ControlPolicy: Codable {
    let uid: UInt32
    let hostPath: String
    let hostHash: String
    let clientPath: String
    let clientHash: String
    static let path = "/Library/PrivilegedHelperTools/cn.ac.camellia.flowhub.resource-monitor/control.json"
    static func load() -> ControlPolicy? {
        var info = stat()
        guard lstat(path, &info) == 0, info.st_uid == 0, (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              (info.st_mode & 0o077) == 0, info.st_size > 0, info.st_size <= 16384,
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        return try? JSONDecoder().decode(ControlPolicy.self, from: data)
    }
    static func create(host: String, client: String, uid: UInt32) -> ControlPolicy? {
        guard let host = canonicalPath(host), let client = canonicalPath(client),
              uid > 0, let hostHash = signingHash(host), let clientHash = signingHash(client),
              host.hasSuffix("/Contents/MacOS/flowhub-tauri"), client.hasSuffix("/flowhub-resource-monitor") else { return nil }
        return ControlPolicy(uid: uid, hostPath: host, hostHash: hostHash, clientPath: client, clientHash: clientHash)
    }
}
private func signingHash(_ path: String) -> String? {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess,
          let code, SecStaticCodeCheckValidity(code, [], nil) == errSecSuccess else { return nil }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let fields = info as? [String: Any], let hash = fields[kSecCodeInfoUnique as String] as? Data else { return nil }
    return hash.map { String(format: "%02x", $0) }.joined()
}
private func verifyCode(_ code: SecCode, path: String, hash: String) -> Bool {
    guard hash.count == 40, hash.allSatisfy({ $0.isHexDigit }) else { return false }
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString("cdhash H\"\(hash)\"" as CFString, [], &requirement) == errSecSuccess,
          SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else { return false }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return false }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let fields = info as? [String: Any], let executable = fields[kSecCodeInfoMainExecutable as String] as? URL else { return false }
    return canonicalPath(executable.path) == path
}
func trustedControlPeer(_ fd: Int32, uid: uid_t, policy: ControlPolicy?) -> Bool {
    guard let policy, uid == policy.uid else { return false }
    // The kernel's audit token binds this socket to the exact process generation.
    var token = Data(count: 32)
    var tokenLength = socklen_t(token.count)
    guard token.withUnsafeMutableBytes({ getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, $0.baseAddress, &tokenLength) }) == 0,
          tokenLength == 32 else { return false }
    var clientCode: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit as String: token] as CFDictionary, [], &clientCode) == errSecSuccess,
          let clientCode, verifyCode(clientCode, path: policy.clientPath, hash: policy.clientHash) else { return false }
    var pid: Int32 = 0
    var length = socklen_t(MemoryLayout<Int32>.size)
    guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0,
          let client = ProcessIdentity.read(pid), client.uid == uid, client.executable == policy.clientPath else { return false }
    var bsd = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
          let host = ProcessIdentity.read(Int32(bsd.pbi_ppid)), host.uid == uid, host.started <= client.started,
          host.executable == policy.hostPath else { return false }
    var hostCode: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: host.pid] as CFDictionary, [], &hostCode) == errSecSuccess,
          let hostCode, verifyCode(hostCode, path: policy.hostPath, hash: policy.hostHash) else { return false }
    var after = proc_bsdinfo()
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size
        && after.pbi_ppid == bsd.pbi_ppid && ProcessIdentity.read(pid) == client && ProcessIdentity.read(host.pid) == host
        && verifyCode(clientCode, path: policy.clientPath, hash: policy.clientHash)
}
func thirdPartyPath(_ path: String) -> Bool {
    let roots = ["/Applications/", "/Library/PrivilegedHelperTools/", "/Library/Application Support/", "/opt/homebrew/", "/usr/local/"]
    guard roots.contains(where: path.hasPrefix), !path.lowercased().contains("/flowhub.app/"),
          !path.contains("/cn.ac.camellia.flowhub.resource-monitor/"),
          !path.contains("/../"), !path.contains("/./") else { return false }
    return true
}
func controllableRoot(_ target: ProcessIdentity) -> Bool {
    guard target.pid > 1, target.pid != getpid(), target.uid == 0, target.started > 0, thirdPartyPath(target.executable),
          canonicalPath(target.executable) == target.executable else { return false }
    var code: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: target.pid] as CFDictionary, [], &code) == errSecSuccess, let code else { return false }
    let valid = SecCodeCheckValidity(code, [], nil)
    guard valid == errSecSuccess || valid == errSecCSUnsigned else { return false }
    var apple: SecRequirement?
    guard SecRequirementCreateWithString("anchor apple" as CFString, [], &apple) == errSecSuccess else { return false }
    // Apple platform processes remain protected even when located in /Applications.
    return SecCodeCheckValidity(code, [], apple) != errSecSuccess
}
func validatedTargets(_ targets: [ProcessIdentity], read: (Int32) -> ProcessIdentity? = ProcessIdentity.read,
                      eligible: (ProcessIdentity) -> Bool = controllableRoot) -> Bool {
    guard !targets.isEmpty, targets.count <= 64, Set(targets.map(\.pid)).count == targets.count else { return false }
    return targets.allSatisfy { $0.uid == 0 && $0.started > 0 && read($0.pid) == $0 && eligible($0) }
}
private let controlLock = NSLock()
func terminateRoots(_ body: [String: Any]) -> [String: Any] {
    guard body["confirmed"] as? Bool == true, let force = body["force"] as? Bool,
          let raw = body["targets"], let bytes = try? JSONSerialization.data(withJSONObject: raw),
          let targets = try? JSONDecoder().decode([ProcessIdentity].self, from: bytes) else { return ["error": "结束请求无效"] }
    guard controlLock.try() else { return ["error": "另一项结束操作正在进行，请稍后重试"] }
    defer { controlLock.unlock() }
    guard validatedTargets(targets) else { return ["error": "目标身份已变化或包含受保护进程，请重新确认"] }
    var results = [[String: Any]]()
    for target in targets {
        guard let current = ProcessIdentity.read(target.pid) else {
            results.append(["pid": Int(target.pid), "sent": false, "exited": true]); continue
        }
        guard current == target, controllableRoot(target) else {
            results.append(["pid": Int(target.pid), "sent": false, "error": "进程身份或保护状态已变化"]); continue
        }
        let success = kill(target.pid, force ? SIGKILL : SIGTERM) == 0
        var result: [String: Any] = ["pid": Int(target.pid), "sent": success]
        if !success { result["error"] = "系统拒绝结束进程（\(errno)）" }
        results.append(result)
    }
    usleep(250_000)
    for index in results.indices { results[index]["exited"] = ProcessIdentity.read(targets[index].pid) != targets[index] }
    return ["results": results]
}
func controlSelfCheck() -> Bool {
    let first = ProcessIdentity(pid: 100, uid: 0, started: 10, executable: "/Applications/Fixture.app/daemon")
    let second = ProcessIdentity(pid: 101, uid: 0, started: 11, executable: "/usr/local/bin/fixture")
    let records = [first.pid: first, second.pid: second]
    guard validatedTargets([first, second], read: { records[$0] }, eligible: { thirdPartyPath($0.executable) }),
          !validatedTargets([first, first], read: { records[$0] }, eligible: { _ in true }),
          !validatedTargets([first], read: { _ in second }, eligible: { _ in true }),
          !validatedTargets([first], read: { records[$0] }, eligible: { _ in false }) else { return false }
    return ["/System/a", "/usr/bin/a", "/bin/a", "/sbin/a", "/Applications/FlowHub.app/daemon", "/Library/PrivilegedHelperTools/cn.ac.camellia.flowhub.resource-monitor/daemon", "/Applications/../usr/bin/a"].allSatisfy { !thirdPartyPath($0) }
}

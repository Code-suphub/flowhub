import Foundation
import Darwin

private let socketPath = "/var/run/cn.ac.camellia.flowhub.resource-monitor.sock"
private let serviceName = "cn.ac.camellia.flowhub.resource-monitor"
private let maxRequestBytes = 64 * 1024

private func consoleUID() -> uid_t? {
    var attributes = stat()
    guard lstat("/dev/console", &attributes) == 0, attributes.st_uid > 0 else { return nil }
    return attributes.st_uid
}

private func processRecords() -> [[String: Any]] {
    let count = proc_listallpids(nil, 0)
    guard count > 0 else { return [] }
    var pids = [pid_t](repeating: 0, count: min(Int(count) + 1024, 65_536))
    let readCount = pids.withUnsafeMutableBufferPointer {
        proc_listallpids($0.baseAddress, Int32($0.count * MemoryLayout<pid_t>.size))
    }
    guard readCount > 0 else { return [] }

    return pids.prefix(Int(readCount)).compactMap { pid -> [String: Any]? in
        guard pid > 0 else { return nil }
        var bsd = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size else { return nil }
        // libproc rejects buffers larger than PROC_PIDPATHINFO_MAXSIZE.
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let pathLength = path.withUnsafeMutableBufferPointer {
            proc_pidpath(pid, $0.baseAddress, UInt32($0.count))
        }
        guard pathLength > 0 else { return nil }
        let executable = String(cString: path)

        var task = proc_taskinfo()
        let taskReadable = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &task, Int32(MemoryLayout<proc_taskinfo>.size)) == MemoryLayout<proc_taskinfo>.size
        var usage = rusage_info_v2()
        let footprintReadable = withUnsafeMutablePointer(to: &usage) { pointer in
            // Despite its pointer-to-pointer declaration, libproc writes the
            // output structure directly at this address.
            pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
                proc_pid_rusage(pid, RUSAGE_INFO_V2, $0) == 0
            }
        }
        var verified = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &verified, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
              verified.pbi_pid == bsd.pbi_pid,
              verified.pbi_start_tvsec == bsd.pbi_start_tvsec,
              verified.pbi_start_tvusec == bsd.pbi_start_tvusec else { return nil }
        let started = UInt64(bsd.pbi_start_tvsec).multipliedReportingOverflow(by: 1_000_000).partialValue &+ UInt64(bsd.pbi_start_tvusec)

        return [
            "pid": Int(pid),
            "uid": Int(bsd.pbi_uid),
            "started": started,
            "executable": executable,
            "ppid": Int(bsd.pbi_ppid),
            "memory": taskReadable ? Int(task.pti_resident_size) : NSNull(),
            "footprint": footprintReadable ? Int(usage.ri_phys_footprint) : NSNull(),
            "cpuTime": taskReadable ? UInt64(task.pti_total_user) &+ UInt64(task.pti_total_system) : 0,
            "controlEligible": controllableRoot(ProcessIdentity(pid: pid, uid: bsd.pbi_uid, started: started, executable: executable))
        ]
    }
}

private func sendJSON(_ value: [String: Any], to fd: Int32) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    var bytes = [UInt8](data) + [UInt8(10)]
    bytes.withUnsafeMutableBufferPointer { buffer in
        guard let base = buffer.baseAddress else { return }
        var offset = 0
        let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
        while offset < buffer.count {
            let now = DispatchTime.now().uptimeNanoseconds
            if now >= deadline { return }
            let left = deadline - now
            var timeout = timeval(tv_sec: Int(left / 1_000_000_000), tv_usec: Int32((left % 1_000_000_000) / 1000))
            _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            let written = Darwin.write(fd, base.advanced(by: offset), buffer.count - offset)
            if written <= 0 { return }
            offset += written
        }
    }
}

private final class SnapshotStore: @unchecked Sendable {
    private let lock = NSLock()
    private var records = [[String: Any]]()
    private var at: UInt64 = 0
    func refresh() {
        let next = processRecords()
        lock.lock(); records = next; at = UInt64(Date().timeIntervalSince1970 * 1000); lock.unlock()
    }
    func value() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["processes": records, "at": at]
    }
}
private let snapshots = SnapshotStore()
private let controlPolicy = ControlPolicy.load()
private let backgroundServices = BackgroundServices()
private func handle(_ client: Int32) {
    defer { close(client) }
    var timeout = timeval(tv_sec: 2, tv_usec: 0)
    _ = setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    _ = setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var peerUID: uid_t = 0
    var peerGID: gid_t = 0
    guard getpeereid(client, &peerUID, &peerGID) == 0,
          peerUID > 0, peerUID == consoleUID() else {
        sendJSON(["error": "仅当前登录用户可访问进程服务"], to: client); return
    }
    let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
    var request = Data()
    var chunk = [UInt8](repeating: 0, count: 4096)
    while request.count < maxRequestBytes {
        let now = DispatchTime.now().uptimeNanoseconds
        if now >= deadline { return }
        let remaining = deadline - now
        timeout = timeval(tv_sec: Int(remaining / 1_000_000_000), tv_usec: Int32((remaining % 1_000_000_000) / 1000))
        _ = setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        let length = recv(client, &chunk, chunk.count, 0)
        if length <= 0 { return }
        request.append(contentsOf: chunk.prefix(length))
        if request.contains(10) { break }
    }
    guard request.count < maxRequestBytes,
          let newline = request.firstIndex(of: 10),
          let body = try? JSONSerialization.jsonObject(with: request[..<newline]) as? [String: Any] else {
        sendJSON(["error": "请求无效"], to: client); return
    }
    switch body["method"] as? String {
    case "status":
        var response: [String: Any] = ["service": serviceName, "protocolVersion": 3, "serviceControlRevision": 3, "uid": Int(geteuid()), "capabilities": ["root-process-control","third-party-service-control"]]
        if let policy = controlPolicy, let data = try? JSONEncoder().encode(policy), let value = try? JSONSerialization.jsonObject(with: data) { response["controlPolicy"] = value }
        sendJSON(response, to: client)
    case "snapshot":
        var response = snapshots.value()
        response["controlAllowed"] = trustedControlPeer(client, uid: peerUID, policy: controlPolicy)
        sendJSON(response, to: client)
    case "terminate":
        guard trustedControlPeer(client, uid: peerUID, policy: controlPolicy) else {
            sendJSON(["error": "调用方未获准控制 root 进程，请通过 FlowHub 升级授权"], to: client); return
        }
        sendJSON(terminateRoots(body), to: client)
    case "vivo_startup_set":
        guard controlPolicy?.vivoStartupControl == true, controlPolicy?.serviceControl == true,
              trustedControlPeer(client,uid:peerUID,policy:controlPolicy) else {
            sendJSON(["error":"vivo 系统级自启动控制需要通过 FlowHub 授权升级系统服务。"],to:client); return
        }
        sendJSON(backgroundServices.handle("vivo_startup_set",body:body,uid:peerUID),to:client)
    case "services_snapshot", "service_preview", "service_confirm":
        guard controlPolicy?.serviceControl == true, trustedControlPeer(client,uid:peerUID,policy:controlPolicy) else {
            sendJSON(["error":"后台服务控制尚未授权，请通过 FlowHub 授权升级服务。"],to:client); return
        }
        sendJSON(backgroundServices.handle(body["method"] as! String,body:body,uid:peerUID),to:client)
    default:
        sendJSON(["error": "不支持的请求"], to: client)
    }
}

private func runDaemon() -> Never {
    var existingInfo = stat()
    if lstat(socketPath, &existingInfo) == 0 {
        guard (existingInfo.st_mode & mode_t(S_IFMT)) == mode_t(S_IFSOCK), existingInfo.st_uid == 0,
              unlink(socketPath) == 0 else { exit(EXIT_FAILURE) }
    }
    let server = socket(AF_UNIX, SOCK_STREAM, 0)
    guard server >= 0, fcntl(server,F_SETFD,FD_CLOEXEC) == 0 else { exit(EXIT_FAILURE) }

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let pathBytes = Array(socketPath.utf8CString)
    let pathCapacity = MemoryLayout.size(ofValue: address.sun_path)
    guard pathBytes.count <= pathCapacity else { close(server); exit(EXIT_FAILURE) }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
        raw.copyBytes(from: pathBytes.map(UInt8.init(bitPattern:)))
    }
    let bound = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard bound == 0, chmod(socketPath, mode_t(0o666)) == 0, listen(server, 16) == 0 else {
        close(server)
        _ = unlink(socketPath)
        exit(EXIT_FAILURE)
    }

    // One bounded collector publishes snapshots; a slow collection or peer
    // never serializes status requests behind itself.
    DispatchQueue(label: "cn.ac.camellia.flowhub.resource-sampling").async {
        while true { snapshots.refresh(); Thread.sleep(forTimeInterval: 2) }
    }
    let capacity = DispatchSemaphore(value: 16)
    while true {
        let client = accept(server, nil, nil)
        guard client >= 0 else { continue }
        guard fcntl(client,F_SETFD,FD_CLOEXEC) == 0 else { close(client); continue }
        guard capacity.wait(timeout: .now()) == .success else { close(client); continue }
        DispatchQueue.global(qos: .utility).async {
            defer { capacity.signal() }; handle(client)
        }
    }
}

@main
struct ResourceMonitorDaemon {
    static func main() {
        if CommandLine.arguments.count >= 3 && CommandLine.arguments[1] == "--user-launchctl" {
            userLaunchctl(Array(CommandLine.arguments.dropFirst(2)))
        }
        #if FLOWHUB_CONTROL_TESTS
        if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--services-transport-self-check" {
            final class Result: @unchecked Sendable { var ok = false }
            let result = Result(), finished = DispatchSemaphore(value:0)
            DispatchQueue.global(qos:.utility).async { result.ok = servicesTransportSelfCheck(); finished.signal() }
            guard finished.wait(timeout:.now()+45) == .success, result.ok else { exit(EXIT_FAILURE) }; print("service transport checks passed"); return
        }
        if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--services-read-check" {
            let value = BackgroundServices().handle("services_snapshot",body:[:],uid:getuid())
            if let data = try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]) { FileHandle.standardOutput.write(data) }; return
        }
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--auth-self-check" {
            guard peerAuthSelfCheck(client: CommandLine.arguments[2]) else { exit(EXIT_FAILURE) }
            print("socket audit-token, client signature and host ancestry checks passed"); return
        }
        #endif
        if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--control-self-check" {
            guard controlSelfCheck() else { exit(EXIT_FAILURE) }; print("control policy checks passed"); return
        }
        if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--services-self-check" {
            guard servicesSelfCheck() else { exit(EXIT_FAILURE) }; print("service policy checks passed"); return
        }
        if [5,6].contains(CommandLine.arguments.count) && CommandLine.arguments[1] == "--control-policy" {
            guard let uid = UInt32(CommandLine.arguments[4]), let policy = ControlPolicy.create(host: CommandLine.arguments[2], client: CommandLine.arguments[3], uid: uid, serviceControl: CommandLine.arguments.last == "services"),
                  let data = try? JSONEncoder().encode(policy) else { exit(EXIT_FAILURE) }
            FileHandle.standardOutput.write(data); return
        }
        if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--self-check" {
            let records = processRecords()
            guard let current = records.first(where: { $0["pid"] as? Int == Int(getpid()) }),
                  let memory = current["memory"] as? Int, memory > 0,
                  let footprint = current["footprint"] as? Int, footprint > 0,
                  let data = try? JSONSerialization.data(withJSONObject: [
                    "processCount": records.count, "selfMemory": memory, "selfFootprint": footprint
                  ]) else { exit(EXIT_FAILURE) }
            FileHandle.standardOutput.write(data)
            return
        }
        guard geteuid() == 0 else { exit(EXIT_FAILURE) }
        signal(SIGPIPE, SIG_IGN)
        signal(SIGCHLD, SIG_DFL)
        runDaemon()
    }
}

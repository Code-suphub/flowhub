import Foundation
import Darwin

private let socketPath = "/var/run/cn.ac.camellia.flowhub.resource-monitor.sock"
private let maxRequestBytes = 16 * 1024

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
        var path = [CChar](repeating: 0, count: 16_384)
        let pathLength = path.withUnsafeMutableBufferPointer {
            proc_pidpath(pid, $0.baseAddress, UInt32($0.count))
        }
        guard pathLength > 0 else { return nil }
        let executable = String(cString: path)

        var task = proc_taskinfo()
        let taskReadable = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &task, Int32(MemoryLayout<proc_taskinfo>.size)) == MemoryLayout<proc_taskinfo>.size
        var usage = rusage_info_v2()
        let footprintReadable = withUnsafeMutablePointer(to: &usage) { pointer in
            var rawUsage: rusage_info_t? = UnsafeMutableRawPointer(pointer)
            return proc_pid_rusage(pid, RUSAGE_INFO_V2, &rawUsage) == 0
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
            "cpuTime": taskReadable ? UInt64(task.pti_total_user) &+ UInt64(task.pti_total_system) : 0
        ]
    }
}

private func sendJSON(_ value: [String: Any], to fd: Int32) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    var bytes = [UInt8](data) + [UInt8(10)]
    bytes.withUnsafeMutableBufferPointer { buffer in
        guard let base = buffer.baseAddress else { return }
        var offset = 0
        while offset < buffer.count {
            let written = Darwin.write(fd, base.advanced(by: offset), buffer.count - offset)
            if written <= 0 { return }
            offset += written
        }
    }
}

private func handle(_ client: Int32) {
    defer { close(client) }
    var peerUID: uid_t = 0
    var peerGID: gid_t = 0
    guard getpeereid(client, &peerUID, &peerGID) == 0,
          peerUID > 0, peerUID == consoleUID() else {
        sendJSON(["error": "仅当前登录用户可读取资源快照"], to: client)
        return
    }

    var request = Data()
    var chunk = [UInt8](repeating: 0, count: 4096)
    while request.count < maxRequestBytes {
        let length = recv(client, &chunk, chunk.count, 0)
        if length <= 0 { return }
        request.append(contentsOf: chunk.prefix(length))
        if request.contains(10) { break }
    }
    guard request.count < maxRequestBytes,
          let newline = request.firstIndex(of: 10),
          let body = try? JSONSerialization.jsonObject(with: request[..<newline]) as? [String: Any],
          body["method"] as? String == "snapshot" else {
        sendJSON(["error": "只支持只读快照请求"], to: client)
        return
    }
    sendJSON(["processes": processRecords()], to: client)
}

private func runDaemon() -> Never {
    var existingInfo = stat()
    if lstat(socketPath, &existingInfo) == 0 {
        guard (existingInfo.st_mode & mode_t(S_IFMT)) == mode_t(S_IFSOCK), existingInfo.st_uid == 0,
              unlink(socketPath) == 0 else { exit(EXIT_FAILURE) }
    }
    let server = socket(AF_UNIX, SOCK_STREAM, 0)
    guard server >= 0 else { exit(EXIT_FAILURE) }

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

    while true {
        let client = accept(server, nil, nil)
        if client >= 0 { handle(client) }
    }
}

@main
struct ResourceMonitorDaemon {
    static func main() { runDaemon() }
}

import Foundation
import Darwin
import CryptoKit

private let serviceJournal = "/Library/PrivilegedHelperTools/cn.ac.camellia.flowhub.resource-monitor/services.json"
private let protectedPrograms: Set<String> = {
    guard let policy = ControlPolicy.load() else { return [] }
    return [policy.hostPath,policy.clientPath]
}()
private struct ServiceConfig: Codable, Equatable {
    var id: String; var label: String; var domain: String; var path: String
    var digest: String; var program: String; var runUID: UInt32; var ownerUID: UInt32
    var restart: String; var restartHint: String
    var appPath: String? {
        guard let end = program.range(of: ".app/") else { return nil }
        return String(program[..<end.upperBound].dropLast())
    }
}
private struct PausedService: Codable { var config: ServiceConfig; var programHash: String; var at: Double; var original: ProcessIdentity? }
private struct ServicePlan { var config: ServiceConfig; var programHash: String; var identity: ProcessIdentity?; var action: String; var at: Date }
private struct LaunchResult { var code: Int32; var text: String; var timedOut: Bool }

// launchctl's human output is not a stable API. Unknown or mismatched output
// must never authorize an operation. Only fixed argv (never a shell) is used.
private func launch(_ args: [String], seconds: Double = 2, asUID: UInt32? = nil) -> LaunchResult {
    var executable = "/bin/launchctl", arguments = args
    if let uid = asUID {
        if geteuid() == 0 {
            guard let own = canonicalPath(CommandLine.arguments[0]) else { return LaunchResult(code:-1,text:"",timedOut:false) }
            executable = own; arguments = ["--user-launchctl",String(uid)]+args
        } else if geteuid() != uid { return LaunchResult(code:-1,text:"",timedOut:false) }
    }
    var fds = [Int32](repeating:-1,count:2)
    guard pipe(&fds) == 0 else { return LaunchResult(code:-1,text:"",timedOut:false) }
    defer { close(fds[0]); if fds[1] >= 0 { close(fds[1]) } }
    guard fcntl(fds[0],F_SETFL,O_NONBLOCK) == 0, fcntl(fds[0],F_SETFD,FD_CLOEXEC) == 0, fcntl(fds[1],F_SETFD,FD_CLOEXEC) == 0 else { return LaunchResult(code:-1,text:"",timedOut:false) }
    var actions: posix_spawn_file_actions_t?
    guard posix_spawn_file_actions_init(&actions) == 0 else { return LaunchResult(code:-1,text:"",timedOut:false) }
    defer { posix_spawn_file_actions_destroy(&actions) }
    guard posix_spawn_file_actions_addopen(&actions,STDIN_FILENO,"/dev/null",O_RDONLY,0) == 0,
          posix_spawn_file_actions_addopen(&actions,STDERR_FILENO,"/dev/null",O_WRONLY,0) == 0,
          posix_spawn_file_actions_adddup2(&actions,fds[1],STDOUT_FILENO) == 0,
          posix_spawn_file_actions_addclose(&actions,fds[0]) == 0,
          posix_spawn_file_actions_addclose(&actions,fds[1]) == 0 else { return LaunchResult(code:-1,text:"",timedOut:false) }
    var attributes: posix_spawnattr_t?
    guard posix_spawnattr_init(&attributes) == 0 else { return LaunchResult(code:-1,text:"",timedOut:false) }
    defer { posix_spawnattr_destroy(&attributes) }
    // Isolate privileged IPC descriptors from launchctl and user workers.
    guard posix_spawnattr_setflags(&attributes,Int16(POSIX_SPAWN_CLOEXEC_DEFAULT)) == 0 else { return LaunchResult(code:-1,text:"",timedOut:false) }
    var argv = ([executable]+arguments).map { strdup($0) }+[nil]
    var environment = [strdup("PATH=/usr/bin:/bin:/usr/sbin:/sbin"),nil]
    defer { argv.compactMap{$0}.forEach{free($0)}; environment.compactMap{$0}.forEach{free($0)} }
    var pid: pid_t = 0
    let spawned = argv.withUnsafeMutableBufferPointer { a in environment.withUnsafeMutableBufferPointer { e in posix_spawn(&pid,executable,&actions,&attributes,a.baseAddress!,e.baseAddress!) } }
    guard spawned == 0 else { return LaunchResult(code:-spawned,text:"",timedOut:false) }
    close(fds[1]); fds[1] = -1
    let deadline = Date().addingTimeInterval(seconds)
    var bytes = Data(), eof = false, exited = false, expired = false, status: Int32 = 0, failed = false
    while !eof || !exited {
        if !eof {
            var buffer = [UInt8](repeating:0,count:8192); let n = Darwin.read(fds[0],&buffer,buffer.count)
            if n > 0 { bytes.append(contentsOf:buffer.prefix(n)) }
            else if n == 0 { eof = true }
            else if errno != EAGAIN && errno != EINTR { failed = true; break }
        }
        if !exited {
            let result = waitpid(pid,&status,WNOHANG)
            if result == pid { exited = true }
            else if result < 0 && errno != EINTR { failed = true; break }
        }
        if eof && exited { break }
        if bytes.count > 1024*1024 || Date() >= deadline { expired = true; break }
        usleep(2_000)
    }
    if !exited { _ = kill(pid,SIGKILL); while waitpid(pid,&status,0) < 0 && errno == EINTR {} }
    let code: Int32 = failed ? -1 : (status & 0x7f == 0 ? (status >> 8) & 0xff : 128+(status & 0x7f))
    return LaunchResult(code:code,text:String(data:bytes,encoding:.utf8) ?? "",timedOut:expired)
}
// Run GUI mutations with the target user's real credentials, not just their
// bootstrap namespace. This fresh child drops supplementary groups and UID
// before exec; no fork/Swift work occurs inside the multithreaded daemon.
func userLaunchctl(_ arguments: [String]) -> Never {
    guard geteuid() == 0, arguments.count >= 3, let uid = UInt32(arguments[0]), uid > 0, let user = getpwuid(uid) else { exit(EXIT_FAILURE) }
    let args = Array(arguments.dropFirst()), domain = "gui/\(uid)"
    guard (args.count == 3 && args[0] == "bootstrap" && args[1] == domain && args[2].hasSuffix(".plist"))
        || (args.count == 2 && args[0] == "print" && (args[1] == domain || args[1].hasPrefix(domain+"/")))
        || (args.count == 2 && args[0] == "bootout" && args[1].hasPrefix(domain+"/")) else { exit(EXIT_FAILURE) }
    let name = String(cString:user.pointee.pw_name), gid = user.pointee.pw_gid
    guard gid <= UInt32(Int32.max), initgroups(name,Int32(gid)) == 0, setgid(gid) == 0, setuid(uid) == 0, getuid() == uid, geteuid() == uid else { exit(EXIT_FAILURE) }
    var argv = (["/bin/launchctl"]+args).map { strdup($0) }+[nil]
    argv.withUnsafeMutableBufferPointer { _ = execv("/bin/launchctl",$0.baseAddress!) }
    exit(EXIT_FAILURE)
}
private func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format:"%02x",$0) }.joined() }
private func readFile(_ path: String, maximum: Int, owner: UInt32, privateFile: Bool = false) -> Data? {
    let fd = open(path,O_RDONLY|O_NONBLOCK|O_NOFOLLOW); guard fd >= 0 else { return nil }; defer { close(fd) }
    var info = stat()
    guard fstat(fd,&info) == 0, info.st_uid == owner, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
          info.st_mode & (privateFile ? 0o077:0o022) == 0, info.st_size > 0, info.st_size <= maximum else { return nil }
    var data = Data(), buffer = [UInt8](repeating:0,count:8192)
    while true { let n = Darwin.read(fd,&buffer,buffer.count); if n < 0 && errno == EINTR { continue }; if n < 0 { return nil }; if n == 0 { break }; data.append(contentsOf:buffer.prefix(n)); if data.count > maximum { return nil } }
    var after = stat()
    guard fstat(fd,&after) == 0, info.st_ino == after.st_ino, info.st_size == after.st_size, data.count == info.st_size,
          info.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, info.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else { return nil }
    return data
}
private func programHash(_ path: String) -> String? {
    let fd = open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW); guard fd >= 0 else { return nil }; defer { close(fd) }
    var before = stat(); guard fstat(fd, &before) == 0, before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), before.st_size > 0, before.st_size <= 256 * 1024 * 1024 else { return nil }
    var digest = SHA256(), buffer = [UInt8](repeating:0,count:65536)
    while true { let n = Darwin.read(fd, &buffer, buffer.count); if n < 0 { return nil }; if n == 0 { break }; digest.update(data:Data(buffer.prefix(n))) }
    var after = stat(); guard fstat(fd,&after) == 0, before.st_ino == after.st_ino, before.st_size == after.st_size, before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else { return nil }
    return digest.finalize().map { String(format:"%02x",$0) }.joined()
}
private func restartPolicy(_ value: Any?, runAtLoad: Bool) -> (String,String) {
    if let flag = value as? Bool { return flag ? ("always","服务会自动重新启动") : (runAtLoad ? "login":"demand",runAtLoad ? "登录或开机时启动":"可能由系统按需启动") }
    if let conditions = value as? [String:Any], !conditions.isEmpty {
        if conditions.count == 1, let success = conditions["SuccessfulExit"] as? Bool {
            return success ? ("successful-exit","正常退出后自动重启") : ("abnormal-exit","异常或强制结束后自动重启")
        }
        return ("conditional","满足配置条件时自动重启")
    }
    return (runAtLoad ? "login":"demand",runAtLoad ? "登录或开机时启动":"可能由系统按需启动")
}
private func config(_ path: String, domain: String, uid: UInt32) -> ServiceConfig? {
    let parent = (path as NSString).deletingLastPathComponent
    let home = getpwuid(uid).map { String(cString:$0.pointee.pw_dir) } ?? ""
    let system = domain == "system"
    guard (system && parent == "/Library/LaunchDaemons") || (domain == "gui/\(uid)" && ["/Library/LaunchAgents",home+"/Library/LaunchAgents"].contains(parent)), canonicalPath(path) == path else { return nil }
    var info = stat()
    let owner: UInt32 = parent.hasPrefix("/Library/") ? 0 : uid
    guard lstat(path,&info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_uid == owner, info.st_mode & 0o022 == 0,
          info.st_size > 0, info.st_size <= 1024 * 1024, let data = readFile(path,maximum:1024*1024,owner:owner),
          let body = try? PropertyListSerialization.propertyList(from:data,format:nil) as? [String:Any],
          let label = body["Label"] as? String, !label.isEmpty, label.utf8.count <= 256,
          label.unicodeScalars.allSatisfy({ CharacterSet(charactersIn:"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-").contains($0) }),
          !label.hasPrefix("com.apple."), !label.contains("flowhub"), body["RootDirectory"] == nil,
          let rawProgram = (body["Program"] as? String) ?? (body["ProgramArguments"] as? [String])?.first,
          rawProgram.hasPrefix("/"), let program = canonicalPath(rawProgram), thirdPartyPath(program), !protectedPrograms.contains(program) else { return nil }
    var runUID = system ? 0 : uid
    if let name = body["UserName"] as? String {
        guard let user = getpwnam(name) else { return nil }; runUID = user.pointee.pw_uid
        guard system ? (runUID == 0 || runUID == uid) : runUID == uid else { return nil }
    }
    if !system, let name = body["GroupName"] as? String {
        guard let group = getgrnam(name), let user = getpwuid(uid), group.pointee.gr_gid == user.pointee.pw_gid else { return nil }
    }
    let policy = restartPolicy(body["KeepAlive"],runAtLoad:body["RunAtLoad"] as? Bool == true)
    return ServiceConfig(id:hash(Data("\(uid):\(domain):\(label):\(path)".utf8)),label:label,domain:domain,path:path,digest:hash(data),program:program,runUID:runUID,ownerUID:uid,restart:policy.0,restartHint:policy.1)
}
private func fields(_ text: String) -> [String:String] {
    var result = [String:String]()
    for line in text.split(separator:"\n") {
        let parts = line.trimmingCharacters(in:.whitespaces).components(separatedBy:" = ")
        if parts.count == 2, ["path","program","pid","state"].contains(parts[0]) { result[parts[0]] = parts[1] }
    }
    return result
}
private func domains(_ text: String) -> [String:Int32]? {
    var inside = false, found = false, jobs = [String:Int32]()
    for line in text.split(separator:"\n") {
        let value = line.trimmingCharacters(in:.whitespaces)
        if value == "services = {" { inside = true; found = true; continue }
        if inside && value == "}" { break }
        if inside {
            let parts = value.split(whereSeparator:{$0.isWhitespace})
            guard parts.count == 3, let pid = Int32(parts[0]) else { return nil }
            jobs[String(parts[2])] = pid
        }
    }
    return found ? jobs : nil
}
private func runtime(_ c: ServiceConfig) -> (Bool,ProcessIdentity?)? {
    let result = launch(["print",c.domain+"/"+c.label],asUID:c.domain == "system" ? nil : c.ownerUID)
    guard !result.timedOut else { return nil }
    if result.code != 0 {
        // Check the domain separately; a missing/unavailable GUI is not proof
        // that a job stopped successfully.
        let check = launch(["print",c.domain],asUID:c.domain == "system" ? nil : c.ownerUID); guard check.code == 0, let jobs = domains(check.text), jobs[c.label] == nil else { return nil }
        return (false,nil)
    }
    let data = fields(result.text)
    guard data["path"] == c.path, data["program"].flatMap(canonicalPath) == c.program else { return nil }
    guard let raw = data["pid"], let pid = Int32(raw), pid > 0 else { return (true,nil) }
    guard let identity = ProcessIdentity.read(pid), identity.uid == c.runUID, canonicalPath(identity.executable) == c.program else { return nil }
    return (true,identity)
}
private func unchanged(_ plan: ServicePlan, config current: ServiceConfig?, identity: ProcessIdentity?, now: Date = Date()) -> Bool {
    now.timeIntervalSince(plan.at) >= 0 && now.timeIntervalSince(plan.at) <= 60 && current == plan.config && identity == plan.identity
}
private func validPlan(_ plan: ServicePlan, config current: ServiceConfig?, identity: ProcessIdentity?, programHash: String?, uid: UInt32, now: Date = Date()) -> Bool {
    plan.config.ownerUID == uid && plan.programHash == programHash && unchanged(plan,config:current,identity:identity,now:now)
}
private func serviceArguments(_ action: String, _ c: ServiceConfig) -> [String]? {
    switch action { case "stop": return ["bootout",c.domain+"/"+c.label]; case "resume": return ["bootstrap",c.domain,c.path]; default:return nil }
}

final class BackgroundServices: @unchecked Sendable {
    private let lock = NSLock()
    private var saved = [String:PausedService](), plans = [String:ServicePlan]()
    private var loaded = false, cache = [[String:Any]](), cacheAt = Date.distantPast
    private func load() throws {
        if loaded { return }
        var info = stat()
        if lstat(serviceJournal,&info) == 0 {
            guard info.st_uid == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_mode & 0o077 == 0, info.st_size <= 1024*1024,
                  let data = readFile(serviceJournal,maximum:1024*1024,owner:0,privateFile:true), let entries = try? JSONDecoder().decode([String:PausedService].self,from:data), entries.count <= 128 else { throw Failure.message("服务恢复记录不可读取，请检查采集服务。") }
            saved = entries
        } else if errno != ENOENT { throw Failure.message("服务恢复记录不可读取。") }
        loaded = true
    }
    private func persist() throws {
        let data = try JSONEncoder().encode(saved)
        let temporary = serviceJournal+"."+UUID().uuidString
        let fd = open(temporary,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0o600)
        guard fd >= 0 else { throw Failure.message("无法保护服务恢复记录。") }
        defer { close(fd); unlink(temporary) }
        let written = data.withUnsafeBytes { raw -> Bool in
            var offset = 0
            while offset < raw.count { let n = Darwin.write(fd,raw.baseAddress!.advanced(by:offset),raw.count-offset); if n < 0 && errno == EINTR { continue }; if n <= 0 { return false }; offset += n }
            return fsync(fd) == 0
        }
        guard written, rename(temporary,serviceJournal) == 0 else { throw Failure.message("无法保存服务恢复记录。") }
    }
    private func catalogue(_ uid: UInt32) throws -> [[String:Any]] {
        if Date().timeIntervalSince(cacheAt) < 5 { return cache }
        let home = getpwuid(uid).map { String(cString:$0.pointee.pw_dir) } ?? ""
        var jobs = [String:[String:Int32]]()
        for domain in ["system","gui/\(uid)"] {
            let result = launch(["print",domain],asUID:domain == "system" ? nil : uid)
            let failure = result.timedOut ? "超时" : result.code != 0 ? "退出码 \(result.code)" : "输出格式未识别"
            guard result.code == 0, !result.timedOut, let values = domains(result.text) else { throw Failure.message("服务登记暂不可读取（\(domain)：\(failure)），请刷新重试。") }; jobs[domain] = values
        }
        // A newly started generation proves that launchd/application restored
        // this job independently. Retire its old recovery record, not the job.
        var pruned = false
        for (id,entry) in saved where entry.config.ownerUID == uid {
            if let pid = jobs[entry.config.domain]?[entry.config.label], pid > 0, let identity = ProcessIdentity.read(pid),
               Double(identity.started)/1_000_000 > entry.at, config(entry.config.path,domain:entry.config.domain,uid:uid) == entry.config {
                saved.removeValue(forKey:id); pruned = true
            }
        }
        if pruned { try persist() }
        var configs = [String:ServiceConfig]()
        for (directory,domain) in [("/Library/LaunchDaemons","system"),("/Library/LaunchAgents","gui/\(uid)"),(home+"/Library/LaunchAgents","gui/\(uid)")] {
            for name in ((try? FileManager.default.contentsOfDirectory(atPath:directory)) ?? []).sorted().prefix(512) where name.hasSuffix(".plist") {
                if let c = config(directory+"/"+name,domain:domain,uid:uid), jobs[domain]?[c.label] != nil || saved[c.id]?.config.ownerUID == uid { configs[c.id] = c }
            }
        }
        for (id,entry) in saved where entry.config.ownerUID == uid && configs[id] == nil { configs[id] = entry.config }
        cache = configs.values.sorted(by:{$0.label < $1.label}).prefix(256).map { c in
            let registered = jobs[c.domain]?[c.label] != nil, entry = saved[c.id], matches = config(c.path,domain:c.domain,uid:uid) == c && (registered || entry?.config == c)
            let pid = jobs[c.domain]?[c.label] ?? 0
            let identity = pid > 0 ? ProcessIdentity.read(pid) : nil
            let verified = identity.map { $0.uid == c.runUID && canonicalPath($0.executable) == c.program } ?? (pid == 0)
            let lingering = !registered && entry?.original.map { ProcessIdentity.read($0.pid) == $0 } == true
            return ["id":c.id,"label":c.label,"name":(c.program as NSString).lastPathComponent,"domain":c.domain,"plistPath":c.path,"program":c.program,"appPath":c.appPath as Any? ?? NSNull(),"restart":c.restart,"restartHint":c.restartHint,"loaded":registered,"paused":!registered && entry != nil,"identity":identity.flatMap { try? JSONSerialization.jsonObject(with:JSONEncoder().encode($0)) } ?? NSNull(),"canStop":registered && matches && verified,"canResume":!registered && entry != nil && matches && !lingering,"blockedReason":matches ? (lingering ? "服务已暂停，但旧进程仍在退出中，请稍后刷新；持续存在时请按 PID 单独核对处理。" : (verified ? "":"服务进程身份无法核验，请刷新。")) : "服务配置已变化或不可读取，请从所属应用恢复。"]
        }
        cacheAt = Date(); return cache
    }
    enum Failure: Error { case message(String) }
    func handle(_ method: String, body: [String:Any], uid: UInt32) -> [String:Any] {
        guard lock.lock(before:Date().addingTimeInterval(3)) else { return ["error":"另一项服务查询或操作仍在进行，请稍后刷新重试。"] }; defer { lock.unlock() }
        do {
            try load()
            switch method {
            case "services_snapshot": return ["at":UInt64(Date().timeIntervalSince1970*1000),"services":try catalogue(uid),"supported":true]
            case "service_preview":
                guard let id = body["id"] as? String, id.count == 64, let action = body["action"] as? String, ["stop","resume"].contains(action) else { throw Failure.message("服务操作参数无效。") }
                let rows = cache.isEmpty ? try catalogue(uid) : cache
                guard var row = rows.first(where:{$0["id"] as? String == id}),
                      let path = row["plistPath"] as? String, let domain = row["domain"] as? String, let c = config(path,domain:domain,uid:uid),
                      let state = runtime(c), thirdPartyProgram(c.program), let digest = programHash(c.program) else { throw Failure.message("服务状态、配置或进程身份无法核验，请刷新。") }
                guard action == "stop" ? state.0 : !state.0 else { throw Failure.message("服务登记状态已变化，请刷新后重新确认。") }
                if action == "resume" { guard let previous = saved[id], previous.config == c, previous.programHash == digest, !state.0,
                    previous.original.map({ProcessIdentity.read($0.pid) != $0}) != false else { throw Failure.message("服务程序已更新、已经启动或旧进程仍未退出，请刷新后核实。") } }
                row["identity"] = state.1.flatMap { try? JSONSerialization.jsonObject(with:JSONEncoder().encode($0)) } ?? NSNull()
                row["program"] = c.program; row["name"] = (c.program as NSString).lastPathComponent; row["restartHint"] = c.restartHint
                row["restart"] = c.restart; row["appPath"] = c.appPath as Any? ?? NSNull(); row["loaded"] = state.0; row["paused"] = !state.0 && saved[id] != nil
                plans = plans.filter { Date().timeIntervalSince($0.value.at) <= 60 }
                guard plans.count < 32 else { throw Failure.message("待确认的服务操作过多，请稍后重试。") }
                let token = UUID().uuidString
                plans[token] = ServicePlan(config:c,programHash:digest,identity:state.1,action:action,at:Date())
                return ["token":token,"expiresIn":60,"action":action,"service":row]
            case "service_confirm":
                guard body["confirmed"] as? Bool == true, let token = body["token"] as? String, let plan = plans.removeValue(forKey:token), plan.config.ownerUID == uid,
                      let state = runtime(plan.config), validPlan(plan,config:config(plan.config.path,domain:plan.config.domain,uid:uid),identity:state.1,programHash:programHash(plan.config.program),uid:uid),
                      thirdPartyProgram(plan.config.program), let args = serviceArguments(plan.action,plan.config) else { throw Failure.message("服务确认已过期，或配置、程序、进程身份已变化，请重新确认。") }
                let id = plan.config.id
                if plan.action == "stop" {
                    guard state.0, saved[id] != nil || saved.count < 128 else { throw Failure.message("服务已停止或恢复记录已满。") }
                    saved[id] = PausedService(config:plan.config,programHash:plan.programHash,at:Date().timeIntervalSince1970,original:plan.identity)
                    try persist() // Write recovery data BEFORE unregistering a service.
                } else { guard !state.0, saved[id]?.config == plan.config, saved[id]?.original.map({ProcessIdentity.read($0.pid) != $0}) != false else { throw Failure.message("服务已启动，或原进程仍未退出，请刷新核实。") } }
                let result = launch(args,seconds:3,asUID:plan.config.domain == "system" ? nil : uid)
                cacheAt = .distantPast
                var after = runtime(plan.config)
                let verificationDeadline = Date().addingTimeInterval(2)
                // Startup may briefly report xpcproxy before exec. Recheck
                // state only; never repeat bootout/bootstrap automatically.
                while !result.timedOut && (after == nil || after?.0 != (plan.action == "resume")) && Date() < verificationDeadline {
                    usleep(25_000); after = runtime(plan.config)
                }
                guard !result.timedOut, let after, after.0 == (plan.action == "resume") else { throw Failure.message("服务操作结果尚未确认，请刷新核实状态，不要连续重复操作。") }
                guard result.code == 0 else { throw Failure.message("系统拒绝服务操作（launchctl \(result.code)），请刷新核实状态。") }
                if plan.action == "resume" { saved.removeValue(forKey:id); try persist() }
                return ["ok":true,"action":plan.action,"message":plan.action == "stop" ? "后台服务已暂停，可在后台服务列表恢复启动。":"后台服务已重新登记；将按原配置启动或等待触发。"]
            default: throw Failure.message("不支持的服务操作。")
            }
        } catch Failure.message(let message) { return ["error":message] }
        catch { return ["error":"服务恢复记录无法保存，未确认操作结果，请刷新核实。"] }
    }
}

func servicesSelfCheck() -> Bool {
    let c = ServiceConfig(id:"fixture",label:"test.fixture",domain:"gui/501",path:"/Library/LaunchAgents/test.fixture.plist",digest:"first",program:"/Applications/Fixture.app/service",runUID:501,ownerUID:501,restart:"always",restartHint:"")
    let identity = ProcessIdentity(pid:100,uid:501,started:10,executable:c.program)
    let plan = ServicePlan(config:c,programHash:"binary",identity:identity,action:"stop",at:Date())
    var changed = c; changed.digest = "changed"
    return restartPolicy(true,runAtLoad:false).0 == "always" && restartPolicy(["SuccessfulExit":false],runAtLoad:true).0 == "abnormal-exit"
        && serviceArguments("stop",c) == ["bootout","gui/501/test.fixture"] && serviceArguments("resume",c) == ["bootstrap","gui/501",c.path] && serviceArguments("disable",c) == nil
        && unchanged(plan,config:c,identity:identity) && !unchanged(plan,config:changed,identity:identity)
        && !unchanged(plan,config:c,identity:ProcessIdentity(pid:100,uid:501,started:11,executable:c.program))
        && !unchanged(plan,config:c,identity:identity,now:Date().addingTimeInterval(61))
        && validPlan(plan,config:c,identity:identity,programHash:"binary",uid:501)
        && !validPlan(plan,config:c,identity:identity,programHash:"updated",uid:501)
        && !validPlan(plan,config:c,identity:identity,programHash:"binary",uid:502)
}

#if FLOWHUB_CONTROL_TESTS
func servicesTransportSelfCheck() -> Bool {
    for n in 0..<20 {
        let domain = n % 2 == 0 ? "system" : "gui/\(getuid())"
        let result = launch(["print",domain])
        guard !result.timedOut, result.code == 0, domains(result.text) != nil else { return false }
    }
    return true
}
#endif

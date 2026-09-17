//! Local socket inspection. No shell, no privilege escalation, no arbitrary commands.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortProcess {
    pid: u32,
    name: String,
    user: String,
    executable: String,
    started_at: String,
    elapsed: String,
    sockets: Vec<String>,
    identity: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortReport {
    port: u16,
    processes: Vec<PortProcess>,
    visibility: String,
}

fn run(path: &str, args: &[String]) -> Result<(bool, String, String), String> {
    let mut child = Command::new(path)
        .args(args)
        .env("LC_ALL", "C")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法执行 {path}: {e}"))?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let stdout = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let stderr = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout.join();
            let _ = stderr.join();
            return Err("端口检查超时，请重试".into());
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    Ok((
        status.success(),
        String::from_utf8_lossy(&stdout.join().unwrap_or_default()).into_owned(),
        String::from_utf8_lossy(&stderr.join().unwrap_or_default())
            .trim()
            .into(),
    ))
}

fn parse_lsof(text: &str, port: u16, protocol: &str, rows: &mut BTreeMap<u32, PortProcess>) {
    let mut pid = None;
    for line in text.lines() {
        let Some((tag, value)) = line.split_at_checked(1) else {
            continue;
        };
        match tag {
            "p" => {
                pid = value.parse::<u32>().ok();
                if let Some(pid) = pid {
                    rows.entry(pid).or_insert(PortProcess {
                        pid,
                        name: String::new(),
                        user: String::new(),
                        executable: String::new(),
                        started_at: String::new(),
                        elapsed: String::new(),
                        sockets: vec![],
                        identity: String::new(),
                    });
                }
            }
            "c" | "L" | "n" => {
                if let Some(row) = pid.and_then(|pid| rows.get_mut(&pid)) {
                    match tag {
                        "c" => row.name = value.into(),
                        "L" => row.user = value.into(),
                        "n" => {
                            let local = value.split("->").next().unwrap_or("");
                            if local.ends_with(&format!(":{port}")) {
                                let socket = format!("{protocol} {local}");
                                if !row.sockets.contains(&socket) {
                                    row.sockets.push(socket);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
}
// Read all fields in one snapshot, preserving spaces in the executable column.
fn parse_ps(text: &str) -> BTreeMap<u32, (String, String, String)> {
    let mut result = BTreeMap::new();
    for line in text.lines() {
        let mut remaining = line.trim();
        let mut fields = vec![];
        for _ in 0..7 {
            let end = remaining
                .find(char::is_whitespace)
                .unwrap_or(remaining.len());
            fields.push(&remaining[..end]);
            remaining = remaining[end..].trim_start();
        }
        if let Ok(pid) = fields[0].parse::<u32>() {
            if !fields[6].is_empty() && !remaining.is_empty() {
                result.insert(
                    pid,
                    (fields[1..6].join(" "), fields[6].into(), remaining.into()),
                );
            }
        }
    }
    result
}
fn process_snapshots(pids: &[u32]) -> Result<BTreeMap<u32, (String, String, String)>, String> {
    let mut result = BTreeMap::new();
    // Bound command-line length even when a port has many owners.
    for chunk in pids.chunks(128) {
        let (ok, out, err) = run(
            "/bin/ps",
            &[
                "-ww".into(),
                "-p".into(),
                chunk
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
                "-o".into(),
                "pid=,lstart=,etime=,comm=".into(),
            ],
        )?;
        if !ok && !err.is_empty() {
            return Err(format!("读取进程信息失败：{err}"));
        }
        result.extend(parse_ps(&out));
    }
    Ok(result)
}
fn inspect(port: u16) -> Result<PortReport, String> {
    if port == 0 {
        return Err("端口范围应为 1–65535".into());
    }
    if !cfg!(target_os = "macos") {
        return Err("本机端口查询目前支持 macOS；可复制 Linux 命令在堡垒机执行".into());
    }
    let mut rows = BTreeMap::new();
    for protocol in ["TCP", "UDP"] {
        let mut args = vec![
            "-nP".into(),
            format!("-i{protocol}:{port}"),
            "-FpcLn".into(),
        ];
        if protocol == "TCP" {
            args.push("-sTCP:LISTEN".into());
        }
        let (ok, out, err) = run("/usr/sbin/lsof", &args)?;
        if !ok && !err.is_empty() {
            return Err(format!("无法完整检查端口：{err}"));
        }
        parse_lsof(&out, port, protocol, &mut rows);
    }
    let pids = rows
        .values()
        .filter(|row| !row.sockets.is_empty())
        .map(|row| row.pid)
        .collect::<Vec<_>>();
    let mut snapshots = process_snapshots(&pids)?;
    let mut processes = vec![];
    for (_, mut row) in rows {
        if row.sockets.is_empty() {
            continue;
        }
        let Some((started, elapsed, executable)) = snapshots.remove(&row.pid) else {
            continue;
        };
        row.started_at = started;
        row.elapsed = elapsed;
        row.executable = executable;
        row.identity = format!(
            "{:x}",
            Sha256::digest(format!(
                "{}:{}:{}:{}",
                row.pid, row.started_at, row.user, row.executable
            ))
        );
        processes.push(row);
    }
    Ok(PortReport {
        port,
        processes,
        visibility: "仅检查本机 TCP 监听与 UDP 绑定；其他用户进程可能受系统权限限制。".into(),
    })
}

#[tauri::command]
pub async fn inspect_port(port: u16) -> Result<PortReport, String> {
    tauri::async_runtime::spawn_blocking(move || inspect(port))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn terminate_port_process(
    port: u16,
    pid: u32,
    identity: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || terminate(port, pid, &identity))
        .await
        .map_err(|e| e.to_string())?
}
fn terminate(port: u16, pid: u32, identity: &str) -> Result<String, String> {
    if pid <= 1 || pid == std::process::id() {
        return Err("不能结束系统初始进程或 FlowHub 自身".into());
    }
    let report = inspect(port)?;
    let process = report
        .processes
        .iter()
        .find(|p| p.pid == pid)
        .ok_or("该进程已退出或不再占用此端口，请刷新")?;
    if identity.is_empty() || process.identity != identity {
        return Err("进程身份已变化，请刷新后重新选择".into());
    }
    let (ok, _, err) = run("/bin/kill", &["-TERM".into(), pid.to_string()])?;
    if !ok {
        return Err(format!("无法结束进程：{err}"));
    }
    Ok(format!(
        "已向 PID {pid} 发送 SIGTERM；进程可能需要时间退出，请刷新确认。"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_batch_snapshot_with_spaced_paths() {
        let rows = parse_ps("42 Mon Sep  7 16:00:00 2026 09-18:48:04 /Applications/My App/bin\n43 Mon Sep 7 16:00:00 2026 00:01 /usr/bin/test\n");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[&42].0, "Mon Sep 7 16:00:00 2026");
        assert_eq!(rows[&42].1, "09-18:48:04");
        assert_eq!(rows[&42].2, "/Applications/My App/bin");
        assert!(parse_ps("invalid").is_empty());
    }
    #[test]
    fn parses_ipv4_ipv6_and_ignores_remote_port() {
        let mut rows = BTreeMap::new();
        parse_lsof("p42\ncnode\nLuser\nn*:9000\nn[::1]:9000\nn127.0.0.1:51234->127.0.0.1:9000\np43\ncother\nn*:9001\n",9000,"TCP",&mut rows);
        assert_eq!(rows[&42].sockets.len(), 2);
        assert!(rows[&43].sockets.is_empty());
    }
    #[test]
    fn rejects_zero_and_protected_pid() {
        assert!(inspect(0).is_err());
        assert!(terminate(9000, 1, "").is_err());
        assert!(terminate(9000, std::process::id(), "").is_err());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn inspects_and_terminates_only_its_own_test_process() {
        use std::io::{BufRead, BufReader};
        struct TestChild(std::process::Child);
        impl Drop for TestChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        // Force the first UDP collision to exercise retry on every run. The
        // child reserves both protocols before publishing its selected port.
        let script = include_str!("../tests/port_listener.py");
        let mut child = TestChild(
            Command::new("python3")
                .args(["-u", "-c", script, "1"])
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut line = String::new();
        BufReader::new(child.0.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let port = line.trim().parse().unwrap();
        let report = inspect(port).unwrap();
        let row = report
            .processes
            .iter()
            .find(|p| p.pid == child.0.id())
            .expect("test listener missing");
        assert!(!row.started_at.is_empty());
        assert!(!row.elapsed.is_empty());
        assert_eq!(row.sockets.len(), 2);
        assert!(terminate(port, row.pid, "stale-identity").is_err());
        assert!(child.0.try_wait().unwrap().is_none());
        terminate(port, row.pid, &row.identity).unwrap();
        for _ in 0..30 {
            if child.0.try_wait().unwrap().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("SIGTERM did not stop the test listener");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn listener_port_conflicts_have_a_bounded_failure_path() {
        let output = Command::new("python3")
            .args(["-u", "-c", include_str!("../tests/port_listener.py"), "32"])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("exhausted after 32 attempts"));
    }
}

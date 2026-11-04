use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::{fd::AsRawFd, unix::net::UnixStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::Duration,
};

const LABEL: &str = "cn.ac.camellia.flowhub.resource-monitor";
const HELPER_DIR: &str = "/Library/PrivilegedHelperTools/cn.ac.camellia.flowhub.resource-monitor";
const INSTALLED_HELPER: &str =
    "/Library/PrivilegedHelperTools/cn.ac.camellia.flowhub.resource-monitor/daemon";
const PLIST: &str = "/Library/LaunchDaemons/cn.ac.camellia.flowhub.resource-monitor.plist";
const SOCKET: &str = "/var/run/cn.ac.camellia.flowhub.resource-monitor.sock";
static INSTALLATION: Mutex<()> = Mutex::new(());

fn bundled_helper() -> Option<PathBuf> {
    // Resolve from the running bundle, never from a plugin-supplied path.
    let executable = std::env::current_exe().ok()?;
    let contents = executable.parent()?.parent()?;
    let path = contents.join("Resources/FlowHubResourceMonitorHelper/daemon");
    path.is_file().then_some(path)
}

fn digest(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|_| "无法读取系统进程采集器，请重新安装 FlowHub。")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn running() -> bool {
    let Ok(mut stream) = UnixStream::connect(SOCKET) else {
        return false;
    };
    let mut uid = 0;
    let mut gid = 0;
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 || uid != 0 {
        return false;
    }
    let timeout = Some(Duration::from_secs(2));
    if stream.set_read_timeout(timeout).is_err()
        || stream.set_write_timeout(timeout).is_err()
        || stream.write_all(b"{\"method\":\"status\"}\n").is_err()
    {
        return false;
    }
    let mut response = String::new();
    let mut reader = BufReader::new(std::io::Read::take(stream, 4096));
    if reader.read_line(&mut response).is_err() {
        return false;
    }
    let Ok(value) = serde_json::from_str::<Value>(&response) else {
        return false;
    };
    value["service"] == LABEL && value["protocolVersion"] == 1 && value["uid"] == 0
}

fn status() -> Value {
    if running() {
        let needs_update = bundled_helper().and_then(|source| digest(&source).ok())
            != digest(Path::new(INSTALLED_HELPER)).ok();
        if needs_update {
            return json!({"ok":true,"status":"needsUpdate","message":"系统进程采集服务需要更新。请通过管理员授权安装当前版本。"});
        }
        return json!({"ok":true,"status":"enabled","message":"系统进程采集已启用。只读服务以 root 身份运行，可随时停用并卸载。"});
    }
    if bundled_helper().is_none() {
        return json!({"ok":false,"status":"missingHelper","message":"当前应用包缺少系统进程采集器，请重新构建或安装包含此功能的 FlowHub。"});
    }
    if Path::new(PLIST).exists() || Path::new(INSTALLED_HELPER).exists() {
        return json!({"ok":true,"status":"needsRepair","message":"系统进程采集服务未运行。请重新授权以修复，或停用并卸载服务。"});
    }
    json!({"ok":true,"status":"notRegistered","message":"启用系统进程采集需管理员授权。macOS 将弹出系统认证窗口，安装只读采集服务。"})
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn applescript_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    )
}

fn root_script(source: Option<(&Path, &str)>) -> String {
    // Destinations and operations are fixed by the host. The bundled source
    // path is quoted at both language boundaries and verified after staging.
    let mut script = format!(
        r#"set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
unset PERL5LIB PERL5OPT ENV BASH_ENV CDPATH
umask 077
helper_dir={helper_dir}
helper={helper}
plist={plist}
service={label}
for directory in /Library/PrivilegedHelperTools /Library/LaunchDaemons; do
  [ ! -L "$directory" ] || {{ echo '系统服务目录不能是符号链接。' >&2; exit 1; }}
  if [ -e "$directory" ]; then
    [ -d "$directory" ] && [ "$(/usr/bin/stat -f %u "$directory")" = 0 ] || exit 1
    permissions=$(/usr/bin/stat -f %Lp "$directory")
    [ $((0$permissions & 0022)) = 0 ] || {{ echo '系统服务目录权限不安全。' >&2; exit 1; }}
  else
    /usr/bin/install -d -o root -g wheel -m 0755 "$directory"
  fi
done
[ ! -L "$helper_dir" ] || {{ echo '采集器目录不能是符号链接。' >&2; exit 1; }}
if [ -e "$helper_dir" ]; then
  [ -d "$helper_dir" ] && [ "$(/usr/bin/stat -f %u "$helper_dir")" = 0 ] || exit 1
  permissions=$(/usr/bin/stat -f %Lp "$helper_dir")
  [ $((0$permissions & 0022)) = 0 ] || exit 1
fi
[ ! -L "$plist" ] || {{ echo '服务配置不能是符号链接。' >&2; exit 1; }}
"#,
        helper_dir = shell_quote(HELPER_DIR),
        helper = shell_quote(INSTALLED_HELPER),
        plist = shell_quote(PLIST),
        label = shell_quote(LABEL)
    );
    if let Some((source, expected_digest)) = source {
        script.push_str(&format!(r#"stage=$(/usr/bin/mktemp -d /Library/PrivilegedHelperTools/.flowhub-monitor.XXXXXX)
trap '/bin/rm -rf "$stage"' EXIT
/usr/bin/install -o root -g wheel -m 0755 {source} "$stage/daemon"
actual=$(/usr/bin/shasum -a 256 "$stage/daemon")
[ "${{actual%% *}}" = {digest} ] || {{ echo '采集器在授权期间发生变化，已停止安装。' >&2; exit 1; }}
/usr/bin/codesign --verify --strict "$stage/daemon"
cat > "$stage/service.plist" <<'FLOWHUB_SERVICE_PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{label}</string>
<key>ProgramArguments</key><array><string>{helper}</string></array>
<key>UserName</key><string>root</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ProcessType</key><string>Background</string>
<key>Umask</key><integer>63</integer>
</dict></plist>
FLOWHUB_SERVICE_PLIST
/usr/bin/plutil -lint "$stage/service.plist" >/dev/null
/usr/bin/install -d -o root -g wheel -m 0755 "$helper_dir"
if /bin/launchctl print "system/$service" >/dev/null 2>&1; then
  /bin/launchctl bootout "system/$service"
fi
/bin/rm -f "$helper"
/bin/mv "$stage/daemon" "$helper"
/bin/rm -f "$plist"
/usr/bin/install -o root -g wheel -m 0644 "$stage/service.plist" "$plist"
/bin/launchctl enable "system/$service"
/bin/launchctl bootstrap system "$plist"
"#,
            source = shell_quote(&source.to_string_lossy()), digest = shell_quote(expected_digest),
            label = LABEL, helper = INSTALLED_HELPER));
    } else {
        script.push_str(
            r#"if /bin/launchctl print "system/$service" >/dev/null 2>&1; then
  /bin/launchctl bootout "system/$service"
fi
/bin/rm -f "$plist" "$helper"
if [ -d "$helper_dir" ]; then /bin/rmdir "$helper_dir"; fi
if [ -S /var/run/cn.ac.camellia.flowhub.resource-monitor.sock ]; then
  /bin/rm -f /var/run/cn.ac.camellia.flowhub.resource-monitor.sock
fi
"#,
        );
    }
    script
}

fn authorize(script: &str, installing: bool) -> Result<bool, String> {
    let prompt = if installing {
        "FlowHub 需要安装只读的系统进程采集服务，以查看其他用户和 root 进程的资源占用。"
    } else {
        "FlowHub 需要停止并卸载系统进程采集服务。"
    };
    let apple_script = format!(
        "do shell script {} with prompt {} with administrator privileges\n",
        applescript_quote(script),
        applescript_quote(prompt)
    );
    let mut process = Command::new("/usr/bin/osascript")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "无法打开 macOS 管理员认证窗口。")?;
    process
        .stdin
        .take()
        .ok_or("无法请求管理员认证。")?
        .write_all(apple_script.as_bytes())
        .map_err(|_| "无法请求管理员认证。")?;
    let result = process
        .wait_with_output()
        .map_err(|_| "管理员授权任务未完成。")?;
    if result.status.success() {
        return Ok(true);
    }
    let error = String::from_utf8_lossy(&result.stderr);
    if error.contains("(-128)") {
        return Ok(false);
    }
    // Never include script source, authentication data, or unrelated output.
    let detail = error
        .split("execution error: ")
        .nth(1)
        .unwrap_or("系统拒绝了安装或卸载请求。")
        .trim();
    Err(format!(
        "系统进程采集服务操作失败：{}",
        detail.chars().take(400).collect::<String>()
    ))
}

pub(super) fn invoke(action: &str) -> Result<Value, String> {
    if action == "status" {
        return Ok(status());
    }
    let _guard = INSTALLATION
        .try_lock()
        .map_err(|_| "另一项系统采集授权操作正在进行，请完成系统认证后重试。")?;
    let source = if action == "enable" {
        let path =
            bundled_helper().ok_or("当前应用包缺少系统进程采集器，请重新构建或安装 FlowHub。")?;
        let hash = digest(&path)?;
        Some((path, hash))
    } else {
        None
    };
    let script = root_script(
        source
            .as_ref()
            .map(|(path, hash)| (path.as_path(), hash.as_str())),
    );
    if !authorize(&script, action == "enable")? {
        let mut value = status();
        value["message"] = "已取消管理员授权。".into();
        return Ok(value);
    }
    if action == "enable" {
        for _ in 0..30 {
            if running() {
                return Ok(status());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        return Err("服务已安装，但尚未响应。请检查系统设置 → 通用 → 登录项与扩展中的后台服务限制，然后重试。".into());
    }
    if running() {
        return Err("采集服务仍在运行，卸载未完成。".into());
    }
    let mut value = status();
    value["message"] = "系统进程采集服务已停止并卸载，当前使用普通用户权限采集。".into();
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_script_quotes_source_and_requires_matching_content() {
        let path = Path::new("/tmp/FlowHub '$(touch should-not-exist)' app/daemon");
        let script = root_script(Some((path, "abc123")));
        for candidate in [&script, &root_script(None)] {
            let mut child = Command::new("/bin/sh")
                .arg("-n")
                .stdin(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(candidate.as_bytes())
                .unwrap();
            assert!(child.wait().unwrap().success());
        }
        let output = Command::new("/bin/sh")
            .args([
                "-c",
                &format!("printf %s {}", shell_quote(&path.to_string_lossy())),
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            path.to_string_lossy()
        );

        // Compile, without executing, the real nested AppleScript/shell request.
        let output_path =
            std::env::temp_dir().join(format!("flowhub-auth-{}.scpt", std::process::id()));
        let mut child = Command::new("/usr/bin/osacompile")
            .arg("-o")
            .arg(&output_path)
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let source = format!(
            "do shell script {} with prompt \"FlowHub\" with administrator privileges",
            applescript_quote(&script)
        );
        child
            .stdin
            .take()
            .unwrap()
            .write_all(source.as_bytes())
            .unwrap();
        let result = child.wait().unwrap();
        let _ = fs::remove_file(output_path);
        assert!(result.success());
    }
}

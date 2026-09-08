use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

fn validated_url(input: &str) -> Result<String, String> {
    let url = url::Url::parse(input).map_err(|_| "网页链接格式不正确")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("仅支持 http(s) 网页链接".into());
    }
    Ok(url.to_string())
}

#[cfg(target_os = "macos")]
fn reuse_arc(url: &str) -> &'static str {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSBundle, NSString, NSURL};
    use std::{
        io::Read,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let Some(target) = NSURL::URLWithString(&NSString::from_str(url)) else {
        return "invalid_url";
    };
    let Some(browser) = NSWorkspace::sharedWorkspace().URLForApplicationToOpenURL(&target) else {
        return "unsupported_browser";
    };
    let identifier = NSBundle::bundleWithURL(&browser)
        .and_then(|bundle| bundle.bundleIdentifier())
        .map(|id| id.to_string());
    if identifier.as_deref() != Some("company.thebrowser.Browser") {
        return "unsupported_browser";
    }
    // Static source and a separate argv value: URLs never become executable code.
    let Ok(mut child) = Command::new("/usr/bin/osascript")
        .args(["-e", include_str!("arc_reuse.applescript"), "--", url])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    else {
        return "unavailable";
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let mut error = String::new();
                    if let Some(stderr) = child.stderr.take() {
                        let _ = stderr.take(4096).read_to_string(&mut error);
                    }
                    return if error.contains("-1743") {
                        "permission_denied"
                    } else {
                        "automation_failed"
                    };
                }
                let mut output = String::new();
                if let Some(stdout) = child.stdout.take() {
                    let _ = stdout.take(128).read_to_string(&mut output);
                }
                return match output.trim() {
                    "reused" => "reused",
                    "opened" => "opened",
                    "not_found" => "not_found",
                    "not_running" => "not_running",
                    _ => "automation_failed",
                };
            }
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return "automation_failed";
            }
        }
        if started.elapsed() >= Duration::from_secs(8) {
            let _ = child.kill();
            let _ = child.wait();
            return "timeout";
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

static OPEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn open(app: &AppHandle, input: &str) -> Result<Value, String> {
    let _guard = OPEN_LOCK.lock().map_err(|_| "网页打开状态异常")?;
    let url = validated_url(input)?;
    let state = app.state::<crate::AppState>();
    let config = crate::hydrated_config(&state)?;
    let enabled = config
        .pointer("/core/reuseBrowserTabs")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let started = std::time::Instant::now();
    #[cfg(target_os = "macos")]
    let outcome = if enabled { reuse_arc(&url) } else { "disabled" };
    #[cfg(not(target_os = "macos"))]
    let outcome = if enabled {
        "unsupported_platform"
    } else {
        "disabled"
    };
    if !matches!(outcome, "reused" | "opened") {
        app.opener()
            .open_url(&url, None::<&str>)
            .map_err(|e| e.to_string())?;
    }
    let report = json!({"ok": true, "reused": outcome == "reused", "reason": outcome, "elapsedMs": started.elapsed().as_millis()});
    crate::diagnostics::record_event(app, "web_open", report.clone());
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retains_path_query_fragment_and_literal_script_characters() {
        assert_eq!(
            validated_url("https://EXAMPLE.com").unwrap(),
            "https://example.com/"
        );
        assert_ne!(
            validated_url("https://example.com/A").unwrap(),
            validated_url("https://example.com/a").unwrap()
        );
        for url in [
            "https://example.com/?a=1&a=2#tab",
            "https://example.com/?x=$(touch%20/tmp/no)",
        ] {
            assert_eq!(validated_url(url).unwrap(), url);
        }
        for url in [
            "file:///tmp/a",
            "javascript:alert(1)",
            "https://",
            "invalid",
        ] {
            assert!(validated_url(url).is_err());
        }
    }
}

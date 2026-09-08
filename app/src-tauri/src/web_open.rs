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

#[cfg(any(target_os = "macos", test))]
#[derive(Clone)]
struct TabHint {
    url: String,
    window: String,
    tab: String,
    at: std::time::Instant,
}
#[cfg(any(target_os = "macos", test))]
#[derive(Default)]
struct TabHints(std::collections::VecDeque<TabHint>);
#[cfg(any(target_os = "macos", test))]
impl TabHints {
    fn take(&mut self, url: &str, now: std::time::Instant) -> Option<TabHint> {
        self.0.retain(|hint| {
            now.saturating_duration_since(hint.at) < std::time::Duration::from_secs(60)
        });
        self.0
            .iter()
            .position(|hint| hint.url == url)
            .and_then(|i| self.0.remove(i))
    }
    fn put(&mut self, hint: TabHint) {
        if hint.url.len() > 8192 {
            return;
        }
        self.0.retain(|old| old.url != hint.url);
        if self.0.len() >= 32 {
            self.0.pop_front();
        }
        self.0.push_back(hint);
    }
}
#[cfg(target_os = "macos")]
static TAB_HINTS: std::sync::Mutex<TabHints> =
    std::sync::Mutex::new(TabHints(std::collections::VecDeque::new()));

#[cfg(target_os = "macos")]
fn reuse_arc(url: &str, lookup: &mut &'static str) -> &'static str {
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
    let hint = TAB_HINTS
        .lock()
        .ok()
        .and_then(|mut cache| cache.take(url, Instant::now()));
    // Static source and separate argv values: URLs never become executable code.
    let mut command = Command::new("/usr/bin/osascript");
    command.args(["-e", include_str!("arc_reuse.applescript"), "--", url]);
    if let Some(hint) = hint {
        command.args([hint.window, hint.tab]);
    }
    let Ok(mut child) = command
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
                    let _ = stdout.take(512).read_to_string(&mut output);
                }
                let fields: Vec<_> = output.trim().split('\t').collect();
                if fields.len() == 4 && matches!(fields[0], "reused" | "opened") {
                    *lookup = match fields[3] {
                        "cache" => "cache",
                        "active" => "active",
                        "scan" => "scan",
                        "created" => "created",
                        _ => "none",
                    };
                    if !fields[1].is_empty() && !fields[2].is_empty() {
                        if let Ok(mut cache) = TAB_HINTS.lock() {
                            cache.put(TabHint {
                                url: url.into(),
                                window: fields[1].into(),
                                tab: fields[2].into(),
                                at: Instant::now(),
                            });
                        }
                    }
                }
                return match fields[0] {
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
    let started = std::time::Instant::now();
    let _guard = OPEN_LOCK.lock().map_err(|_| "网页打开状态异常")?;
    let url = validated_url(input)?;
    let state = app.state::<crate::AppState>();
    let config_started = std::time::Instant::now();
    // This preference is in the config file; opening a URL needs no catalog hydration.
    let config = crate::read_json(&state.paths().config_path).unwrap_or(Value::Null);
    let enabled = config
        .pointer("/core/reuseBrowserTabs")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let config_ms = config_started.elapsed().as_secs_f64() * 1000.0;
    let browser_started = std::time::Instant::now();
    #[allow(unused_mut)]
    let mut lookup = "none";
    #[cfg(target_os = "macos")]
    let outcome = if enabled {
        reuse_arc(&url, &mut lookup)
    } else {
        "disabled"
    };
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
    let report = json!({"ok": true, "reused": outcome == "reused", "reason": outcome, "elapsedMs": started.elapsed().as_millis(), "configMs": config_ms, "browserMs": browser_started.elapsed().as_millis(), "lookup": lookup});
    crate::diagnostics::record_event(app, "web_open", report.clone());
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hints_expire_are_bounded_and_are_consumed_before_validation() {
        let now = std::time::Instant::now();
        let mut cache = TabHints::default();
        for i in 0..40 {
            cache.put(TabHint {
                url: format!("https://example.com/{i}"),
                window: "w".into(),
                tab: i.to_string(),
                at: now,
            });
        }
        assert_eq!(cache.0.len(), 32);
        assert!(cache.take("https://example.com/0", now).is_none());
        assert_eq!(cache.take("https://example.com/39", now).unwrap().tab, "39");
        assert!(cache.take("https://example.com/39", now).is_none());
        assert!(cache
            .take(
                "https://example.com/38",
                now + std::time::Duration::from_secs(60)
            )
            .is_none());
        assert!(cache.0.is_empty());
        cache.put(TabHint {
            url: "x".repeat(8193),
            window: "w".into(),
            tab: "t".into(),
            at: now,
        });
        assert!(cache.0.is_empty());
    }
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

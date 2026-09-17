//! Launch application bundles and report Launch Services failures to the UI.
use std::{path::Path, process::Command};

pub fn launch(path: &str) -> Result<(), String> {
    let bundle = Path::new(path);
    if !bundle.is_absolute() || bundle.extension().is_none_or(|ext| ext != "app") {
        return Err("无效的应用路径".into());
    }
    if !bundle.is_dir() {
        return Err("应用已移动或删除，请重新搜索后打开".into());
    }
    // The opener plugin uses a detached child and cannot report a nonzero
    // `open` exit status. Waiting here is safe: the caller uses spawn_blocking.
    let output = Command::new("/usr/bin/open").arg("-a").arg(bundle)
        .output().map_err(|error| format!("无法启动应用：{error}"))?;
    if output.status.success() { return Ok(()); }
    let reason = String::from_utf8_lossy(&output.stderr);
    let reason = reason.trim();
    Err(if reason.is_empty() { "macOS 未能打开该应用".into() }
        else { format!("无法打开应用：{reason}") })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_and_missing_bundles_before_launch() {
        assert!(launch("Calculator").unwrap_err().contains("无效"));
        assert!(launch("/etc/hosts").unwrap_err().contains("无效"));
        let missing = std::env::temp_dir().join(format!("flowhub-missing-{}.app",std::process::id()));
        assert!(launch(missing.to_str().unwrap()).unwrap_err().contains("移动或删除"));
    }
    #[test]
    fn reports_launch_services_failure_for_an_invalid_bundle() {
        let dir = std::env::temp_dir().join(format!("flowhub-invalid-bundle-{}.app",std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let result = launch(dir.to_str().unwrap());
        std::fs::remove_dir(&dir).unwrap();
        assert!(result.unwrap_err().contains("无法打开应用"));
    }
}

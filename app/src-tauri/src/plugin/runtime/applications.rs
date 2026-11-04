//! Reuse the launcher's application index and native icon cache for the monitor.
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Component, Path},
};
use tauri::Manager;

fn requested_paths(params: &Value) -> Result<Vec<String>, String> {
    if params.to_string().len() > 65536 {
        return Err("应用信息请求过大".into());
    }
    let paths = params["paths"]
        .as_array()
        .filter(|paths| paths.len() <= 128)
        .ok_or("单次最多读取 128 个应用的信息")?;
    let mut unique = HashSet::new();
    let mut result = Vec::new();
    for value in paths {
        let path = value
            .as_str()
            .filter(|s| s.len() <= 4096 && s.ends_with(".app"))
            .ok_or("应用路径无效")?;
        if !Path::new(path).is_absolute()
            || Path::new(path)
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            return Err("应用路径无效".into());
        }
        if unique.insert(path) {
            result.push(path.to_string());
        }
    }
    Ok(result)
}

fn match_index(index: &[Value], paths: &[String]) -> Vec<(String, Value)> {
    paths
        .iter()
        .filter_map(|path| {
            let exact = index
                .iter()
                .find(|item| item["path"].as_str() == Some(path));
            let matched = exact.or_else(|| {
                let canonical = Path::new(path).canonicalize().ok()?;
                index.iter().find(|item| {
                    item["path"]
                        .as_str()
                        .and_then(|p| Path::new(p).canonicalize().ok())
                        .as_ref()
                        == Some(&canonical)
                })
            })?;
            Some((path.clone(), matched.clone()))
        })
        .collect()
}

fn resolve_applications(index: &[Value], paths: &[String]) -> Vec<(String, Value)> {
    let mut matched = match_index(index, paths);
    let missing: Vec<_> = paths
        .iter()
        .filter(|path| !matched.iter().any(|(requested, _)| requested == *path))
        .cloned()
        .collect();
    // The launcher index is intentionally scoped to its search directories and
    // may still be refreshing. Resolve exact missing bundle paths with the same
    // scanner rather than guessing by executable name or adding launcher entries.
    let supplemental = crate::scan_application_paths(&missing);
    matched.extend(match_index(&supplemental, &missing));
    matched
}

pub(super) async fn metadata(app: tauri::AppHandle, params: &Value) -> Result<Value, String> {
    let paths = requested_paths(params)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let empty = state.application_index.read().unwrap().is_empty();
        if empty { crate::refresh_application_index(&app); }
        let index = state.application_index.read().unwrap().clone();
        let matched = resolve_applications(&index, &paths);
        let icon_paths: Vec<_> = matched.iter().filter_map(|(_, item)| item["path"].as_str().map(str::to_string)).collect();
        let icons = crate::application_icon_data_urls(&state, &icon_paths);
        json!({"applications": matched.iter().map(|(requested, item)| json!({
            "path": requested, "name": item["title"], "bundleId": item["bundleId"],
            "iconUrl": item["path"].as_str().and_then(|path| icons.get(path)).cloned().unwrap_or_default()
        })).collect::<Vec<_>>()})
    }).await.map_err(|_| "应用信息读取失败".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    fn unindexed_input_method_uses_localized_bundle_metadata_by_exact_path() {
        let root = std::env::temp_dir().join(format!(
            "flowhub-app-metadata-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let bundle = root.join("Library/Input Methods/WeType.app");
        let contents = bundle.join("Contents");
        std::fs::create_dir_all(contents.join("Resources")).unwrap();
        std::fs::write(contents.join("Info.plist"), r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.flowhub.input-method-test</string><key>CFBundleName</key><string>InternalInputName</string><key>CFBundleExecutable</key><string>WeType</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>"#).unwrap();
        std::fs::write(
            contents.join("Resources/InfoPlist.strings"),
            "\"CFBundleDisplayName\" = \"测试输入法\";",
        )
        .unwrap();
        let path = bundle.to_string_lossy().into_owned();
        let missing = root
            .join("Elsewhere/WeType.app")
            .to_string_lossy()
            .into_owned();
        let malformed = root.join("Malformed.app");
        std::fs::create_dir_all(&malformed).unwrap();
        let paths = requested_paths(&json!({"paths":[path,missing,malformed]})).unwrap();
        let matched = resolve_applications(&[], &paths);
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].0, path);
        assert_eq!(matched[0].1["title"], "测试输入法");
        assert_eq!(matched[0].1["bundleId"], "local.flowhub.input-method-test");
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "read-only smoke for a locally installed app: set FLOWHUB_METADATA_SMOKE_PATH and FLOWHUB_METADATA_SMOKE_NAME"]
    fn installed_unindexed_application_metadata_and_icon_smoke() {
        let path = std::env::var("FLOWHUB_METADATA_SMOKE_PATH").expect("set installed app path");
        let expected =
            std::env::var("FLOWHUB_METADATA_SMOKE_NAME").expect("set expected localized name");
        let paths = requested_paths(&json!({"paths":[path]})).unwrap();
        let matched = resolve_applications(&[], &paths);
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].1["title"], expected);
        assert!(!matched[0].1["bundleId"].as_str().unwrap().is_empty());
        let icons = crate::clipboard::native_icon_data_urls(&paths);
        assert!(icons[&path].starts_with("data:image/png;base64,"));
        eprintln!(
            "Resolved {} ({}) with native PNG icon",
            expected, matched[0].1["bundleId"]
        );
    }

    #[test]
    fn application_metadata_uses_exact_index_paths_and_never_a_name_guess() {
        let index = vec![
            json!({"path":"/Applications/pcsuite.app","title":"pcsuite","bundleId":"com.vivo.pcsuite"}),
        ];
        let paths = requested_paths(&json!({"paths":["/Applications/pcsuite.app","/Applications/pcsuite.app","/Applications/Other.app"]})).unwrap();
        assert_eq!(paths.len(), 2);
        let matched = match_index(&index, &paths);
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].1["bundleId"], "com.vivo.pcsuite");
        for path in [
            "pcsuite.app",
            "/Applications/../private/Test.app",
            "/etc/passwd",
        ] {
            assert!(requested_paths(&json!({"paths":[path]})).is_err());
        }
        assert!(requested_paths(&json!({"paths":vec!["/Applications/Example.app";129]})).is_err());
    }
}

//! Reuse the launcher's application index and native icon cache for the monitor.
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path},
    process::Command,
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
    let supplemental = crate::application_index::scan_application_paths(&missing);
    matched.extend(match_index(&supplemental, &missing));
    matched
}

// This relationship is display metadata only. Each bundle keeps its own path,
// process group and quit targets, even when a copied helper belongs to a product.
fn related_application<'a>(index: &'a [Value], item: &Value, mut team: impl FnMut(&str) -> Option<String>) -> Option<&'a Value> {
    let bundle_id = item["bundleId"].as_str()?;
    let path = item["path"].as_str()?;
    let mut candidates: Vec<_> = index.iter().filter(|parent| {
        let id = parent["bundleId"].as_str().unwrap_or("");
        id.split('.').count() >= 3 && parent["path"].as_str() != Some(path)
            && bundle_id.strip_prefix(id).is_some_and(|suffix| suffix.starts_with('.'))
    }).collect();
    let longest = candidates.iter().map(|item| item["bundleId"].as_str().unwrap().len()).max()?;
    candidates.retain(|item| item["bundleId"].as_str().unwrap().len() == longest);
    // Multiple installations are ambiguous; do not guess which copy owns it.
    if candidates.len() != 1 { return None; }
    let parent = candidates[0];
    let child_team = team(path)?;
    (team(parent["path"].as_str()?).as_ref() == Some(&child_team)).then_some(parent)
}

fn signing_team(path: &str) -> Option<String> {
    let output = Command::new("/usr/bin/codesign").args(["-d", "--verbose=4", path]).output().ok()?;
    if !output.status.success() { return None; }
    let details = String::from_utf8_lossy(&output.stderr);
    let team = details.lines().find_map(|line| line.strip_prefix("TeamIdentifier="))?;
    (team.len() == 10 && team.bytes().all(|c| c.is_ascii_alphanumeric())).then(|| team.to_owned())
}

pub(super) async fn metadata(app: tauri::AppHandle, params: &Value) -> Result<Value, String> {
    let paths = requested_paths(params)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let empty = state.application_index.read().unwrap().is_empty();
        if empty { crate::application_index::check(&app); }
        let index = state.application_index.read().unwrap().clone();
        let matched = resolve_applications(&index, &paths);
        let mut teams = HashMap::new();
        let related: Vec<_> = matched.iter().map(|(_, item)| related_application(&index, item,
            |path| teams.entry(path.to_string()).or_insert_with(|| signing_team(path)).clone())).collect();
        let icon_paths: Vec<_> = matched.iter().map(|(_, item)| item).chain(related.iter().filter_map(|item| *item))
            .filter_map(|item| item["path"].as_str().map(str::to_string)).collect();
        let icons = crate::application_icon_data_urls(&state, &icon_paths);
        json!({"applications": matched.iter().zip(related).map(|((requested, item), related)| json!({
            "path": requested, "name": item["title"], "bundleId": item["bundleId"],
            "iconUrl": item["path"].as_str().and_then(|path| icons.get(path)).cloned().unwrap_or_default(),
            "relatedApplication": related.map(|parent| json!({"path": parent["path"], "name": parent["title"],
                "bundleId": parent["bundleId"], "evidence": "bundle-id-and-signing-team",
                "iconUrl": parent["path"].as_str().and_then(|path| icons.get(path)).cloned().unwrap_or_default()}))
        })).collect::<Vec<_>>()})
    }).await.map_err(|_| "应用信息读取失败".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn related_helpers_require_a_unique_product_identifier_and_the_same_signing_team() {
        let index = vec![json!({"path":"/Applications/QQ.app", "title":"QQ", "bundleId":"com.tencent.qq"})];
        let helper = json!({"path":"/private/QQUpdate.app", "bundleId":"com.tencent.qq.qqupdate"});
        assert_eq!(related_application(&index, &helper, |_| Some("FN2V63AD2J".into())).unwrap()["title"], "QQ");
        assert!(related_application(&index, &helper, |path| Some(if path.starts_with("/Applications") {"different"} else {"team"}.into())).is_none());
        assert!(related_application(&index, &helper, |_| None).is_none());
        assert!(related_application(&index, &json!({"path":"/WeChat.app", "bundleId":"com.tencent.wechat"}), |_| Some("FN2V63AD2J".into())).is_none());
        assert!(related_application(&index, &json!({"path":"/Other.app", "bundleId":"com.tencent.qqevil.helper"}), |_| Some("FN2V63AD2J".into())).is_none());
        let mut duplicate = index.clone();
        duplicate.push(json!({"path":"/Elsewhere/QQ.app", "bundleId":"com.tencent.qq"}));
        assert!(related_application(&duplicate, &helper, |_| Some("FN2V63AD2J".into())).is_none());
    }
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
        if let Ok(owner) = std::env::var("FLOWHUB_METADATA_SMOKE_OWNER") {
            let parents = resolve_applications(&[], &[owner.clone()]);
            let index: Vec<_> = parents.into_iter().map(|(_, item)| item).collect();
            let related = related_application(&index, &matched[0].1, signing_team).expect("signed product relationship");
            assert_eq!(related["path"], owner);
            eprintln!("Related product: {} (independent bundle/action path retained)", related["title"]);
        }
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

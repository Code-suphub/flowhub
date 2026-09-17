//! Config export/import envelopes.
//!
//! Export writes the config in the same shape the file is persisted in (the web
//! catalog lives in SQLite, so `plugins.web.settings.items` stays empty). An
//! envelope records which version wrote the file and which scope it covers, so
//! an import can say what it is rather than guessing.
//!
//! Import only parses here: applying the payload goes through the normal save
//! pipeline in the frontend, which keeps the journal, the retained history and
//! the system integrations on one path.
use crate::AppState;
use serde_json::{json, Value};

pub(crate) const FORMAT: u32 = 1;
pub(crate) const CORE_SCOPE: &str = "core";

/// Scopes an export can cover: the whole config, `core`, or one plugin.
pub(crate) fn plugin_ids(config: &Value) -> Vec<String> {
    let mut ids = config
        .pointer("/plugins")
        .and_then(Value::as_object)
        .map(|plugins| plugins.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    ids.sort();
    ids
}

pub(crate) fn known_scope(config: &Value, scope: &str) -> bool {
    scope == "all" || scope == CORE_SCOPE || plugin_ids(config).iter().any(|id| id == scope)
}

/// Keep only the requested scope, in the same nested shape as the full config
/// so an import can merge it by path.
fn scope_config(config: &Value, scope: &str) -> Result<Value, String> {
    if scope == "all" {
        return Ok(config.clone());
    }
    if scope == CORE_SCOPE {
        let mut value = serde_json::Map::new();
        value.insert("core".into(), config.get("core").cloned().unwrap_or(json!({})));
        return Ok(Value::Object(value));
    }
    if !known_scope(config, scope) {
        return Err(format!("未知的导出范围：{scope}"));
    }
    let mut plugins = serde_json::Map::new();
    plugins.insert(
        scope.to_string(),
        config
            .pointer(&format!("/plugins/{scope}"))
            .cloned()
            .unwrap_or(json!({})),
    );
    let mut value = serde_json::Map::new();
    value.insert("plugins".into(), Value::Object(plugins));
    Ok(Value::Object(value))
}

pub(crate) fn export_payload(state: &AppState, scope: &str) -> Result<Value, String> {
    let mut config = crate::storage::hydrated_config(state)?;
    // Persist the same shape the config file uses: the web catalog is SQLite state.
    if let Some(settings) = config
        .pointer_mut("/plugins/web/settings")
        .and_then(Value::as_object_mut)
    {
        settings.insert("items".into(), json!([]));
    }
    if !known_scope(&config, scope) {
        return Err(format!("未知的导出范围：{scope}"));
    }
    Ok(json!({
        "flowhubExport": FORMAT,
        "exportedAt": chrono::Utc::now().timestamp_millis(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "scope": scope,
        "config": scope_config(&config, scope)?,
    }))
}

fn validate_nodes(nodes: &[Value]) -> Result<(), String> {
    for node in nodes {
        let object = node.as_object().ok_or("目录节点必须是 JSON 对象")?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if id.is_empty() {
            return Err("每个节点都需要非空的 id".into());
        }
        for key in ["title", "url", "icon", "note", "accent"] {
            if let Some(value) = object.get(key) {
                if !value.is_string() {
                    return Err(format!("节点 {id} 的 {key} 必须是字符串"));
                }
            }
        }
        if let Some(children) = object.get("children") {
            let children = children
                .as_array()
                .ok_or_else(|| format!("节点 {id} 的 children 必须是数组"))?;
            validate_nodes(children)?;
        }
    }
    Ok(())
}

/// Web catalog nodes from a bare array, `{items:[…]}`, a full config, or an
/// export envelope — the shapes users actually have on disk.
pub(crate) fn parse_web_items(bytes: &[u8]) -> Result<Value, String> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|error| format!("不是有效 JSON：{error}"))?;
    let items = if value.is_array() {
        value
    } else if let Some(items) = value.get("items") {
        items.clone()
    } else if let Some(items) = value.pointer("/plugins/web/settings/items") {
        items.clone()
    } else if let Some(items) = value.pointer("/config/plugins/web/settings/items") {
        items.clone()
    } else {
        return Err("文件里没有找到网页目录（items 数组）".into());
    };
    let items = items.as_array().ok_or("items 必须是数组")?.clone();
    if items.is_empty() {
        return Err("文件里没有可导入的节点".into());
    }
    validate_nodes(&items)?;
    Ok(Value::Array(items))
}

pub(crate) fn suggested_file_name(scope: &str) -> String {
    let suffix = if scope == "all" { "config" } else { scope };
    format!(
        "flowhub-{suffix}-{}.json",
        chrono::Local::now().format("%Y%m%d")
    )
}

/// Accept either an exported envelope or a plain config file, so an older
/// `config.json` can still be imported.
pub(crate) fn parse_import(bytes: &[u8]) -> Result<Value, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|error| format!("不是有效 JSON：{error}"))?;
    if !value.is_object() {
        return Err("配置文件必须是 JSON 对象".into());
    }
    let (config, scope, exported_at, app_version, inferred) =
        match value.get("flowhubExport").and_then(Value::as_u64) {
            Some(format) => {
                if format != FORMAT as u64 {
                    return Err(format!("不支持的导出格式版本：{format}"));
                }
                let config = value
                    .get("config")
                    .cloned()
                    .ok_or("导出文件缺少 config 字段")?;
                if !config.is_object() {
                    return Err("导出文件里的 config 必须是 JSON 对象".into());
                }
                (
                    config,
                    value
                        .get("scope")
                        .and_then(Value::as_str)
                        .unwrap_or("all")
                        .to_string(),
                    value.get("exportedAt").and_then(Value::as_i64).unwrap_or(0),
                    value
                        .get("appVersion")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    false,
                )
            }
            None => {
                if value.get("core").is_none() && value.get("plugins").is_none() {
                    return Err("既不是 FlowHub 导出文件，也不像配置文件".into());
                }
                (value, "all".to_string(), 0, String::new(), true)
            }
        };
    // A scoped payload must still be shaped like a config fragment.
    if scope != "all" && scope != CORE_SCOPE && scope_config(&config, &scope).is_err() {
        return Err(format!("导出文件的 scope 与内容不一致：{scope}"));
    }
    Ok(json!({
        "scope": scope,
        "exportedAt": exported_at,
        "appVersion": app_version,
        "inferred": inferred,
        "config": config,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Value {
        json!({
            "core": { "hotkey": "Alt+Space" },
            "plugins": {
                "web": { "enabled": true, "settings": { "items": [{ "id": "page" }] } },
                "clipboard": { "enabled": true, "settings": { "retentionDays": 30 } },
                "memo": { "settings": {} }
            }
        })
    }

    #[test]
    fn scope_config_keeps_the_nested_shape_for_every_scope() {
        assert_eq!(scope_config(&config(), "all").unwrap(), config());
        assert_eq!(
            scope_config(&config(), "core").unwrap(),
            json!({ "core": { "hotkey": "Alt+Space" } })
        );
        assert_eq!(
            scope_config(&config(), "clipboard").unwrap(),
            json!({ "plugins": { "clipboard": { "enabled": true, "settings": { "retentionDays": 30 } } } })
        );
        assert!(scope_config(&config(), "missing").is_err());
    }

    #[test]
    fn plugin_ids_are_sorted_and_scopes_are_validated() {
        assert_eq!(plugin_ids(&config()), vec!["clipboard", "memo", "web"]);
        assert!(known_scope(&config(), "all"));
        assert!(known_scope(&config(), "core"));
        assert!(known_scope(&config(), "memo"));
        assert!(!known_scope(&config(), "tools"));
    }

    #[test]
    fn parse_accepts_an_exported_envelope() {
        let envelope = json!({
            "flowhubExport": 1,
            "exportedAt": 1758096000000i64,
            "appVersion": "0.1.11",
            "scope": "clipboard",
            "config": { "plugins": { "clipboard": { "enabled": false } } }
        });
        let parsed = parse_import(serde_json::to_vec(&envelope).unwrap().as_slice()).unwrap();
        assert_eq!(parsed["scope"], "clipboard");
        assert_eq!(parsed["exportedAt"], 1758096000000i64);
        assert_eq!(parsed["appVersion"], "0.1.11");
        assert_eq!(parsed["inferred"], false);
        assert_eq!(parsed["config"]["plugins"]["clipboard"]["enabled"], false);
    }

    #[test]
    fn parse_accepts_a_plain_config_file() {
        let parsed = parse_import(serde_json::to_vec(&config()).unwrap().as_slice()).unwrap();
        assert_eq!(parsed["scope"], "all");
        assert_eq!(parsed["inferred"], true);
        assert_eq!(parsed["config"]["core"]["hotkey"], "Alt+Space");
    }

    #[test]
    fn parse_rejects_broken_or_foreign_files() {
        assert!(parse_import(b"{").is_err());
        assert!(parse_import(b"[1,2]").is_err());
        assert!(parse_import(br#"{"hello":"world"}"#).is_err());
        let unsupported = json!({ "flowhubExport": 99, "config": {} });
        assert!(parse_import(serde_json::to_vec(&unsupported).unwrap().as_slice())
            .unwrap_err()
            .contains("不支持的导出格式版本"));
        let mismatched = json!({
            "flowhubExport": 1,
            "scope": "clipboard",
            "config": { "core": {} }
        });
        assert!(parse_import(serde_json::to_vec(&mismatched).unwrap().as_slice()).is_err());
    }

    #[test]
    fn web_items_come_from_every_supported_shape() {
        let nodes = json!([{ "id": "a", "title": "A", "children": [{ "id": "b", "url": "https://b.test" }] }]);
        let bare = serde_json::to_vec(&nodes).unwrap();
        assert_eq!(parse_web_items(&bare).unwrap(), nodes);

        let wrapped = json!({ "items": nodes.clone() });
        assert_eq!(parse_web_items(&serde_json::to_vec(&wrapped).unwrap()).unwrap(), nodes);

        let config = json!({ "plugins": { "web": { "settings": { "items": nodes.clone() } } } });
        assert_eq!(parse_web_items(&serde_json::to_vec(&config).unwrap()).unwrap(), nodes);

        let envelope = json!({ "flowhubExport": 1, "scope": "all", "config": config });
        assert_eq!(parse_web_items(&serde_json::to_vec(&envelope).unwrap()).unwrap(), nodes);
    }

    #[test]
    fn web_items_reject_missing_or_malformed_nodes() {
        let cases = [
            json!({ "hello": "world" }),
            json!({ "items": [] }),
            json!({ "items": [1, 2] }),
            json!({ "items": [{ "title": "没有 id" }] }),
            json!({ "items": [{ "id": "  " }] }),
            json!({ "items": [{ "id": "a", "url": 3 }] }),
            json!({ "items": [{ "id": "a", "children": {} }] }),
            json!({ "items": [{ "id": "a", "children": [{ "title": "缺 id" }] }] })
        ];
        for case in cases {
            assert!(
                parse_web_items(&serde_json::to_vec(&case).unwrap()).is_err(),
                "{case} 应被拒绝"
            );
        }
        assert!(parse_web_items(b"{").is_err());
    }
}

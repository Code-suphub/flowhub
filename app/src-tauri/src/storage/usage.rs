//! Usage history queries and ranking. The caller supplies icon resolution so
//! persistence does not depend on native application scanning or window APIs.
use super::database;
use crate::AppState;
use chrono::{DateTime, Utc};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
};

pub(crate) fn record_usage(state: &AppState, usage: &Value, fallback: &str) -> Result<(), String> {
    let target_type = match usage.get("type").and_then(Value::as_str) {
        Some("app") => "app",
        Some("page") => "page",
        _ => return Ok(()),
    };
    let target_key = if target_type == "app" {
        usage
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or(fallback)
    } else {
        usage
            .get("id")
            .or_else(|| usage.get("url"))
            .and_then(Value::as_str)
            .unwrap_or(fallback)
    };
    if target_key.trim().is_empty() {
        return Ok(());
    }
    let title = usage
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(target_key);
    let target_path = if target_type == "app" {
        usage
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or(fallback)
    } else {
        usage
            .get("breadcrumb")
            .and_then(Value::as_str)
            .unwrap_or("")
    };
    let url = usage
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or(if target_type == "page" { fallback } else { "" });
    let icon = usage.get("icon").and_then(Value::as_str).unwrap_or("");
    let now = Utc::now().to_rfc3339();
    let connection = database(state)?;
    connection
        .execute(
            "INSERT INTO usage_records(target_type, target_key, title, target_path, url, icon, use_count, first_used_at, last_used_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(target_type, target_key) DO UPDATE SET
               title = excluded.title, target_path = excluded.target_path, url = excluded.url,
               icon = excluded.icon, use_count = usage_records.use_count + 1, last_used_at = excluded.last_used_at",
            params![target_type, target_key, title, target_path, url, icon, now, now],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn search_usage(
    state: &AppState,
    scope: &str,
    resolve_icons: impl FnOnce(&[String]) -> HashMap<String, String>,
) -> Result<Value, String> {
    let connection = database(state)?;
    let target_type = match scope {
        "app" => "app",
        "web" => "page",
        _ => "",
    };
    let sql = "
        WITH frequent_candidates AS (
          SELECT target_type, target_key, title, target_path, url, icon, use_count, first_used_at, last_used_at
          FROM usage_records WHERE (?1 = '' OR target_type = ?1)
          ORDER BY use_count DESC, last_used_at DESC LIMIT 100
        ), recent_candidates AS (
          SELECT target_type, target_key, title, target_path, url, icon, use_count, first_used_at, last_used_at
          FROM usage_records WHERE (?1 = '' OR target_type = ?1)
          ORDER BY last_used_at DESC LIMIT 100
        )
        SELECT * FROM frequent_candidates UNION SELECT * FROM recent_candidates";
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Value> {
        let target_type: String = row.get(0)?;
        let target_key: String = row.get(1)?;
        let title: String = row.get(2)?;
        let target_path: Option<String> = row.get(3)?;
        let url: Option<String> = row.get(4)?;
        let icon: Option<String> = row.get(5)?;
        let use_count: i64 = row.get(6)?;
        let first_used_at: String = row.get(7)?;
        let last_used_at: String = row.get(8)?;
        let age_days = DateTime::parse_from_rfc3339(&last_used_at)
            .map(|date| {
                (Utc::now() - date.with_timezone(&Utc)).num_seconds().max(0) as f64 / 86_400.0
            })
            .unwrap_or(0.0);
        let score = use_count as f64 * 0.5_f64.powf(age_days / 30.0);
        Ok(json!({
            "usageType": target_type,
            "usageKey": target_key,
            "type": if target_type == "page" { "page" } else { "app" },
            "id": if target_type == "page" { target_key.clone() } else { String::new() },
            "title": title,
            "path": target_path.clone().unwrap_or_default(),
            "breadcrumb": if target_type == "page" { target_path.unwrap_or_default() } else { String::new() },
            "url": url.unwrap_or_default(),
            "icon": icon.unwrap_or_default(),
            "iconUrl": "",
            "useCount": use_count,
            "firstUsedAt": first_used_at,
            "lastUsedAt": last_used_at,
            "score": score
        }))
    };
    let rows = statement
        .query_map([target_type], map_row)
        .map_err(|error| error.to_string())?;
    for row in rows {
        entries.push(row.map_err(|error| error.to_string())?);
    }

    let mut frequent: Vec<Value> = entries
        .iter()
        .filter(|entry| entry.get("useCount").and_then(Value::as_i64).unwrap_or(0) >= 3)
        .cloned()
        .collect();
    frequent.sort_by(|left, right| {
        number(right, "score")
            .partial_cmp(&number(left, "score"))
            .unwrap_or(Ordering::Equal)
    });
    frequent.truncate(6);
    let frequent_keys: HashSet<String> = frequent
        .iter()
        .map(|entry| {
            format!(
                "{}:{}",
                text_field(entry, "usageType"),
                text_field(entry, "usageKey")
            )
        })
        .collect();
    let mut recent: Vec<Value> = entries
        .into_iter()
        .filter(|entry| {
            !frequent_keys.contains(&format!(
                "{}:{}",
                text_field(entry, "usageType"),
                text_field(entry, "usageKey")
            ))
        })
        .collect();
    recent.sort_by(|left, right| {
        text_field(right, "lastUsedAt").cmp(&text_field(left, "lastUsedAt"))
    });
    recent.truncate(6);

    // Resolve native icons only for the final cards, not every historical row.
    let icon_paths: Vec<String> = frequent
        .iter()
        .chain(recent.iter())
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("app"))
        .filter_map(|entry| {
            entry
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    let icons = resolve_icons(&icon_paths);
    for entry in frequent.iter_mut().chain(recent.iter_mut()) {
        let path = entry.get("path").and_then(Value::as_str).unwrap_or("");
        if let Some(icon) = icons.get(path) {
            entry
                .as_object_mut()
                .expect("usage entry is an object")
                .insert("iconUrl".to_string(), Value::String(icon.clone()));
        }
    }
    Ok(json!({ "frequent": frequent, "recent": recent }))
}

fn text_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config_save, storage, storage_tests::Fixture};
    use std::fs;

    #[test]
    fn recovery_blocks_usage_and_icon_resolution_then_migration_keeps_history() {
        let f = Fixture::new();
        let page = json!({"type": "page", "id": "page", "title": "Kept"});
        record_usage(&f.state, &page, "https://example.com").unwrap();
        let journal = f.root.join(".flowhub-config-save");
        fs::create_dir(&journal).unwrap();
        storage::write_json_atomic(
            &journal.join("journal.json"),
            &json!({"committed": false, "files": []}),
        )
        .unwrap();
        assert!(record_usage(&f.state, &page, "https://example.com").is_err());
        assert!(search_usage(&f.state, "web", |_| panic!(
            "icons must not run after storage failure"
        ))
        .is_err());
        config_save::recover(&f.root).unwrap();
        storage::switch_storage(&f.state, &f.root.join("migrated")).unwrap();
        record_usage(&f.state, &page, "https://example.com").unwrap();
        let report = search_usage(&f.state, "web", |_| HashMap::new()).unwrap();
        assert_eq!(report["recent"][0]["useCount"], 2);
        assert_eq!(report["recent"][0]["title"], "Kept");
        let old = rusqlite::Connection::open(f.root.join("source/weborg.db")).unwrap();
        assert_eq!(
            old.query_row("SELECT use_count FROM usage_records", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}

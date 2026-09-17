//! Bounded config history.
//!
//! `config_save`'s journal is a single-shot crash rollback that is deleted as
//! soon as the save commits, so it never provides a previous version to fall
//! back to. This module keeps a retained history instead: after a save commits,
//! the config bytes captured before the write are stored under
//! `<root>/config-history/<id>.json` and the oldest entries are pruned.
//!
//! Entries are keyed by a fixed-width millisecond timestamp so lexical order is
//! chronological order. Nothing here touches the save journal, the database or
//! the user's config path, and a failure to record must never fail a save that
//! is already durable.
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) const LIMIT: usize = 20;
const DIRECTORY: &str = "config-history";

#[derive(Serialize)]
pub(crate) struct Entry {
    pub(crate) id: String,
    pub(crate) created_at: u64,
    pub(crate) bytes: u64,
    pub(crate) catalog_count: u64,
}

pub(crate) enum Recorded {
    /// Nothing to keep: no previous config existed, or it matches the newest entry.
    Skipped,
    Added { id: String, kept: usize },
}

pub(crate) fn directory(root: &Path) -> PathBuf {
    root.join(DIRECTORY)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// The id must be usable as a file name; anything else is rejected so a caller
/// (or the UI) can never escape the history directory. Digits only, with an
/// optional numeric suffix for entries recorded in the same millisecond.
pub(crate) fn valid_id(id: &str) -> bool {
    let digits = |value: &str| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit());
    match id.split_once('-') {
        Some((millis, suffix)) => millis.len() == 13 && digits(millis) && digits(suffix),
        None => id.len() == 13 && digits(id),
    }
}

fn created_at(id: &str) -> u64 {
    id.split('-').next().unwrap_or_default().parse().unwrap_or(0)
}

fn catalog_count(bytes: &[u8]) -> u64 {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|value| {
            value
                .pointer("/plugins/web/settings/catalogCount")
                .and_then(serde_json::Value::as_u64)
        })
        .unwrap_or(0)
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = path.parent().ok_or("缺少父目录")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        ".flowhub-history-{}-{}-{}.tmp",
        std::process::id(),
        now_ms(),
        NEXT.fetch_add(1, Ordering::Relaxed),
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    let result = (|| {
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

/// Existing entries, newest first. Unreadable or foreign files are skipped
/// rather than failing the listing.
pub(crate) fn list(root: &Path) -> Result<Vec<Entry>, String> {
    let directory = directory(root);
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        if !valid_id(id) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else { continue };
        if !metadata.is_file() {
            continue;
        }
        let bytes = fs::read(entry.path()).unwrap_or_default();
        result.push(Entry {
            id: id.to_string(),
            created_at: created_at(id),
            bytes: metadata.len(),
            catalog_count: catalog_count(&bytes),
        });
    }
    result.sort_by(|left, right| right.id.cmp(&left.id));
    Ok(result)
}

pub(crate) fn read(root: &Path, id: &str) -> Result<Vec<u8>, String> {
    if !valid_id(id) {
        return Err("备份标识无效".into());
    }
    fs::read(directory(root).join(format!("{id}.json"))).map_err(|error| error.to_string())
}

fn unique_id(root: &Path, millis: u64) -> String {
    let base = format!("{millis:013}");
    if !directory(root).join(format!("{base}.json")).exists() {
        return base;
    }
    for suffix in 1..1000 {
        let candidate = format!("{base}-{suffix}");
        if !directory(root).join(format!("{candidate}.json")).exists() {
            return candidate;
        }
    }
    format!("{base}-{}", std::process::id())
}

/// Keep at most `LIMIT` entries. The newest entry is never pruned.
fn prune(root: &Path, keep: usize) -> Result<usize, String> {
    let entries = list(root)?;
    let mut removed = 0;
    for entry in entries.into_iter().skip(keep.max(1)) {
        fs::remove_file(directory(root).join(format!("{}.json", entry.id)))
            .map_err(|error| error.to_string())?;
        removed += 1;
    }
    Ok(removed)
}

/// Store the config bytes that a just-committed save replaced.
///
/// `previous` is `None` when the config file did not exist before the save;
/// there is nothing to keep in that case. Identical consecutive content is
/// deduplicated so catalog-only saves cannot evict useful versions.
pub(crate) fn record(root: &Path, previous: Option<&[u8]>) -> Result<Recorded, String> {
    let Some(bytes) = previous.filter(|bytes| !bytes.is_empty()) else {
        return Ok(Recorded::Skipped);
    };
    if let Some(newest) = list(root)?.first() {
        if read(root, &newest.id).is_ok_and(|existing| existing == bytes) {
            return Ok(Recorded::Skipped);
        }
    }
    let id = unique_id(root, now_ms());
    write_new(&directory(root).join(format!("{id}.json")), bytes)?;
    prune(root, LIMIT)?;
    Ok(Recorded::Added {
        kept: list(root)?.len(),
        id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "flowhub-history-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn config(count: u64) -> Vec<u8> {
        serde_json::to_vec_pretty(&serde_json::json!({
            "plugins": {"web": {"settings": {"catalogCount": count}}}
        }))
        .unwrap()
    }

    #[test]
    fn records_previous_versions_newest_first() {
        let root = root("order");
        assert!(matches!(record(&root, None).unwrap(), Recorded::Skipped));
        assert!(matches!(record(&root, Some(&config(1))).unwrap(), Recorded::Added { .. }));
        // 同一毫秒内连续记录也要得到不同 id。
        assert!(matches!(record(&root, Some(&config(2))).unwrap(), Recorded::Added { .. }));
        let entries = list(&root).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].id > entries[1].id, "列表应按 id 倒序");
        assert_eq!(read(&root, &entries[0].id).unwrap(), config(2));
        assert_eq!(entries[0].catalog_count, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn identical_consecutive_content_is_deduplicated() {
        let root = root("dedupe");
        record(&root, Some(&config(1))).unwrap();
        assert!(matches!(record(&root, Some(&config(1))).unwrap(), Recorded::Skipped));
        assert_eq!(list(&root).unwrap().len(), 1);
        // 内容变化后仍会新增。
        record(&root, Some(&config(2))).unwrap();
        assert_eq!(list(&root).unwrap().len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn empty_or_missing_previous_config_is_not_recorded() {
        let root = root("empty");
        assert!(matches!(record(&root, None).unwrap(), Recorded::Skipped));
        assert!(matches!(record(&root, Some(b"")).unwrap(), Recorded::Skipped));
        assert!(list(&root).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn history_is_pruned_to_the_limit_newest_kept() {
        let root = root("prune");
        for count in 0..(LIMIT as u64 + 5) {
            record(&root, Some(&config(count))).unwrap();
        }
        let entries = list(&root).unwrap();
        assert_eq!(entries.len(), LIMIT);
        assert_eq!(read(&root, &entries[0].id).unwrap(), config(LIMIT as u64 + 4));
        assert_eq!(entries.last().unwrap().catalog_count, 5);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn identifiers_cannot_escape_the_history_directory() {
        let root = root("traversal");
        fs::write(root.join("outside.json"), b"secret").unwrap();
        for bad in ["../outside", "..", "abc", "2026/01", "20260917", ""] {
            assert!(!valid_id(bad), "{bad} 不应通过校验");
            assert!(read(&root, bad).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn listing_ignores_foreign_files_and_missing_directory() {
        let root = root("foreign");
        assert!(list(&root).unwrap().is_empty());
        fs::create_dir_all(directory(&root)).unwrap();
        fs::write(directory(&root).join("notes.txt"), b"x").unwrap();
        fs::create_dir_all(directory(&root).join("2026010100000.json")).unwrap();
        assert!(list(&root).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}

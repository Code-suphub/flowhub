//! Undo journal for the SQLite + JSON save. No AppState database leases may be
//! acquired here: callers drain clipboard workers before taking storage_access.
use super::*;
use serde::{Deserialize, Serialize};
use std::io::Write;

const JOURNAL: &str = ".flowhub-config-save";

#[derive(Serialize, Deserialize)]
struct SavedFile {
    path: PathBuf,
    bytes: Option<Vec<u8>>,
}

impl SavedFile {
    fn capture(path: &Path) -> Result<Self, String> {
        let bytes = match fs::read(path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        Ok(Self {
            path: path.to_path_buf(),
            bytes,
        })
    }

    fn restore(&self) -> Result<(), String> {
        if let Some(bytes) = &self.bytes {
            atomic_bytes(&self.path, bytes)
        } else {
            match fs::remove_file(&self.path) {
                Ok(()) => sync_parent(&self.path),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.to_string()),
            }
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Journal {
    committed: bool,
    database: PathBuf,
    files: Vec<SavedFile>,
}

fn sync_parent(path: &Path) -> Result<(), String> {
    fs::File::open(path.parent().ok_or("缺少父目录")?)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())
}

fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("缺少父目录")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let temporary = parent.join(format!(
        ".flowhub-save-{}-{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT.fetch_add(1, AtomicOrdering::Relaxed),
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
        fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        sync_parent(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn journal_write(path: &Path, journal: &Journal) -> Result<(), String> {
    atomic_bytes(
        path,
        &serde_json::to_vec(journal).map_err(|error| error.to_string())?,
    )
}

pub(super) fn check_ready(root: &Path) -> Result<(), String> {
    let path = root.join(JOURNAL).join("journal.json");
    if path.exists() {
        let journal: Journal = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if !journal.committed {
            return Err("配置保存尚待恢复，请重启 FlowHub 后重试".into());
        }
    }
    Ok(())
}

// Called before startup resolves the locator or opens any database. Idempotent:
// keep the journal and backup until every undo operation has succeeded.
pub(super) fn recover(root: &Path) -> Result<(), String> {
    let directory = root.join(JOURNAL);
    let path = directory.join("journal.json");
    if !directory.exists() {
        return Ok(());
    }
    if path.exists() {
        let journal: Journal = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("配置恢复日志无效：{e}"))?;
        if !journal.committed {
            let backup = Connection::open_with_flags(
                directory.join("before.db"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .map_err(|e| e.to_string())?;
            backup
                .backup("main", &journal.database, None)
                .map_err(|e| e.to_string())?;
            for file in &journal.files {
                file.restore()?;
            }
        }
        // Delete the manifest first: if cleanup is interrupted, no undo is needed.
        fs::remove_file(&path).map_err(|e| e.to_string())?;
        sync_parent(&path)?;
    }
    fs::remove_dir_all(&directory).map_err(|e| e.to_string())?;
    sync_parent(&directory)
}

// Resolve aliases even when the leaf does not exist yet, so a user-selected
// config path cannot overwrite a database or the transaction's recovery files.
fn resolved_path(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return fs::canonicalize(path).map_err(|e| e.to_string());
    }
    let parent = path.parent().ok_or("无效存储路径")?;
    let name = path.file_name().ok_or("无效存储路径")?;
    Ok(resolved_path(parent)?.join(name))
}

pub(super) fn persist(
    state: &AppState,
    config: &mut Value,
    items: &[Value],
    storage: &Path,
    target_config: &Path,
) -> Result<(Value, usize), String> {
    persist_with_hook(state, config, items, storage, target_config, |_| Ok(()))
}

fn persist_with_hook(
    state: &AppState,
    config: &mut Value,
    items: &[Value],
    storage: &Path,
    target_config: &Path,
    mut checkpoint: impl FnMut(&str) -> Result<(), String>,
) -> Result<(Value, usize), String> {
    let _exclusive = state.storage_access.write().map_err(|e| e.to_string())?;
    recover(&state.root_dir)?;
    let directory = state.root_dir.join(JOURNAL);
    let locator = state.root_dir.join("config-location.json");
    // These are internal persistence files, not valid configuration destinations.
    let resolved_config = resolved_path(target_config)?;
    let resolved_journal = resolved_path(&directory)?;
    let resolved_storage = resolved_path(storage)?;
    let resolved_current = resolved_path(&state.paths().storage_dir)?;
    let database_collision = [&resolved_storage, &resolved_current]
        .iter()
        .any(|directory| {
            [
                "weborg.db",
                "weborg.db-wal",
                "weborg.db-shm",
                "weborg.db-journal",
            ]
            .iter()
            .any(|name| resolved_config == directory.join(name))
        });
    if resolved_config == resolved_path(&locator)?
        || resolved_config.starts_with(&resolved_journal)
        || resolved_storage.starts_with(&resolved_journal)
        || database_collision
    {
        return Err("配置文件位置不能覆盖内部存储文件".into());
    }
    let settings = ensure_object_path(config, &["plugins", "web", "settings"])?;
    settings.insert("items".into(), json!([]));
    settings.insert("catalogStorage".into(), json!("sqlite"));
    let count = items.iter().map(count_catalog_nodes).sum::<usize>();
    settings.insert("catalogCount".into(), json!(count));
    let files = vec![
        SavedFile::capture(target_config)?,
        SavedFile::capture(&locator)?,
    ];
    let mut storage_state = prepare_storage(state, storage)?;
    let active = PathBuf::from(storage_state["activePath"].as_str().ok_or("缺少存储路径")?);
    let database = active.join("weborg.db");
    let mut connection = Connection::open(&database).map_err(|e| e.to_string())?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")
        .map_err(|e| e.to_string())?;
    fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let manifest = directory.join("journal.json");
    let mut journal = Journal {
        committed: false,
        database: database.clone(),
        files,
    };
    let result = (|| {
        connection
            .backup("main", directory.join("before.db"), None)
            .map_err(|e| e.to_string())?;
        fs::File::open(directory.join("before.db"))
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        journal_write(&manifest, &journal)?;
        sync_parent(&directory)?;
        checkpoint("prepared")?;
        replace_catalog(&mut connection, items)?;
        config["plugins"]["web"]["settings"]["catalogUpdatedAt"] =
            json!(catalog_meta(&connection, "updated_at"));
        checkpoint("database")?;
        atomic_bytes(
            target_config,
            &serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?,
        )?;
        checkpoint("config")?;
        atomic_bytes(
            &locator,
            &serde_json::to_vec(&json!({ "configPath": target_config }))
                .map_err(|e| e.to_string())?,
        )?;
        checkpoint("locator")?;
        journal.committed = true;
        journal_write(&manifest, &journal)?;
        Ok(())
    })();
    drop(connection);
    if let Err(reason) = result {
        // A rename may succeed even if its following directory sync fails.
        // Honor the decision actually on disk; never undo a committed journal.
        let committed_on_disk = read_json(&manifest)
            .and_then(|value| value["committed"].as_bool())
            .unwrap_or(false);
        if committed_on_disk {
            storage_state["warning"] = json!(format!("配置已提交，但同步确认失败：{reason}"));
        } else {
            return match recover(&state.root_dir) {
                Ok(()) => Err(reason),
                Err(error) => Err(format!("{reason}; 恢复未完成（请重启后重试）：{error}")),
            };
        }
    }
    // The durable commit marker is the decision point. Cleanup failure cannot
    // turn a committed save into a failure, and startup will only finish cleanup.
    checkpoint("committed").ok();
    *state.paths.write().expect("FlowHub paths lock poisoned") = AppPaths {
        config_path: target_config.to_path_buf(),
        storage_dir: active,
        db_path: database,
    };
    let _ = recover(&state.root_dir);
    Ok((storage_state, count))
}

// Durable success is independent of system integration. In particular, a
// clipboard/menu error must not skip later integrations or the config broadcast.
pub(super) fn saved_response(
    config: &Value,
    storage: Value,
    count: usize,
    mut apply: impl FnMut(&str) -> Result<Value, String>,
) -> Value {
    let mut failures = Vec::new();
    let mut core = Map::new();
    for name in [
        "clipboard",
        "hotkey",
        "autostart",
        "menuBar",
        "organizer",
        "broadcast",
    ] {
        let value = match apply(name) {
            Ok(value) => {
                let failed = match name {
                    "hotkey" => value["hotkeyRegistered"] == false,
                    "autostart" => !cfg!(debug_assertions) && value["applied"] == false,
                    "organizer" => value.get("reason").is_some(),
                    _ => false,
                };
                if failed {
                    failures.push(json!({ "pluginId": name, "reason": value["reason"] }));
                }
                value
            }
            Err(reason) => {
                failures.push(json!({ "pluginId": name, "reason": reason }));
                json!({ "applied": false, "reason": reason })
            }
        };
        core.insert(name.to_string(), value);
    }
    json!({
        "ok": true, "persisted": true, "config": config,
        "pluginFailures": failures, "coreState": core, "storageState": storage,
        "catalogState": { "count": count, "storage": "sqlite" }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_tests::Fixture;

    fn seed(f: &Fixture) -> Value {
        let config = json!({ "core": {}, "plugins": { "web": { "settings": { "items": [] } } }, "version": "before" });
        write_json_atomic(&f.state.paths().config_path, &config).unwrap();
        write_json_atomic(
            &f.root.join("config-location.json"),
            &json!({ "configPath": f.state.paths().config_path }),
        )
        .unwrap();
        replace_catalog(
            &mut database(&f.state).unwrap(),
            &[json!({ "id": "before", "title": "old" })],
        )
        .unwrap();
        config
    }

    fn input(f: &Fixture, storage: &Path, target: &Path) -> Value {
        let mut config = seed(f);
        config["version"] = json!("after");
        config["core"]["configPath"] = json!(target);
        config["plugins"]["clipboard"] = json!({ "settings": { "storagePath": storage } });
        config
    }

    fn assert_old(f: &Fixture, before: &AppPaths) {
        assert_eq!(f.state.paths().config_path, before.config_path);
        assert_eq!(f.state.paths().db_path, before.db_path);
        assert_eq!(hydrated_config(&f.state).unwrap()["version"], "before");
        assert_eq!(
            catalog_items(&database(&f.state).unwrap()).unwrap()[0]["id"],
            "before"
        );
        assert!(!f.root.join(JOURNAL).exists());
    }

    #[test]
    fn each_failed_step_restores_files_catalog_and_paths_for_same_and_new_storage() {
        for migrate in [false, true] {
            for step in ["prepared", "database", "config", "locator"] {
                let f = Fixture::new();
                let before = f.state.paths();
                let storage = if migrate {
                    f.root.join("target")
                } else {
                    before.storage_dir.clone()
                };
                let target = if migrate {
                    f.root.join("custom.json")
                } else {
                    before.config_path.clone()
                };
                let mut config = input(&f, &storage, &target);
                if migrate {
                    fs::write(&target, b"existing destination bytes\n").unwrap();
                }
                let locator_before = fs::read(f.root.join("config-location.json")).unwrap();
                let result = persist_with_hook(
                    &f.state,
                    &mut config,
                    &[json!({ "id": "after" })],
                    &storage,
                    &target,
                    |stage| {
                        if stage == step {
                            Err(format!("injected {step}"))
                        } else {
                            Ok(())
                        }
                    },
                );
                assert!(result.unwrap_err().contains("injected"));
                assert_old(&f, &before);
                assert_eq!(
                    fs::read(f.root.join("config-location.json")).unwrap(),
                    locator_before
                );
                if migrate {
                    assert_eq!(fs::read(&target).unwrap(), b"existing destination bytes\n");
                    assert_eq!(
                        catalog_items(&Connection::open(storage.join("weborg.db")).unwrap())
                            .unwrap()[0]["id"],
                        "before"
                    );
                }
            }
        }
    }

    #[test]
    fn actual_file_rename_failures_roll_back_and_allow_retry() {
        for locator_failure in [false, true] {
            let f = Fixture::new();
            let before = f.state.paths();
            let target = f.root.join("new.json");
            let mut config = input(&f, &before.storage_dir, &target);
            let blocked = if locator_failure {
                f.root.join("config-location.json")
            } else {
                target.clone()
            };
            let error = persist_with_hook(
                &f.state,
                &mut config,
                &[json!({ "id": "after" })],
                &before.storage_dir,
                &target,
                |stage| {
                    if stage
                        == if locator_failure {
                            "config"
                        } else {
                            "database"
                        }
                    {
                        if blocked.is_file() {
                            fs::remove_file(&blocked).unwrap();
                        }
                        fs::create_dir(&blocked).unwrap();
                    }
                    Ok(())
                },
            )
            .unwrap_err();
            // A directory at the file destination makes the real rename fail,
            // and prevents undo until the underlying filesystem problem is fixed.
            assert!(error.contains("恢复未完成"), "{error}");
            assert!(database(&f.state).is_err());
            fs::remove_dir(&blocked).unwrap();
            recover(&f.root).unwrap();
            assert_old(&f, &before);
            assert!(!target.exists());
            persist(
                &f.state,
                &mut config,
                &[json!({ "id": "after" })],
                &before.storage_dir,
                &target,
            )
            .unwrap();
            assert_eq!(hydrated_config(&f.state).unwrap()["version"], "after");
        }
    }

    #[test]
    fn sqlite_deferred_constraint_commit_failure_preserves_original_state() {
        let f = Fixture::new();
        let before = f.state.paths();
        let mut config = input(&f, &before.storage_dir, &before.config_path);
        // Inserts succeed; the deferred foreign key makes COMMIT itself fail.
        database(&f.state).unwrap().execute_batch("CREATE TABLE parent(id TEXT PRIMARY KEY); CREATE TABLE child(id TEXT REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_commit AFTER INSERT ON web_catalog_nodes BEGIN INSERT INTO child VALUES (new.id); END;").unwrap();
        let error = persist(
            &f.state,
            &mut config,
            &[json!({ "id": "after" })],
            &before.storage_dir,
            &before.config_path,
        )
        .unwrap_err();
        assert!(error.contains("FOREIGN KEY"), "{error}");
        assert_old(&f, &before);
        assert_eq!(
            database(&f.state)
                .unwrap()
                .query_row("SELECT count(*) FROM child", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn restart_recovers_every_uncommitted_boundary_and_keeps_committed_save() {
        for migrate in [false, true] {
            for step in ["prepared", "database", "config", "locator", "committed"] {
                let f = Fixture::new();
                let before = f.state.paths();
                let storage = if migrate {
                    f.root.join("target")
                } else {
                    before.storage_dir.clone()
                };
                let target = if migrate {
                    f.root.join("new.json")
                } else {
                    before.config_path.clone()
                };
                let mut config = input(&f, &storage, &target);
                let crash = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    persist_with_hook(
                        &f.state,
                        &mut config,
                        &[json!({ "id": "after" })],
                        &storage,
                        &target,
                        |stage| {
                            if stage == step {
                                panic!("simulated process exit");
                            }
                            Ok(())
                        },
                    )
                }));
                assert!(crash.is_err());
                // Recovery uses only disk state, without the original AppState or
                // its poisoned locks, exactly as it does before startup resolution.
                recover(&f.root).unwrap();
                recover(&f.root).unwrap();
                let locator = read_json(&f.root.join("config-location.json")).unwrap();
                let active_config = PathBuf::from(locator["configPath"].as_str().unwrap());
                let persisted = read_json(&active_config).unwrap();
                let committed = step == "committed";
                assert_eq!(
                    persisted["version"],
                    if committed { "after" } else { "before" }
                );
                assert_eq!(
                    active_config,
                    if committed {
                        target
                    } else {
                        before.config_path
                    }
                );
                let active_storage = configured_path(
                    &persisted,
                    &["plugins", "clipboard", "settings", "storagePath"],
                )
                .unwrap_or(before.storage_dir);
                let db = Connection::open(active_storage.join("weborg.db")).unwrap();
                assert_eq!(
                    catalog_items(&db).unwrap()[0]["id"],
                    if committed { "after" } else { "before" }
                );
            }
        }
    }

    #[test]
    fn process_exit_worker() {
        let Ok(marker) = std::env::var("FLOWHUB_TEST_SAVE_EXIT_MARKER") else {
            return;
        };
        let step = std::env::var("FLOWHUB_TEST_SAVE_EXIT_STEP").unwrap();
        let f = Fixture::new();
        let storage = f.root.join("target");
        let target = f.root.join("new.json");
        let mut config = input(&f, &storage, &target);
        write_json_atomic(Path::new(&marker), &json!({ "root": f.root })).unwrap();
        persist_with_hook(
            &f.state,
            &mut config,
            &[json!({ "id": "after" })],
            &storage,
            &target,
            |stage| {
                if stage == step {
                    std::process::exit(73);
                }
                Ok(())
            },
        )
        .unwrap();
        panic!("exit boundary was not reached");
    }

    #[test]
    fn fresh_process_exit_without_destructors_recovers_on_next_start() {
        for step in ["database", "config", "locator", "committed"] {
            let parent = Fixture::new();
            let marker = parent.root.join("child.json");
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "config_save::tests::process_exit_worker",
                    "--nocapture",
                ])
                .env("FLOWHUB_TEST_SAVE_EXIT_MARKER", &marker)
                .env("FLOWHUB_TEST_SAVE_EXIT_STEP", step)
                .output()
                .unwrap();
            assert_eq!(
                output.status.code(),
                Some(73),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let root = PathBuf::from(read_json(&marker).unwrap()["root"].as_str().unwrap());
            recover(&root).unwrap();
            let locator = read_json(&root.join("config-location.json")).unwrap();
            let config_path = PathBuf::from(locator["configPath"].as_str().unwrap());
            let config = read_json(&config_path).unwrap();
            let committed = step == "committed";
            assert_eq!(
                config["version"],
                if committed { "after" } else { "before" }
            );
            let storage = configured_path(
                &config,
                &["plugins", "clipboard", "settings", "storagePath"],
            )
            .unwrap_or_else(|| root.join("source"));
            let db = Connection::open(storage.join("weborg.db")).unwrap();
            assert_eq!(
                catalog_items(&db).unwrap()[0]["id"],
                if committed { "after" } else { "before" }
            );
            drop(db);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn existing_target_catalog_and_metadata_are_restored_after_failure() {
        let f = Fixture::new();
        let before = f.state.paths();
        let storage = f.root.join("existing");
        fs::create_dir(&storage).unwrap();
        let mut db = Connection::open(storage.join("weborg.db")).unwrap();
        initialize_schema(&db).unwrap();
        replace_catalog(&mut db, &[json!({ "id": "destination" })]).unwrap();
        let timestamp = catalog_meta(&db, "updated_at");
        drop(db);
        let target = f.root.join("new.json");
        let mut config = input(&f, &storage, &target);
        persist_with_hook(
            &f.state,
            &mut config,
            &[json!({ "id": "after" })],
            &storage,
            &target,
            |step| {
                if step == "locator" {
                    Err("failure".into())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        assert_old(&f, &before);
        let db = Connection::open(storage.join("weborg.db")).unwrap();
        assert_eq!(catalog_items(&db).unwrap()[0]["id"], "destination");
        assert_eq!(catalog_meta(&db, "updated_at"), timestamp);
        assert!(!target.exists());
    }

    #[test]
    fn hydrated_reader_waits_for_the_whole_save_and_observes_one_generation() {
        let f = Fixture::new();
        let storage = f.root.join("target");
        let target = f.root.join("new.json");
        let mut config = input(&f, &storage, &target);
        let state = f.state.clone();
        let (reached_tx, reached_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let save = std::thread::spawn(move || {
            persist_with_hook(
                &state,
                &mut config,
                &[json!({ "id": "after" })],
                &storage,
                &target,
                |step| {
                    if step == "config" {
                        reached_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                    }
                    Ok(())
                },
            )
        });
        reached_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(f.state.storage_access.try_read().is_err());
        let state = f.state.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || done_tx.send(hydrated_config(&state)).unwrap());
        assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release_tx.send(()).unwrap();
        save.join().unwrap().unwrap();
        let hydrated = done_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        reader.join().unwrap();
        assert_eq!(hydrated["version"], "after");
        assert_eq!(
            hydrated["plugins"]["web"]["settings"]["items"][0]["id"],
            "after"
        );
    }

    #[test]
    fn aliased_internal_config_destination_is_rejected_without_touching_database() {
        let f = Fixture::new();
        let before = f.state.paths();
        let alias = f.root.join("alias");
        std::os::unix::fs::symlink(&before.storage_dir, &alias).unwrap();
        let target = alias.join("weborg.db");
        let mut config = input(&f, &before.storage_dir, &target);
        assert!(
            persist(&f.state, &mut config, &[], &before.storage_dir, &target)
                .unwrap_err()
                .contains("内部存储文件")
        );
        assert_old(&f, &before);
    }

    #[test]
    fn saved_response_keeps_success_and_broadcast_after_integration_failures() {
        let config = json!({ "version": "saved" });
        let mut calls = Vec::new();
        let result = saved_response(&config, json!({}), 1, |name| {
            calls.push(name.to_string());
            match name {
                "clipboard" | "menuBar" => Err("system failure".into()),
                "hotkey" => Ok(json!({ "hotkeyRegistered": false, "reason": "occupied" })),
                _ => Ok(json!({ "applied": true })),
            }
        });
        assert_eq!(result["ok"], true);
        assert_eq!(result["persisted"], true);
        assert_eq!(result["config"], config);
        assert_eq!(result["pluginFailures"].as_array().unwrap().len(), 3);
        assert_eq!(
            calls,
            [
                "clipboard",
                "hotkey",
                "autostart",
                "menuBar",
                "organizer",
                "broadcast"
            ]
        );
        assert_eq!(result["coreState"]["broadcast"]["applied"], true);
        let result = saved_response(&config, json!({}), 1, |_| Err("unavailable".into()));
        assert_eq!(result["ok"], true);
        assert_eq!(result["pluginFailures"].as_array().unwrap().len(), 6);
    }
}

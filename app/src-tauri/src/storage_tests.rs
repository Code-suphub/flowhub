use crate::storage::{catalog_count, catalog_meta, database, initialize_database, switch_storage};
use crate::{AppPaths, AppState};
use rusqlite::Connection;
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering},
        mpsc, Arc, Mutex, RwLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(crate) struct Fixture {
    pub state: Arc<AppState>,
    pub root: PathBuf,
}

impl Fixture {
    pub fn new() -> Self {
        static ID: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "flowhub-storage-test-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            ID.fetch_add(1, AtomicOrdering::Relaxed)
        ));
        let storage = root.join("source");
        fs::create_dir_all(&storage).unwrap();
        let state = Arc::new(AppState {
            storage_access: RwLock::new(()),
            config_save: Mutex::new(()),
            root_dir: root.clone(),
            default_config_path: root.join("config.json"),
            default_storage_dir: storage.clone(),
            paths: RwLock::new(AppPaths {
                config_path: root.join("config.json"),
                db_path: storage.join("weborg.db"),
                storage_dir: storage,
            }),
            application_index: RwLock::new(Vec::new()),
            application_index_path: root.join("index.json"),
            application_index_needs_refresh: AtomicBool::new(false),
            application_index_refreshing: AtomicBool::new(false),
            application_icon_cache: Mutex::new(HashMap::new()),
            application_icon_cache_dir: root.join("icons"),
        });
        initialize_database(&state).unwrap();
        Self { state, root }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn migration_waits_for_connection_and_copies_image_with_record() {
    let fixture = Fixture::new();
    let connection = database(&fixture.state).unwrap();
    let target = fixture.root.join("target");
    let state = fixture.state.clone();
    let destination = target.clone();
    let (started_tx, started_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        started_tx.send(()).unwrap();
        done_tx.send(switch_storage(&state, &destination)).unwrap();
    });
    started_rx.recv().unwrap();
    assert!(fixture.state.storage_access.try_write().is_err());
    assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());
    fs::create_dir(connection.storage_dir.join("images")).unwrap();
    fs::write(connection.storage_dir.join("images/test.png"), b"image").unwrap();
    connection.execute("INSERT INTO clipboard_records(kind,hash,file_name,created_at,last_seen_at) VALUES ('image','test','test.png','now','now')", []).unwrap();
    drop(connection);
    assert!(done_rx
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap()["migrated"]
        .as_bool()
        .unwrap());
    worker.join().unwrap();
    let connection = database(&fixture.state).unwrap();
    assert_eq!(connection.storage_dir, target);
    let name: String = connection
        .query_row("SELECT file_name FROM clipboard_records", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        fs::read(connection.storage_dir.join("images").join(name)).unwrap(),
        b"image"
    );
    connection
        .execute("INSERT INTO web_catalog_meta VALUES ('after','switch')", [])
        .unwrap();
    let old = Connection::open(fixture.root.join("source/weborg.db")).unwrap();
    assert_eq!(catalog_meta(&old, "after"), "");
}

#[test]
fn snapshot_includes_committed_wal_and_excludes_sidecars() {
    let fixture = Fixture::new();
    let source = fixture.state.storage_dir();
    // Keep an external SQLite handle open so committed pages remain in WAL.
    let connection = Connection::open(source.join("weborg.db")).unwrap();
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO web_catalog_meta VALUES ('wal','committed');").unwrap();
    assert!(source.join("weborg.db-wal").exists());
    let target = fixture.root.join("target");
    switch_storage(&fixture.state, &target).unwrap();
    assert!(!target.join("weborg.db-wal").exists());
    assert!(!target.join("weborg.db-shm").exists());
    assert_eq!(
        catalog_meta(&database(&fixture.state).unwrap(), "wal"),
        "committed"
    );
}

#[test]
fn failed_snapshot_keeps_source_active_and_target_retryable() {
    let fixture = Fixture::new();
    let source = fixture.state.storage_dir();
    // A broken attachment fails copying after staging has been created.
    std::os::unix::fs::symlink(source.join("missing"), source.join("broken")).unwrap();
    let target = fixture.root.join("target");
    assert!(switch_storage(&fixture.state, &target).is_err());
    assert_eq!(fixture.state.storage_dir(), source);
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    assert!(!fs::read_dir(&fixture.root).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".flowhub-migration")));
    fs::remove_file(source.join("broken")).unwrap();
    assert_eq!(
        switch_storage(&fixture.state, &target).unwrap()["migrated"],
        true
    );
}

#[test]
fn failed_target_initialization_does_not_publish_paths() {
    let fixture = Fixture::new();
    let source = fixture.state.storage_dir();
    let target = fixture.root.join("invalid");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("weborg.db"), b"not a sqlite database").unwrap();
    assert!(switch_storage(&fixture.state, &target).is_err());
    assert_eq!(fixture.state.storage_dir(), source);
    assert_eq!(
        catalog_count(&database(&fixture.state).unwrap()).unwrap(),
        0
    );
}

#[test]
fn aliased_nested_target_is_rejected_before_copying() {
    let fixture = Fixture::new();
    let source = fixture.state.storage_dir();
    let alias = fixture.root.join("alias");
    std::os::unix::fs::symlink(&source, &alias).unwrap();
    assert!(switch_storage(&fixture.state, &alias.join("nested")).is_err());
    assert_eq!(fixture.state.storage_dir(), source);
    assert_eq!(fs::read_dir(source.join("nested")).unwrap().count(), 0);
}

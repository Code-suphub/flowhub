//! Event-driven application catalog. Search/show only signal this worker; all
//! filesystem walks, bundle metadata reads and persistence happen off the UI.
use crate::{read_json, write_json_atomic, AppState};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

const CHECK_INTERVAL: Duration = Duration::from_secs(30);
const DEBOUNCE: Duration = Duration::from_secs(1);
const MAX_DEBOUNCE: Duration = Duration::from_secs(5);
// Copying a bundle can create its directory before its Info.plist is ready.
// Bounded reconciliation also covers notifications coalesced during install.
const RETRIES: [Duration; 3] = [
    Duration::from_secs(2),
    Duration::from_secs(8),
    Duration::from_secs(20),
];

fn directories() -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Library/CoreServices"),
        PathBuf::from("/System/Library/CoreServices/Applications"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    roots
}

struct Snapshot {
    paths: Vec<PathBuf>,
    fingerprint: String,
}

fn recursive_root(root: &Path) -> bool {
    // CoreServices also contains thousands of framework/resource directories.
    // Its user-facing Applications subfolder is watched/scanned separately.
    root != Path::new("/System/Library/CoreServices")
}

fn snapshot(roots: &[PathBuf]) -> Result<Snapshot, String> {
    fn walk(dir: &Path, paths: &mut Vec<PathBuf>, recursive: bool) -> Result<(), String> {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("{}: {error}", dir.display())),
        };
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            if is_bundle(&path) && path.is_dir() {
                paths.push(path);
            } else if recursive
                && entry
                    .file_type()
                    .map_err(|error| error.to_string())?
                    .is_dir()
            {
                // Never descend into .app contents or follow directory symlinks.
                walk(&path, paths, true)?;
            }
        }
        Ok(())
    }
    fn stamp(path: &Path) -> String {
        fs::metadata(path)
            .ok()
            .map(|meta| {
                format!(
                    "{}:{}",
                    meta.len(),
                    meta.modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|t| t.as_nanos())
                        .unwrap_or_default()
                )
            })
            .unwrap_or_default()
    }
    let mut paths = Vec::new();
    for root in roots {
        walk(root, &mut paths, recursive_root(root))?;
    }
    paths.sort();
    paths.dedup();
    // Version the traversal rules so a cache from a shallow scan is rebuilt.
    let mut fingerprint = String::from("recursive-v2\n");
    for path in &paths {
        fingerprint.push_str(&format!(
            "{}:{}:{}\n",
            path.display(),
            stamp(path),
            stamp(&path.join("Contents/Info.plist"))
        ));
    }
    Ok(Snapshot { paths, fingerprint })
}

fn is_bundle(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
}

fn relevant_path(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| {
        if root.starts_with(path) {
            return true;
        } // Root/ancestor replacement.
        let Ok(relative) = path.strip_prefix(root) else {
            return false;
        };
        let parts: Vec<_> = relative.components().collect();
        let Some(bundle) = parts
            .iter()
            .position(|part| is_bundle(Path::new(part.as_os_str())))
        else {
            return true;
        };
        let tail: PathBuf = parts[bundle + 1..].iter().collect();
        tail.as_os_str().is_empty()
            || tail == Path::new("Contents")
            || tail == Path::new("Contents/Info.plist")
            || tail
                .file_name()
                .is_some_and(|name| name == "InfoPlist.strings")
    })
}

fn relevant_event(event: &Event, roots: &[PathBuf]) -> bool {
    !event.kind.is_access()
        && (event.need_rescan()
            || event.paths.is_empty()
            || event.paths.iter().any(|path| relevant_path(path, roots)))
}

struct Pending {
    changed: Option<(Instant, Instant)>,
    check: bool,
    last_check_request: SystemTime,
    retry: Option<(Instant, usize)>,
    stopped: bool,
    force: bool,
}

impl Pending {
    fn new() -> Self {
        Self {
            changed: None,
            check: true,
            last_check_request: SystemTime::now(),
            retry: None,
            stopped: false,
            force: false,
        }
    }
    fn changed(&mut self, now: Instant) {
        self.changed = Some((self.changed.map(|(first, _)| first).unwrap_or(now), now));
    }
    fn request_check(&mut self, now: SystemTime) -> bool {
        // Wall time advances during macOS sleep; a wake after a long sleep must
        // reconcile even when the monotonic uptime clock paused while asleep.
        if now
            .duration_since(self.last_check_request)
            .unwrap_or(CHECK_INTERVAL)
            < CHECK_INTERVAL
        {
            return false;
        }
        self.last_check_request = now;
        self.check = true;
        true
    }
    fn deadline(&self, now: Instant) -> Option<Instant> {
        if let Some((first, last)) = self.changed {
            return Some((last + DEBOUNCE).min(first + MAX_DEBOUNCE));
        }
        if self.check {
            return Some(now);
        }
        self.retry.map(|(at, _)| at)
    }
    fn take_due(&mut self, now: Instant) -> bool {
        if self.deadline(now).is_none_or(|at| at > now) {
            return false;
        }
        if self.changed.take().is_some() {
            self.retry = Some((now + RETRIES[0], 0));
        } else if let Some((at, step)) = self.retry {
            if at <= now {
                self.retry = RETRIES.get(step + 1).map(|delay| (now + *delay, step + 1));
            }
        }
        self.check = false;
        true
    }
}

pub(crate) struct Runtime {
    pending: Arc<Mutex<Pending>>,
    wake: mpsc::SyncSender<()>,
}

impl Runtime {
    fn check(&self) {
        if self
            .pending
            .lock()
            .unwrap()
            .request_check(SystemTime::now())
        {
            let _ = self.wake.try_send(());
        }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.pending.lock().unwrap().stopped = true;
        let _ = self.wake.try_send(());
    }
}

pub(crate) fn check(app: &tauri::AppHandle) {
    if let Some(runtime) = app.try_state::<Runtime>() {
        runtime.check();
    }
}

pub(crate) fn stop(app: &tauri::AppHandle) {
    if let Some(runtime) = app.try_state::<Runtime>() {
        runtime.pending.lock().unwrap().stopped = true;
        let _ = runtime.wake.try_send(());
    }
}

pub(crate) fn start(app: &tauri::AppHandle) {
    let (wake, receiver) = mpsc::sync_channel(1);
    let pending = Arc::new(Mutex::new(Pending::new()));
    let runtime = Runtime {
        pending: pending.clone(),
        wake: wake.clone(),
    };
    app.manage(runtime);
    let app = app.clone();
    std::thread::spawn(move || {
        let roots = directories();
        let mut watcher: Option<RecommendedWatcher> = None;
        let mut watched = HashSet::new();
        loop {
            let (due, force, wait) = {
                let mut work = pending.lock().unwrap();
                if work.stopped {
                    break;
                }
                let now = Instant::now();
                let due = work.take_due(now);
                (
                    due,
                    due && std::mem::take(&mut work.force),
                    work.deadline(now)
                        .map(|at| at.saturating_duration_since(now)),
                )
            };
            if !due {
                let result = match wait {
                    Some(wait) => receiver.recv_timeout(wait),
                    None => receiver
                        .recv()
                        .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
                };
                if matches!(result, Err(mpsc::RecvTimeoutError::Disconnected)) {
                    break;
                }
                continue;
            }
            if watcher.is_none() {
                let pending = pending.clone();
                let wake = wake.clone();
                let roots = roots.clone();
                match notify::recommended_watcher(move |event: notify::Result<Event>| {
                    if event
                        .as_ref()
                        .map(|event| relevant_event(event, &roots))
                        .unwrap_or(true)
                    {
                        let force = event
                            .as_ref()
                            .map(|event| {
                                event.need_rescan()
                                    || event.paths.iter().any(|path| {
                                        path.file_name().is_some_and(|name| {
                                            name == "Info.plist" || name == "InfoPlist.strings"
                                        })
                                    })
                            })
                            .unwrap_or(true);
                        let mut work = pending.lock().unwrap();
                        work.changed(Instant::now());
                        work.force |= force;
                        let _ = wake.try_send(());
                    }
                }) {
                    Ok(value) => watcher = Some(value),
                    Err(error) => eprintln!("[flowhub-tauri] 应用目录监听暂不可用：{error}"),
                }
            }
            if let Some(watcher) = watcher.as_mut() {
                for root in &roots {
                    // A missing ~/Applications is watched through its parent;
                    // switch to recursive watching once it has been created.
                    if !root.exists() && watched.remove(root) {
                        let _ = watcher.unwatch(root);
                    }
                    let target = if root.is_dir() {
                        root.as_path()
                    } else {
                        root.parent().unwrap()
                    };
                    if !watched.contains(target) {
                        let mode = if target == root && recursive_root(root) {
                            RecursiveMode::Recursive
                        } else {
                            RecursiveMode::NonRecursive
                        };
                        match watcher.watch(target, mode) {
                            Ok(()) => {
                                watched.insert(target.to_path_buf());
                            }
                            Err(error) => eprintln!(
                                "[flowhub-tauri] 无法监听应用目录 {}：{error}",
                                target.display()
                            ),
                        }
                    }
                }
            }
            match refresh(&app, &roots, force) {
                Ok(true) => {
                    let mut work = pending.lock().unwrap();
                    if work.retry.is_none() {
                        work.retry = Some((Instant::now() + RETRIES[0], 0));
                    }
                }
                Ok(false) => {}
                Err(error) => {
                    pending.lock().unwrap().force |= force;
                    // Keep the last usable index on transient permission/I/O errors.
                    eprintln!("[flowhub-tauri] 更新应用索引失败，保留缓存：{error}");
                }
            }
        }
    });
}

fn refresh(app: &tauri::AppHandle, roots: &[PathBuf], force: bool) -> Result<bool, String> {
    let changed = reconcile(&app.state::<AppState>(), roots, force)?;
    if changed {
        let _ = app.emit("flowhub:applications-updated", ());
    }
    Ok(changed)
}

fn reconcile(state: &AppState, roots: &[PathBuf], force: bool) -> Result<bool, String> {
    let snapshot = snapshot(roots)?;
    if !force && *state.application_fingerprint.lock().unwrap() == snapshot.fingerprint {
        return Ok(false);
    }
    let applications = scan_applications(&snapshot.paths);
    *state.application_index.write().unwrap() = applications.clone();
    *state.application_fingerprint.lock().unwrap() = snapshot.fingerprint.clone();
    state.application_icon_cache.lock().unwrap().clear();
    persist_application_cache(
        &state.application_index_path,
        &applications,
        &snapshot.fingerprint,
    );
    Ok(true)
}

fn scan_applications(paths: &[PathBuf]) -> Vec<Value> {
    let mut applications: Vec<Value> = paths
        .iter()
        .map(|path| {
            let name = path.file_name().unwrap().to_string_lossy();
            json!({"kind":"app", "title":name[..name.len()-4], "fileName":name,
            "path":path.to_string_lossy(), "bundleId":"", "iconUrl":""})
        })
        .collect();
    if cfg!(target_os = "macos") && !applications.is_empty() {
        const SCRIPT: &str = r#"ObjC.import('Foundation');
var args = $.NSProcessInfo.processInfo.arguments, result = [];
function field(dictionary, key) {
    try {
        var value = ObjC.unwrap(dictionary.objectForKey(key));
        return typeof value === 'string' ? value : '';
    } catch (error) { return ''; }
}
for (var i = 6; i < args.count; i++) {
    try {
        var bundle = $.NSBundle.bundleWithPath(ObjC.unwrap(args.objectAtIndex(i)));
        var local = bundle.localizedInfoDictionary, info = bundle.infoDictionary;
        var display = field(local, 'CFBundleDisplayName') || field(local, 'CFBundleName')
            || field(info, 'CFBundleDisplayName') || field(info, 'CFBundleName');
        result.push({displayName: display, bundleId: ObjC.unwrap(bundle.bundleIdentifier) || ''});
    } catch (error) { result.push({displayName: '', bundleId: ''}); }
}
console.log(JSON.stringify(result));"#;
        let paths: Vec<String> = applications
            .iter()
            .filter_map(|application| {
                application
                    .get("path")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        let mut command = Command::new("osascript");
        command.args(["-l", "JavaScript", "-e", SCRIPT, "--"]);
        command.args(&paths);
        if let Ok(output) = command.output() {
            let text = if output.stdout.is_empty() {
                output.stderr
            } else {
                output.stdout
            };
            let metadata: Vec<Value> = serde_json::from_slice(&text).unwrap_or_default();
            for (index, application) in applications.iter_mut().enumerate() {
                if let Some(object) = application.as_object_mut() {
                    let display = metadata
                        .get(index)
                        .and_then(|entry| entry.get("displayName"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let bundle_id = metadata
                        .get(index)
                        .and_then(|entry| entry.get("bundleId"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if !display.is_empty() {
                        object.insert("title".to_string(), Value::String(display.to_string()));
                    }
                    object.insert("bundleId".to_string(), Value::String(bundle_id.to_string()));
                }
            }
        }
    }
    for application in &mut applications {
        let title = application
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("");
        let file_name = application
            .get("fileName")
            .and_then(Value::as_str)
            .unwrap_or("");
        let path = application
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("");
        let bundle_id = application
            .get("bundleId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let hay = format!("{title} {file_name} {bundle_id} {path}").to_lowercase();
        application
            .as_object_mut()
            .unwrap()
            .insert("hay".to_string(), Value::String(hay));
    }
    applications.sort_by(|left, right| {
        left.get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase()
            .cmp(
                &right
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_lowercase(),
            )
    });
    applications
}

pub(crate) fn load_application_cache(path: &Path) -> (Vec<Value>, String) {
    let Some(value) = read_json(path) else {
        return (Vec::new(), String::new());
    };
    let fingerprint = value
        .get("fingerprint")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let applications = value
        .get("applications")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    (applications, fingerprint)
}

fn persist_application_cache(path: &Path, applications: &[Value], fingerprint: &str) {
    let value = json!({
        "version": 1,
        "fingerprint": fingerprint,
        "applications": applications
    });
    if let Err(error) = write_json_atomic(path, &value) {
        eprintln!("[flowhub-tauri] 保存应用索引失败：{error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::tests::Fixture;

    fn bundle(root: &Path, name: &str) -> PathBuf {
        let path = root.join(name);
        fs::create_dir_all(path.join("Contents")).unwrap();
        path
    }

    #[test]
    fn snapshot_finds_nested_apps_but_never_indexes_bundle_contents() {
        let f = Fixture::new();
        let root = f.root.join("Applications");
        let outer = bundle(&root, "Tools/Editor.APP");
        bundle(&outer, "Contents/Helpers/Private.app");
        bundle(&root, ".staging/Hidden.app");
        let normal = bundle(&root, "Browser.app");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, root.join("Tools/loop")).unwrap();
        let result = snapshot(&[root.clone(), root.join("Tools")]).unwrap();
        assert_eq!(result.paths, vec![normal, outer]);
    }

    #[test]
    fn install_metadata_completion_move_and_uninstall_change_the_fingerprint() {
        let f = Fixture::new();
        let roots = [f.root.join("Applications")];
        let before = snapshot(&roots).unwrap().fingerprint;
        let app = bundle(&roots[0], "New.app");
        let copying = snapshot(&roots).unwrap().fingerprint;
        assert_ne!(before, copying);
        fs::write(app.join("Contents/Info.plist"), "ready").unwrap();
        let complete = snapshot(&roots).unwrap().fingerprint;
        assert_ne!(copying, complete);
        fs::rename(&app, roots[0].join("Renamed.app")).unwrap();
        assert_ne!(complete, snapshot(&roots).unwrap().fingerprint);
        fs::remove_dir_all(&roots[0]).unwrap();
        assert_eq!(before, snapshot(&roots).unwrap().fingerprint);
    }

    #[test]
    fn reconcile_persists_additions_and_removals_and_preserves_cache_on_error() {
        let f = Fixture::new();
        let roots = [f.root.join("Applications")];
        bundle(&roots[0], "New.app");
        assert!(reconcile(&f.state, &roots, false).unwrap());
        assert_eq!(f.state.application_index.read().unwrap().len(), 1);
        let (cache, fingerprint) = load_application_cache(&f.state.application_index_path);
        assert_eq!(cache.len(), 1);
        assert_eq!(
            fingerprint,
            *f.state.application_fingerprint.lock().unwrap()
        );
        assert!(!reconcile(&f.state, &roots, false).unwrap());
        let invalid_root = f.root.join("not-a-directory");
        fs::write(&invalid_root, "test").unwrap();
        assert!(reconcile(&f.state, &[invalid_root], false).is_err());
        assert_eq!(*f.state.application_index.read().unwrap(), cache);
        fs::remove_dir_all(&roots[0]).unwrap();
        assert!(reconcile(&f.state, &roots, false).unwrap());
        assert!(f.state.application_index.read().unwrap().is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn metadata_notification_reloads_a_bundle_even_when_an_installer_preserves_timestamps() {
        let f = Fixture::new();
        let roots = [f.root.join("Applications")];
        let app = bundle(&roots[0], "Metadata.app");
        let info = app.join("Contents/Info.plist");
        let plist = |name| {
            format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>test.flowhub.metadata</string><key>CFBundleName</key><string>{name}</string></dict></plist>")
        };
        fs::write(&info, plist("Before")).unwrap();
        assert!(reconcile(&f.state, &roots, false).unwrap());
        let old_stamp = fs::metadata(&info).unwrap().modified().unwrap();
        fs::write(&info, plist("After!")).unwrap();
        fs::File::options()
            .write(true)
            .open(&info)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(old_stamp))
            .unwrap();
        assert!(!reconcile(&f.state, &roots, false).unwrap());
        assert!(reconcile(&f.state, &roots, true).unwrap());
        assert_eq!(
            f.state.application_index.read().unwrap()[0]["title"],
            "After!"
        );
    }

    #[test]
    fn change_storms_are_debounced_bounded_and_retried_without_idle_polling() {
        let now = Instant::now();
        let mut work = Pending::new();
        assert!(work.take_due(now));
        assert!(work.deadline(now).is_none());
        for millis in (0..5000).step_by(100) {
            work.changed(now + Duration::from_millis(millis));
        }
        assert!(!work.take_due(now + Duration::from_millis(4999)));
        assert!(work.take_due(now + MAX_DEBOUNCE));
        assert!(work.changed.is_none());
        assert!(work.take_due(now + Duration::from_secs(7)));
        assert!(work.take_due(now + Duration::from_secs(15)));
        assert!(work.take_due(now + Duration::from_secs(35)));
        assert!(work.deadline(now + Duration::from_secs(100)).is_none());
        // A notification arriving during a scan must schedule a second pass.
        work.changed(now + Duration::from_secs(100));
        assert!(work.take_due(now + Duration::from_secs(101)));
    }

    #[test]
    fn show_checks_are_memory_only_and_throttled_even_when_the_worker_is_busy() {
        let (wake, receiver) = mpsc::sync_channel(1);
        let pending = Arc::new(Mutex::new(Pending::new()));
        let runtime = Runtime {
            wake,
            pending: pending.clone(),
        };
        pending.lock().unwrap().take_due(Instant::now());
        let started = Instant::now();
        for _ in 0..10_000 {
            runtime.check();
        }
        println!("10,000 cached show checks: {:?}", started.elapsed());
        assert!(receiver.try_recv().is_err());
        let wall = pending.lock().unwrap().last_check_request;
        assert!(pending.lock().unwrap().request_check(wall + CHECK_INTERVAL));
        assert!(pending.lock().unwrap().take_due(Instant::now()));
        // A backwards wall-clock adjustment also permits reconciliation.
        assert!(pending.lock().unwrap().request_check(wall));
        // The bounded wake channel coalesces signals; its full state never
        // blocks the caller or loses the dirty state stored in Pending.
        runtime.wake.try_send(()).unwrap();
        pending.lock().unwrap().changed(Instant::now());
        assert!(runtime.wake.try_send(()).is_err());
        assert!(pending.lock().unwrap().changed.is_some());
    }

    #[test]
    fn ignores_app_internal_activity_but_accepts_metadata_and_lost_events() {
        let roots = [PathBuf::from("/Applications")];
        assert!(!relevant_path(
            Path::new("/Applications/App.app/Contents/Logs/busy.log"),
            &roots
        ));
        assert!(!relevant_path(Path::new("/Other/App.app"), &roots));
        assert!(relevant_path(Path::new("/Applications/Tools"), &roots));
        assert!(relevant_path(
            Path::new("/Applications/App.app/Contents/Info.plist"),
            &roots
        ));
        assert!(relevant_event(
            &Event::new(notify::EventKind::Other),
            &roots
        ));
    }

    #[test]
    fn native_watcher_detects_install_rename_and_remove_in_a_temporary_directory() {
        let f = Fixture::new();
        let root = fs::canonicalize(&f.root).unwrap();
        let roots = vec![root.clone()];
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            if event
                .as_ref()
                .is_ok_and(|event| relevant_event(event, &roots))
            {
                let _ = tx.send(());
            }
        })
        .unwrap();
        watcher.watch(&root, RecursiveMode::Recursive).unwrap();
        let app = bundle(&root, "Installed.app");
        rx.recv_timeout(Duration::from_secs(8))
            .expect("install notification");
        while rx.try_recv().is_ok() {}
        let renamed = root.join("Renamed.app");
        fs::rename(app, &renamed).unwrap();
        rx.recv_timeout(Duration::from_secs(8))
            .expect("rename notification");
        while rx.try_recv().is_ok() {}
        fs::remove_dir_all(renamed).unwrap();
        rx.recv_timeout(Duration::from_secs(8))
            .expect("remove notification");
    }
}

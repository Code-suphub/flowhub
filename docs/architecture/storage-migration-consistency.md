# Storage migration and clipboard persistence

Settings saves are serialized by `AppState::config_save`. Before switching storage,
the save path stops and joins the clipboard watcher (including any callback already
reading/encoding clipboard data), then closes the writer's sender and joins the
writer after its FIFO queue drains. The watcher lifecycle lock excludes a restart
while these joins run. Do not acquire exclusive storage access before draining:
the writer needs shared storage access to complete.

`database()` returns a `StorageConnection` that owns a shared storage lease until
the SQLite connection closes. This covers usage records, catalog operations,
clipboard writes, deletion and retention cleanup. Image operations use the
connection's captured storage directory for the full database/file operation.
Future database consumers must use this wrapper, and must not recursively call
`database()` while holding another lease (a waiting migration could deadlock a
recursive read lock).

`switch_storage()` acquires exclusive storage access before examining paths. For
an empty target it copies attachments to a sibling staging directory and uses
SQLite backup for the database, excluding SQLite sidecars. A complete, validated
snapshot replaces the empty destination with a rename before active paths change.
Failures clean up the staging directory and leave the source active. Existing
database targets are initialized before publishing their paths. Symlink aliases
cannot bypass the nested-directory check.

The save path restores clipboard monitoring on persistence failure, reports
restart failures, and resumes monitoring before applying unrelated UI settings.

Regression tests use isolated temporary directories and controlled worker channels:

- Stop waits for an in-flight write and drains queued images before migration.
- A live database lease blocks migration; the image and its late record both arrive.
- Committed WAL pages survive backup without copying WAL/SHM files.
- Copy failure leaves an empty target suitable for retry and removes staging data.
- Invalid target databases do not replace active paths.
- Symlink aliases to nested destinations are rejected.

Scope and limitations: changes occurring on the system clipboard while monitoring
is paused are not captured. Tests do not operate the real macOS clipboard watcher.
The storage lease coordinates this process; other programs directly modifying
attachments are outside it. Task 01 alone did not make the overall settings save transactional. The task 02
section below supersedes that limitation for process-failure recovery; existing-
database catalog replacement semantics remain unchanged. The staged rename assumes the
macOS/POSIX empty-directory replacement behavior and requires write access to the
target's parent directory. Legacy startup import behavior is unchanged.

## Transactional settings save (sequence task 02)

The production save now uses `config_save::persist`. The lock order remains
`config_save` → stop/join clipboard watcher and drain writer → exclusive
`storage_access` → `paths`. Destination preparation (`prepare_storage`) does not
publish paths. The exclusive lease covers the complete save and any rollback;
this code uses raw SQLite connections and never recursively calls `database()`.
Hydrated readers acquire their database lease before reading the config file.
The menu-bar organizer's separate config-file writer also takes `config_save`.

Before changing the catalog or JSON files, the save creates
`<app support>/.flowhub-config-save/before.db` using SQLite backup, and an atomic
`journal.json` containing the destination database path and exact previous bytes
(or absence) of the destination config and locator. The backup and journal are
synced before mutations. The catalog commits, the config and locator are replaced
with synced sibling-file renames, then the journal receives a committed marker.
Only then are all three runtime paths published together. The locator records the
resolved config destination even when the submitted config uses the default path.
Config destinations cannot alias the database, SQLite sidecars, locator or journal.

Before the commit marker, failures restore the destination database (including its
original catalog metadata), config bytes and locator. Recovery is repeatable and
retains the journal until every undo succeeds. A failed undo blocks database
access instead of allowing writes to a partially restored store. Startup runs
recovery **before** resolving the locator, importing legacy data or starting
workers; an inaccessible/corrupt pending journal stops initialization. A committed
journal is only cleaned up, never undone. Cleanup failure after commit does not
change save success. If the commit rename succeeds but its directory sync reports
an error, the on-disk committed decision is honored and `storageState.warning`
reports that durability could not be confirmed.

Post-commit integration uses `saved_response`: clipboard, hotkey, autostart,
menu-bar, organizer and config broadcast are all attempted. Synchronous failures
are reported in the existing `pluginFailures` response, with `ok: true` and
`persisted: true`; they do not become a false overall save failure. The response
uses the committed config and submitted catalog, so it does not depend on another
fallible database read after commit. Settings displays a system-settings warning.
The organizer's existing asynchronous callback still logs later errors rather
than returning them synchronously; this task does not change that lifecycle.

Added isolated tests cover injected failures at every pre-commit boundary,
actual config/locator rename failures and blocked-undo retry, an actual deferred
SQLite COMMIT constraint failure, restoration of an existing target's catalog and
metadata, concurrent hydrated reads, reserved-path aliases, and post-commit
integration errors without skipping broadcast. Restart coverage includes both
same-store/migrated-store boundary tests and child-process exits without Rust
destructors after database, config, locator and committed-marker writes.

Limitations: the undo snapshot costs space and time proportional to the database.
A prepared migration snapshot can remain at the destination after an unsuccessful
save; it contains a consistent source snapshot and its original catalog, while
the source stays active. Existing-target opening/replacement semantics and legacy
import remain task 03; in-flight frontend editing remains task 04. External
processes modifying these files are not coordinated. These tests cover process
termination, not hardware power loss or a filesystem ignoring sync requests; the
existing attachment-copy phase is not a power-loss durability guarantee. An exit
during a sibling-file write can leave an unused `.flowhub-save-*.tmp` file.
No real user database, clipboard watcher or system integration was exercised.

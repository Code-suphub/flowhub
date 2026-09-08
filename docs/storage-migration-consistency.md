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
attachments are outside it. This change does not make the overall settings save
transactional, change existing-database catalog replacement semantics, or add
crash/power-loss recovery for settings persistence. The staged rename assumes the
macOS/POSIX empty-directory replacement behavior and requires write access to the
target's parent directory. Legacy startup import behavior is unchanged.

# Existing storage opening (sequence task 03)

This supersedes the existing-target replacement and legacy-import limitations in
`storage-migration-consistency.md`. Task 02's journal and lock ordering remain.

The backend decides the operation while holding exclusive storage access:

- Same directory (including aliases): save the submitted catalog as before.
- Empty destination: copy the consistent source snapshot and save the submitted
  catalog. Source files remain in place.
- Different directory containing a supported `weborg.db`: open its catalog,
  usage history and clipboard together. Do not replace its catalog or metadata
  with the current window's draft. Other submitted application settings are saved.

`storageState.operation` reports `save`, `migrate` or `open`. The persisted JSON
stores only catalog metadata; the response and broadcast use the selected catalog
captured inside the save lock. Settings adopts that response and explains both
operations before saving, including the effect on the current web draft.

The same backend rule applies to paths submitted through the JSON editor and to
resetting the storage path to its default. At startup, a database already present
at the resolved JSON path is validated before use and receives neither legacy
catalog nor legacy image imports. In particular, an intentionally empty catalog
stays empty even when the JSON contains an old mirror.

Validation opens external existing databases read-only, checks SQLite integrity,
required FlowHub tables and columns, JSON object nodes and complete reachable
catalog structure. Unknown, damaged or incompatible databases fail before schema
initialization, journal creation or active-path publication. This version does not
upgrade incomplete older schemas automatically. Startup validation occurs before
AppState or workers are exposed; runtime validation uses the existing exclusive
storage lease, without recursive database leases.

Tests use temporary SQLite stores with different A/B catalogs, usage records,
clipboard records and attachment bytes. They cover successful opening and return
to defaults, all pre-commit failure boundaries in both directions, an empty target
migration, an existing empty catalog with a stale startup JSON mirror, rejected
unknown/corrupt/incomplete databases, and form/JSON settings response adoption.
Task 02's rollback, process-exit recovery and post-commit integration tests remain.

Limits: external writers are not coordinated, integrity checking and the undo
snapshot cost time proportional to the database, and real clipboard/system UI
integration and hardware power loss are not tested. SQLite may create its own WAL
sidecars when reading an existing WAL-mode database; database content is not
initialized or rewritten by validation. Failed empty-directory saves may leave a
consistent snapshot at the target, as documented in task 02; a subsequent save
opens that now-existing snapshot. Task 04's concurrent editing behavior is unchanged.

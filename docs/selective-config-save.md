# Selective settings persistence (sequence 08)

This supersedes the unconditional backup / catalog replacement / integration
reapplication described in sequence 02. Existing-store protection and settings
window draft adoption from sequences 03–04 are unchanged.

`config_save::persist` chooses a typed `SavePlan` using the current SQLite catalog
under exclusive storage access, resolved active/destination paths, and persisted
JSON/locator contents. Client metadata such as `catalogUpdatedAt` and
`catalogCount` is replaced with trusted database values; it cannot select a plan.

| Plan | Database work | Durable files |
| --- | --- | --- |
| Noop | Read catalog; no writes or backup | No writes / journal |
| Files | Read catalog; no writes or backup | JSON + optional locator, file-only undo journal |
| Catalog | Undo backup + transactional catalog replacement | JSON + optional locator |
| Migrate | Existing staged snapshot to empty destination; replace catalog only if draft differs from copied catalog | Files; database undo backup only when replacing catalog |
| Open | Validate existing store and select its catalog; no replacement or undo backup | File-only undo journal |

Storage preparation runs only for a different resolved storage directory. Moving
only the JSON config file still journals both its prior destination bytes (or
absence) and the locator; a failure restores the previous locator/config and
leaves the database untouched. The journal database path is now optional. Old
journals containing a database path still deserialize and restore normally.
Startup recovery runs before resolving the locator or opening the active store.
The committed marker remains the durable decision point; cleanup failures cannot
turn a successful commit into failure.

## Lock order and live capabilities

The command holds `config_save` across comparison, persistence, integrations and
broadcast. Only a physical database-directory change stops/joins the clipboard
watcher and drains its writer before acquiring `storage_access`. Persistence
then takes exclusive `storage_access`, uses raw SQLite connections, and takes
`paths` only inside that scope. It never joins workers or recursively obtains a
`database()` lease. Integrations run after releasing exclusive storage access.
Thus a normal settings save can wait briefly for existing database users without
restarting their lifecycle or waiting for them while holding their required lock.

`IntegrationPlan` compares the previous hydrated backend config with the committed
hydrated response, using runtime defaults and retention clamps:

- Clipboard: enablement, effective retention/record/byte limits, or storage switch.
- Hotkey: effective shortcut; autostart: effective launch-at-login flag.
- Menu: tray enablement, displayed actions, organizer settings.
- Organizer: organizer enablement and collapse-on-launch.
- Broadcast: hydrated config changed.

Unchanged capabilities return `{skipped: true}` and invoke no callback. A failed
selected capability is included in `pluginFailures`, while later selected
capabilities and broadcast still execute; persistence stays successful.

## Verification and limits

Isolated temporary SQLite tests cover forbidden catalog writes using an aborting
trigger; preserved database bytes, inode, modification time, catalog timestamp,
usage/clipboard records and attachments; forged client metadata; no-op file
identity; unchanged-catalog migration without a second database backup; all file
undo boundaries; and selective callback execution with partial failure.
Independent child processes exit without destructors at database/config/locator/
commit boundaries for file-only saves, config-file moves, and database migration;
the parent recovers using only on-disk state. Existing target protection, migration
concurrency, deferred SQLite commit failure and hydrated-reader consistency tests
remain enabled.

Validation: `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
CARGO_INCREMENTAL=0 npm test --prefix app` (81 Rust tests, UI/syntax checks and
4 preview tests); root `npm test` (8 tests); `git diff --check`.

The current catalog is still read/compared in full, and a real catalog change
still takes a complete database undo snapshot. External processes bypassing the
storage leases are not coordinated. Failed empty-directory saves can retain a
complete staged destination as before. Native macOS capability calls and power
loss are not exercised by these isolated tests. Existing organizer application
is asynchronous; callback errors after scheduling are still logged by that
integration. No-op saves deliberately do not retry previously failed system
capabilities; changing the relevant setting or restarting reapplies them.

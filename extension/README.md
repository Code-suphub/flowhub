# FlowHub Chrome Extension

Chrome Extension version of the FlowHub workspace.

## Load Locally

1. Open `chrome://extensions/`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this `extension/` folder.

## Surfaces

- `side_panel.html`: persistent side panel.
- `popup.html`: toolbar popup.
- `newtab.html`: Chrome new tab override.
- `src/floating.js`: in-page floating launcher injected into normal `http` and `https` pages.

Links open in real browser tabs instead of extension iframes. The default mode is the current active tab, so the side panel can stay open while the target site gets normal browser cookies and login state. Use the in-panel switch to open links in a new tab instead.

The floating launcher stays on normal web pages as a fixed bottom-right button. It cannot be injected into Chrome internal pages such as `chrome://extensions`, the Chrome Web Store, or other restricted browser pages.

The extension first reads live config from the local manager at `http://localhost:4173/api/config`.
If the manager is not running, it falls back to the bundled `extension/config.json`.

## Legacy catalog boundary

The root `server.mjs`, root `index.html`, HTTP CLI config commands / `web list`,
and this extension support only the legacy JSON object with a top-level `items`
array. An explicit `items: []` is a valid empty catalog. Missing/non-array items,
non-object nodes, invalid children, and desktop objects containing `core` or
`plugins` are errors. Unknown legacy metadata is preserved on save.

Desktop `plugins.web.settings.items` is not supported, including hydrated
snapshots. Persisted `catalogStorage: "sqlite"` JSON can contain placeholder
empty items; reading that JSON cannot establish that the database is empty.
Use the desktop application to manage its catalog, or explicitly prepare an
independent legacy JSON copy. Do not point the old service at desktop storage.
The repository's root example is desktop SQLite config, so the old service now
reports this boundary instead of displaying a successful empty catalog.
The HTTP CLI `memo list` is unsupported and returns an error.

Only connection failures advance to another host or the bundled example.
A reachable server's HTTP error, invalid JSON or unsupported catalog is shown
as an error and does not replace the extension cache. Floating windows also
validate cache notifications and retain their current catalog on invalid data.
No desktop database is opened or exported by the legacy service.

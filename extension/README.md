# Web Organization Chrome Extension

Chrome Extension version of the Web Organization workspace.

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

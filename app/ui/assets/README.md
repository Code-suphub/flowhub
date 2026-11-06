# Application and catalog icons

`flowhub.svg` is the source for FlowHub's blue faceted-diamond app mark. Settings,
updates and the menu-bar preview use this same file. Regenerate native app icons
from `app/` with `pnpm exec tauri icon ui/assets/flowhub.svg --output src-tauri/icons`.
The native macOS menu-bar template in `src-tauri/src/menu_bar/icon.rs` uses the same
diamond silhouette, with a transparent seam instead of color to distinguish its facets.

UI feature artwork lives in `src/shared/FeatureIcon.tsx` and `feature-icons.css`:
blue for apps/links, orange for clipboard, amber for notes, violet for extensions,
and green for widgets/machines. These are product-specific icons, not new controls.
Unknown plugins keep the violet puzzle fallback. User-supplied web and app icons
continue to take precedence over search fallback artwork.

## Web catalog icons

`web-icons/*.png` are 72×72 favicons imported with the uTools links (commit `cae835b`)
and referenced by **catalog data**, not by code.

A catalog entry stores an icon path in its `icon` field:

```json
{ "id": "aliyun", "title": "阿里云", "icon": "assets/web-icons/<sha256>.png" }
```

That data lives in the user's catalog — originally the repository `config.json`, now the
SQLite store `~/Library/Application Support/FlowHub/clipboard/weborg.db`
(`web_catalog_nodes.data_json`). When this repository's `config.json` still carried the
imported links, 68 nodes pointed at these files.

Do not delete these files as "unreferenced": a source search cannot see them, and removing
one degrades the matching catalog entry to the `⌁` placeholder fallback.

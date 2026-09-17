# Web catalog icons

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

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const store = require("../clipboard-store");
const { stripWebCatalogMirror } = require("../config-persistence");

test("网页目录可以迁移到 SQLite 并完整恢复层级与扩展字段", async () => {
  const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "flowhub-web-catalog-"));
  const catalog = [
    {
      id: "root",
      title: "根目录",
      icon: "✦",
      children: [
        { id: "page-a", title: "页面 A", url: "https://a.example/", note: "说明", custom: { keep: true } },
        {
          id: "folder-b",
          title: "目录 B",
          children: [{ id: "page-b", title: "页面 B", url: "https://b.example/" }]
        }
      ]
    }
  ];

  try {
    await store.open(testDirectory);
    const migrated = store.initializeWebCatalog(catalog);
    assert.equal(migrated.migrated, true);
    assert.equal(store.webCatalogCount(), 4);
    assert.equal(store.webCatalogStoredSignature(), store.webCatalogSignature(catalog));
    assert.deepEqual(store.webCatalogItems(), catalog);
    store.close();

    await store.open(testDirectory);
    assert.deepEqual(store.webCatalogItems(), catalog);

    const replacement = [{ id: "only", title: "替换后", url: "https://only.example/" }];
    const replaced = store.replaceWebCatalog(replacement);
    assert.equal(replaced.count, 1);
    assert.deepEqual(store.webCatalogItems(), replacement);
  } finally {
    store.close();
    fs.rmSync(testDirectory, { recursive: true, force: true });
  }
});

test("网页目录签名不受对象字段排列顺序影响", () => {
  const left = [{ id: "page", title: "页面", url: "https://example.com/" }];
  const right = [{ url: "https://example.com/", title: "页面", id: "page" }];
  assert.equal(store.webCatalogSignature(left), store.webCatalogSignature(right));
});

test("持久化配置会剥离网页目录镜像且不修改运行时对象", () => {
  const runtimeConfig = {
    core: { hotkey: "Alt+Space" },
    plugins: {
      web: {
        enabled: true,
        settings: {
          items: [{ id: "private", title: "私人站点", url: "https://private.example/" }],
          catalogStorage: "sqlite",
          catalogCount: 1,
          catalogSignature: "private-signature"
        }
      }
    }
  };
  const persisted = stripWebCatalogMirror(runtimeConfig);
  assert.equal(runtimeConfig.plugins.web.settings.items.length, 1);
  assert.deepEqual(persisted.plugins.web.settings, { items: [], catalogStorage: "sqlite" });
  assert.equal(persisted.core.hotkey, "Alt+Space");
});

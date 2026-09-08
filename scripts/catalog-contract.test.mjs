import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import "../extension/src/config-contract.js";

const { validate, readSources } = globalThis.FlowHubLegacyCatalog;
const desktop = (items, storage = "sqlite") => ({ plugins: { web: { settings: { items, catalogStorage: storage } } } });
const legacy = { app: { title: "Fixture" }, items: [{ id: "root", children: [{ id: "page", url: "https://example.test" }] }] };
const unsupported = [null, [], {}, { items: {} }, { items: [null] }, { items: [{ children: {} }] },
  desktop([]), desktop(legacy.items), desktop([], "json"), { ...desktop([]), items: [] }];

test("legacy catalog preserves nodes/metadata and explicit emptiness; desktop never implies emptiness", () => {
  assert.equal(validate(legacy), legacy);
  assert.deepEqual(validate({ items: [] }), { items: [] });
  for (const config of unsupported) assert.throws(() => validate(config));
  for (const config of [desktop([]), desktop(legacy.items)]) assert.throws(() => validate(config), /SQLite.*水合/);
});

test("standalone index validates the same boundary before rendering or editing", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const fn = html.match(/      function validateLegacyConfig\(config\) \{[\s\S]*?\n      \}/)[0];
  const validateIndex = runInNewContext(`(${fn.trim()})`);
  for (const config of unsupported) assert.throws(() => validateIndex(config));
  assert.equal(validateIndex(legacy), legacy);
  assert.deepEqual(validateIndex({ items: [] }), { items: [] });
  assert.match(html, /data-action="config"[^>]*disabled/);
});

test("source fallback only on connection failure, never on authoritative invalid data", async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url !== "bundled") throw new TypeError("offline");
    return { ok: true, json: async () => legacy };
  };
  assert.equal(await readSources(["localhost", "loopback", "bundled"], fetcher), legacy);
  assert.deepEqual(calls, ["localhost", "loopback", "bundled"]);
  for (const config of unsupported) {
    let requests = 0;
    await assert.rejects(readSources(["live", "bundled"], async () => {
      requests++;
      return { ok: true, json: async () => config };
    }));
    assert.equal(requests, 1);
  }
  for (const response of [
    { ok: false, status: 400, json: async () => ({ reason: "SQLite 未水合" }) },
    { ok: true, json: async () => { throw new SyntaxError("bad JSON"); } }
  ]) {
    let requests = 0;
    await assert.rejects(readSources(["live", "bundled"], async () => { requests++; return response; }));
    assert.equal(requests, 1);
  }
});

test("background message rejects bad snapshots without replacing cache; real empty catalog updates cache", async () => {
  const contract = await readFile(new URL("../extension/src/config-contract.js", import.meta.url), "utf8");
  const background = await readFile(new URL("../extension/src/background.js", import.meta.url), "utf8");
  let listener;
  let cached = legacy;
  let payload = desktop([]);
  const context = {
    fetch: async () => ({ ok: true, json: async () => payload }),
    chrome: {
      runtime: { getURL: (path) => path, onMessage: { addListener: (fn) => { listener = fn; } } },
      storage: { local: { set: async (value) => { cached = value["weborg.config-cache"].config; } } },
      tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } }
    },
    importScripts() {}, URL
  };
  runInNewContext(contract + "\n" + background, context);
  const request = () => new Promise((resolve) => listener({ type: "weborg:get-config" }, {}, resolve));
  for (const invalid of unsupported) {
    payload = invalid;
    assert.equal((await request()).ok, false);
    assert.equal(cached, legacy);
  }
  payload = { items: [] };
  assert.equal((await request()).ok, true);
  assert.equal(cached, payload);
});

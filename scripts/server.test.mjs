import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { mkdtemp, copyFile, writeFile, readFile, mkdir, symlink, unlink, rm, readdir } from "node:fs/promises";
import { tmpdir, networkInterfaces } from "node:os";
import { join } from "node:path";

const source = new URL("../", import.meta.url);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("legacy server boundaries in an isolated checkout", { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flowhub-server-test-"));
  let child;
  let fixture;
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
    if (fixture) await new Promise((resolve) => fixture.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  for (const name of ["server.mjs", "index.html"]) await copyFile(new URL(name, source), join(dir, name));
  const original = '{"items":[],"app":{"title":"Fixture"}}\n';
  await writeFile(join(dir, "config.json"), original);
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, ".git/config"), "PRIVATE-FIXTURE");
  await writeFile(join(dir, ".env"), "PRIVATE-FIXTURE");
  await writeFile(join(dir, "outside.txt"), "PRIVATE-FIXTURE");
  await symlink(join(dir, "outside.txt"), join(dir, "linked.html"));
  child = spawn(process.execPath, [join(dir, "server.mjs")], { env: { ...process.env, PORT: "0", APP_ORIGIN: "http://untrusted.invalid" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const base = await new Promise((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`server exited ${code}: ${stderr}`)));
    child.stdout.on("data", (chunk) => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]); });
  });
  const port = Number(new URL(base).port);
  function call(path, { method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }
  const token = JSON.parse((await call("/api/session")).text).token;
  const headers = { "content-type": "application/json", "x-flowhub-token": token, origin: base };

  await t.test("listener is loopback-only; sockets and incomplete headers are bounded", async () => {
    const localAddresses = Object.values(networkInterfaces()).flat().filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => entry.address);
    for (const host of ["::1", ...new Set(localAddresses)]) {
      const reachable = await new Promise((resolve) => {
        const socket = connect(port, host);
        socket.setTimeout(1000);
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
        socket.once("timeout", () => { socket.destroy(); resolve(false); });
      });
      assert.equal(reachable, false, host);
    }
    const sockets = Array.from({ length: 40 }, () => {
      const socket = connect(port, "127.0.0.1");
      socket.on("error", () => {});
      socket.resume();
      socket.on("connect", () => socket.write("GET / HTTP/1.1\r\n"));
      return socket;
    });
    try {
      await delay(150);
      assert.ok(sockets.filter((socket) => !socket.destroyed).length <= 32);
      await Promise.all(sockets.map((socket) => socket.destroyed ? undefined : once(socket, "close")));
      assert.equal((await call("/")).status, 200);
    } finally { for (const socket of sockets) socket.destroy(); }
    assert.equal((await call("/", { headers: { "x-large": "a".repeat(9000) } })).status, 400);
  });

  await t.test("legitimate entries, extension read, and CLI save", async () => {
    for (const path of ["/", "/index.html", "/?view=config"]) {
      const response = await call(path);
      assert.equal(response.status, 200);
      assert.match(response.text, /FlowHub/);
      assert.equal(response.headers["x-frame-options"], "DENY");
    }
    assert.equal((await call("/", { method: "HEAD" })).text, "");
    assert.equal((await call("/api/config", { headers: { host: `localhost:${port}` } })).status, 200);
    const extensionHeaders = { origin: `chrome-extension://${"a".repeat(32)}`, "sec-fetch-site": "cross-site" };
    assert.equal((await call("/api/config", { headers: extensionHeaders })).status, 200);
    assert.equal((await call("/api/session", { headers: extensionHeaders })).status, 403);
    const cli = spawn(process.execPath, [new URL("app/scripts/flowhub-cli.mjs", source).pathname, "config", "set", "app.title", '"CLI Fixture"'], { env: { ...process.env, FLOWHUB_URL: base }, stdio: "pipe" });
    let error = "";
    cli.stderr.on("data", (chunk) => { error += chunk; });
    assert.equal((await once(cli, "exit"))[0], 0, error);
    assert.equal(JSON.parse((await call("/api/config")).text).app.title, "CLI Fixture");
  });

  await t.test("hidden files, source, traversal, symlinks, and malformed URLs", async () => {
    for (const path of ["/.env", "/.git/config", "/server.mjs", "/package.json", "/config.json", "/app/ui/search.js", "/extension/src/background.js", "/linked.html", "/../index.html", "/%2e%2e/index.html", "/%2e%2e%2f.env", "/%252e%252e/.env", "/index.html%00", "/%5c..%5c.env"]) {
      const result = await call(path);
      assert.equal(result.status, 404, path);
      assert.doesNotMatch(result.text, /PRIVATE-FIXTURE/);
    }
    for (const path of ["/%ZZ", "/%E0%A4%A", "//evil.test/", "http://evil.test/", "/\\index.html"]) assert.equal((await call(path)).status, 400, path);
    await unlink(join(dir, "index.html"));
    await symlink(join(dir, "outside.txt"), join(dir, "index.html"));
    assert.equal((await call("/")).status, 500);
    await unlink(join(dir, "index.html"));
    await copyFile(new URL("index.html", source), join(dir, "index.html"));
    assert.equal((await call("/")).status, 200);
  });

  await t.test("Host, Origin, fetch metadata, token, media type and methods", async () => {
    const before = await readFile(join(dir, "config.json"), "utf8");
    for (const host of ["evil.test", `evil.test:${port}`, "localhost", `127.0.0.1:${port + 1}`]) assert.equal((await call("/api/config", { headers: { host } })).status, 403);
    for (const origin of ["https://evil.test", "null", `http://localhost:${port}`]) {
      assert.equal((await call("/api/config", { method: "POST", headers: { ...headers, origin }, body: '{"items":[]}' })).status, 403);
    }
    assert.equal((await call("/api/session", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    for (const changed of [{ "x-flowhub-token": "" }, { "x-flowhub-token": "b".repeat(64) }]) assert.equal((await call("/api/config", { method: "POST", headers: { ...headers, ...changed }, body: '{"items":[]}' })).status, 403);
    for (const type of ["text/plain", "", "application/x-www-form-urlencoded"]) assert.equal((await call("/api/config", { method: "POST", headers: { ...headers, "content-type": type }, body: '{"items":[]}' })).status, 415);
    for (const path of ["/api/config", "/api/probe", "/api/session", "/"]) assert.equal((await call(path, { method: "DELETE" })).status, 405);
    assert.equal((await call("/api/config", { method: "OPTIONS" })).status, 405);
    assert.equal(await readFile(join(dir, "config.json"), "utf8"), before);
  });

  await t.test("invalid, oversized, interrupted and concurrent writes; deadline recovery", async () => {
    const before = await readFile(join(dir, "config.json"), "utf8");
    for (const body of ["{", "[]", "{}", "null"]) assert.equal((await call("/api/config", { method: "POST", headers, body })).status, 400);
    assert.equal((await call("/api/config", { method: "POST", headers: { ...headers, "content-length": 1048577 } })).status, 413);
    assert.equal((await call("/api/config", { method: "POST", headers: { ...headers, "transfer-encoding": "chunked" }, body: " ".repeat(1048577) })).status, 413);
    // Compact input fits, but its pretty-printed representation must remain readable.
    assert.equal((await call("/api/config", { method: "POST", headers, body: JSON.stringify({ items: Array(150000).fill(0) }) })).status, 413);
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write(`POST /api/config HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nX-FlowHub-Token: ${token}\r\nContent-Length: 100\r\n\r\n{`);
    await delay(50);
    assert.equal((await call("/api/config", { method: "POST", headers, body: '{"items":[]}' })).status, 429);
    socket.destroy();
    await delay(50);
    const slow = connect(port, "127.0.0.1");
    slow.on("error", () => {});
    await once(slow, "connect");
    slow.resume();
    slow.write(`POST /api/config HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nX-FlowHub-Token: ${token}\r\nContent-Length: 100\r\n\r\n{`);
    await once(slow, "close");
    await delay(50);
    assert.equal(await readFile(join(dir, "config.json"), "utf8"), before);
    assert.equal((await call("/api/config", { method: "POST", headers, body: '{"items":[]}' })).status, 200);
    assert.equal((await call("/")).status, 200);
  });

  await t.test("atomic replacement does not write through config symlinks", async () => {
    await unlink(join(dir, "config.json"));
    await symlink(join(dir, "outside.txt"), join(dir, "config.json"));
    assert.equal((await call("/api/config")).status, 500);
    assert.equal((await call("/api/config", { method: "POST", headers, body: original })).status, 200);
    assert.equal(await readFile(join(dir, "outside.txt"), "utf8"), "PRIVATE-FIXTURE");
    assert.deepEqual(JSON.parse((await call("/api/config")).text), JSON.parse(original));
    assert.equal((await readdir(dir)).some((name) => name.endsWith(".tmp")), false);
    await unlink(join(dir, "config.json"));
    await mkdir(join(dir, "config.json"));
    await writeFile(join(dir, "config.json/keep"), "unchanged");
    const failure = await call("/api/config", { method: "POST", headers, body: original });
    assert.equal(failure.status, 500);
    assert.doesNotMatch(failure.text, new RegExp(dir));
    assert.equal(await readFile(join(dir, "config.json/keep"), "utf8"), "unchanged");
    assert.equal((await readdir(dir)).some((name) => name.endsWith(".tmp")), false);
    await rm(join(dir, "config.json"), { recursive: true });
    assert.equal((await call("/api/config", { method: "POST", headers, body: original })).status, 200);
    const results = await Promise.all([
      call("/api/config", { method: "POST", headers, body: '{"items":[{"id":"new"}]}' }),
      ...Array.from({ length: 8 }, () => call("/api/config"))
    ]);
    assert.equal(results[0].status, 200);
    for (const result of results.slice(1)) {
      assert.equal(result.status, 200);
      assert.ok([0, 1].includes(JSON.parse(result.text).items.length));
    }
  });

  await t.test("probe never contacts local fixture or follows redirects, even in bursts", async () => {
    let contacts = 0;
    fixture = createServer((_req, res) => { contacts++; res.writeHead(302, { location: "/private" }); res.end(); });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const target = `http://127.0.0.1:${fixture.address().port}/redirect`;
    for (let batch = 0; batch < 4; batch++) {
      const results = await Promise.all(Array.from({ length: 8 }, () => call(`/api/probe?url=${encodeURIComponent(target)}`)));
      for (const result of results) assert.equal(JSON.parse(result.text).status, "disabled");
    }
    assert.equal(contacts, 0);
    assert.equal(child.exitCode, null);
    assert.equal(stderr, "");
  });
});

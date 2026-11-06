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
  const listeners = new Map(), observedRequests = new Map();
  let probeSequence = 0;
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
    if (fixture) await new Promise((resolve) => fixture.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, "legacy"), { recursive: true });
  for (const name of ["server.mjs", "index.html"]) await copyFile(new URL(`legacy/${name}`, source), join(dir, "legacy", name));
  await mkdir(join(dir, "extension/src"), { recursive: true });
  await copyFile(new URL("extension/src/config-contract.js", source), join(dir, "extension/src/config-contract.js"));
  const original = '{"items":[],"app":{"title":"Fixture"}}\n';
  await writeFile(join(dir, "config.json"), original);
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, ".git/config"), "PRIVATE-FIXTURE");
  await writeFile(join(dir, ".env"), "PRIVATE-FIXTURE");
  await writeFile(join(dir, "outside.txt"), "PRIVATE-FIXTURE");
  await symlink(join(dir, "outside.txt"), join(dir, "linked.html"));
  child = spawn(process.execPath, ["--import", new URL("legacy/fixtures/listener-observer.mjs", source).href, join(dir, "legacy", "server.mjs")], { env: { ...process.env, PORT: "0", APP_ORIGIN: "http://untrusted.invalid" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.on("message", (message) => {
    if (message.type === "test:listening") listeners.set(message.address.port, message.address);
    if (message.type === "test:request") observedRequests.set(message.id, message);
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const base = await new Promise((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`server exited ${code}: ${stderr}`)));
    child.stdout.on("data", (chunk) => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]); });
  });
  const port = Number(new URL(base).port);
  function call(path, { method = "GET", headers = {}, body, hostname = "127.0.0.1", targetPort = port, timeout } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, result) => { clearTimeout(timer); error ? reject(error) : resolve(result); };
      const req = request({ hostname, port: targetPort, path, method, headers }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("error", finish);
        res.on("end", () => finish(null, { status: res.statusCode, headers: res.headers, text }));
      });
      req.on("error", finish);
      if (timeout) timer = setTimeout(() => req.destroy(Object.assign(new Error("probe timed out"), { code: "ETIMEDOUT" })), timeout);
      req.end(body);
    });
  }
  async function observation(map, key) {
    const deadline = Date.now() + 1000;
    while (!map.has(key) && Date.now() < deadline) await delay(10);
    assert.ok(map.has(key), "missing child socket observation");
    return map.get(key);
  }
  function assertLoopbackRequest(observed) {
    assert.equal(observed.localAddress, "127.0.0.1");
    assert.equal(observed.localPort, port);
    assert.match(observed.remoteAddress, /^(?:127\.|::ffff:127\.)|^::1$/);
  }
  const token = JSON.parse((await call("/api/session")).text).token;
  const headers = { "content-type": "application/json", "x-flowhub-token": token, origin: base };

  await t.test("legacy-only GET/POST and CLI reject desktop snapshots and malformed catalogs", async () => {
    const runCli = async (...args) => {
      const proc = spawn(process.execPath, [new URL("app/scripts/dev/flowhub-cli.mjs", source).pathname, ...args], { env: { ...process.env, FLOWHUB_URL: base }, stdio: "pipe" });
      let stdout = "", stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += chunk; });
      proc.stderr.on("data", (chunk) => { stderr += chunk; });
      return { code: (await once(proc, "exit"))[0], stdout, stderr };
    };
    for (const items of [[], [{ id: "desktop-page", url: "https://example.test" }]]) {
      const config = JSON.stringify({ plugins: { web: { settings: { items, catalogStorage: "sqlite" } } } });
      await writeFile(join(dir, "config.json"), config);
      const result = await call("/api/config");
      assert.equal(result.status, 400);
      assert.match(JSON.parse(result.text).reason, /SQLite.*水合/);
      const cli = await runCli("web", "list");
      assert.equal(cli.code, 1);
      assert.equal(cli.stdout, "");
      assert.match(cli.stderr, /SQLite/);
      assert.equal((await call("/api/config", { method: "POST", headers, body: config })).status, 400);
      assert.equal(await readFile(join(dir, "config.json"), "utf8"), config);
    }
    for (const invalid of ["{", "{}", "null", '{"items":[null]}', '{"items":{}}']) {
      await writeFile(join(dir, "config.json"), invalid);
      assert.equal((await call("/api/config")).status, 400);
    }
    for (const items of [[], [{ id: "legacy-page", url: "https://example.test" }]]) {
      await writeFile(join(dir, "config.json"), JSON.stringify({ items }));
      const cli = await runCli("web", "list");
      assert.equal(cli.code, 0, cli.stderr);
      assert.deepEqual(JSON.parse(cli.stdout), items);
    }
    assert.equal((await runCli("memo", "list")).code, 1);
    await writeFile(join(dir, "config.json"), original);
  });

  await t.test("server binds only IPv4 loopback, independently of local proxy routes", async () => {
    assert.deepEqual(await observation(listeners, port), { address: "127.0.0.1", family: "IPv4", port });
  });

  await t.test("non-loopback requests are unreachable or rejected after verified loopback forwarding", async (t) => {
    const localAddresses = Object.values(networkInterfaces()).flat().filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => entry.address);
    for (const host of ["::1", ...new Set(localAddresses)]) {
      const id = `probe-${++probeSequence}`;
      let result;
      try {
        result = await call("/api/config", { hostname: host, headers: { "x-flowhub-test-probe": id }, timeout: 1000 });
      } catch (error) {
        assert.ok(["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "ECONNRESET"].includes(error.code), `unexpected probe failure: ${error.code}`);
        continue;
      }
      // TUN/proxy stacks can relay an interface address to loopback. Do not
      // confuse their TCP handshake with a wildcard listener in this child.
      assertLoopbackRequest(await observation(observedRequests, id));
      assert.equal(result.status, 403);
      assert.deepEqual(JSON.parse(result.text), { ok: false, reason: "Host 不受信任" });
      t.diagnostic(`${host}: forwarded to verified loopback socket; untrusted Host rejected`);
    }
  });

  await t.test("a controlled local relay preserves Host, Origin and token checks", async () => {
    const relay = createServer((req, res) => {
      const upstream = request({ hostname: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers }, (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      upstream.on("error", (error) => res.destroy(error));
      req.pipe(upstream);
    });
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const targetPort = relay.address().port;
    try {
      const cases = [
        { headers: {}, status: 403, reason: "Host 不受信任" },
        { headers: { host: `127.0.0.1:${port}` }, status: 200 },
        { headers: { host: `127.0.0.1:${port}`, origin: "https://untrusted.invalid" }, status: 403, reason: "Origin 不受信任" },
        { method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" }, body: '{"items":[]}', status: 403, reason: "缺少有效写入令牌" },
      ];
      const before = await readFile(join(dir, "config.json"), "utf8");
      for (const entry of cases) {
        const id = `probe-${++probeSequence}`;
        const result = await call("/api/config", { ...entry, targetPort, headers: { ...entry.headers, "x-flowhub-test-probe": id }, timeout: 2000 });
        assertLoopbackRequest(await observation(observedRequests, id));
        assert.equal(result.status, entry.status);
        if (entry.reason) assert.deepEqual(JSON.parse(result.text), { ok: false, reason: entry.reason });
        else assert.deepEqual(JSON.parse(result.text), JSON.parse(before));
      }
      assert.equal(await readFile(join(dir, "config.json"), "utf8"), before);
    } finally {
      relay.closeAllConnections();
      await new Promise((resolve) => relay.close(resolve));
    }
  });

  await t.test("sockets and incomplete headers are bounded", async () => {
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
    const cli = spawn(process.execPath, [new URL("app/scripts/dev/flowhub-cli.mjs", source).pathname, "config", "set", "app.title", '"CLI Fixture"'], { env: { ...process.env, FLOWHUB_URL: base }, stdio: "pipe" });
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
    await unlink(join(dir, "legacy", "index.html"));
    await symlink(join(dir, "outside.txt"), join(dir, "legacy", "index.html"));
    assert.equal((await call("/")).status, 500);
    await unlink(join(dir, "legacy", "index.html"));
    await copyFile(new URL("legacy/index.html", source), join(dir, "legacy", "index.html"));
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

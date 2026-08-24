const manifests = require("../ui/plugins.json");

class PluginRegistry {
  constructor(entries = manifests) {
    this.manifests = entries
      .map((entry) => Object.freeze({ ...entry }))
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    this.runtimes = new Map();
  }

  register(id, runtime) {
    const manifest = this.manifests.find((entry) => entry.id === id);
    if (!manifest) throw new Error(`未知插件：${id}`);
    if (!manifest.enabled) throw new Error(`插件尚未启用：${id}`);
    this.runtimes.set(id, runtime || {});
    return this;
  }

  list() {
    return this.manifests.map((manifest) => ({
      ...manifest,
      available: manifest.enabled && this.runtimes.has(manifest.id)
    }));
  }

  runtime(id) {
    const manifest = this.manifests.find((entry) => entry.id === id);
    if (!manifest?.enabled) throw new Error(`插件不可用：${id}`);
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`插件未注册：${id}`);
    return runtime;
  }

  async search(id, request = {}) {
    const runtime = this.runtime(id);
    if (typeof runtime.search !== "function") return [];
    const records = await runtime.search(request);
    return (records || []).map((record) => ({ ...record, pluginId: id }));
  }

  async action(id, action, payload = {}, context = {}) {
    const runtime = this.runtime(id);
    const handler = runtime.actions?.[action];
    if (typeof handler !== "function") return { ok: false, reason: `插件 ${id} 不支持操作 ${action}` };
    return handler(payload, context);
  }

  async startAll(context = {}) {
    const failures = [];
    for (const manifest of this.manifests) {
      const runtime = this.runtimes.get(manifest.id);
      if (!manifest.enabled || typeof runtime?.start !== "function") continue;
      try {
        await runtime.start(context);
      } catch (error) {
        failures.push({ id: manifest.id, reason: error.message });
      }
    }
    return failures;
  }

  configureAll(config) {
    for (const manifest of this.manifests) {
      const runtime = this.runtimes.get(manifest.id);
      if (manifest.enabled && typeof runtime?.configure === "function") runtime.configure(config);
    }
  }

  stopAll() {
    for (const manifest of [...this.manifests].reverse()) {
      const runtime = this.runtimes.get(manifest.id);
      if (!manifest.enabled || typeof runtime?.stop !== "function") continue;
      try { runtime.stop(); } catch {}
    }
  }
}

module.exports = { PluginRegistry, pluginManifests: manifests };

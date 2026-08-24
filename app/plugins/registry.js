const manifests = require("../ui/plugins.json");

class PluginRegistry {
  constructor(entries = manifests) {
    this.manifests = entries.map((entry) => Object.freeze({ ...entry })).sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    this.runtimes = new Map();
    this.started = new Set();
    this.config = { core: {}, plugins: {} };
    this.context = {};
  }

  register(id, runtime) {
    if (!this.manifests.some((entry) => entry.id === id)) throw new Error(`未知插件：${id}`);
    this.runtimes.set(id, runtime || {});
    return this;
  }

  enabled(id) {
    const manifest = this.manifests.find((entry) => entry.id === id);
    if (!manifest) return false;
    return this.config.plugins?.[id]?.enabled ?? manifest.defaultEnabled !== false;
  }

  list() {
    return this.manifests.map((manifest) => ({ ...manifest, available: this.runtimes.has(manifest.id), enabled: this.enabled(manifest.id) }));
  }

  runtime(id) {
    const manifest = this.manifests.find((entry) => entry.id === id);
    if (!manifest) throw new Error(`未知插件：${id}`);
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`插件未安装：${id}`);
    if (!this.enabled(id)) throw new Error(`插件未启用：${id}`);
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

  async applyConfig(config, context = this.context) {
    this.config = config || { core: {}, plugins: {} };
    this.context = context || {};
    const failures = [];
    for (const manifest of this.manifests) {
      const runtime = this.runtimes.get(manifest.id);
      if (!runtime) continue;
      const shouldRun = this.enabled(manifest.id);
      try {
        if (shouldRun && !this.started.has(manifest.id)) {
          if (typeof runtime.start === "function") await runtime.start(this.context);
          this.started.add(manifest.id);
        } else if (!shouldRun && this.started.has(manifest.id)) {
          if (typeof runtime.stop === "function") runtime.stop();
          this.started.delete(manifest.id);
        }
        if (shouldRun && typeof runtime.configure === "function") runtime.configure(this.config);
      } catch (error) {
        failures.push({ id: manifest.id, reason: error.message });
      }
    }
    return failures;
  }

  stopAll() {
    for (const manifest of [...this.manifests].reverse()) {
      const runtime = this.runtimes.get(manifest.id);
      if (!this.started.has(manifest.id) || typeof runtime?.stop !== "function") continue;
      try { runtime.stop(); } catch {}
      this.started.delete(manifest.id);
    }
  }
}

module.exports = { PluginRegistry, pluginManifests: manifests };

const { categorySegments, cloneDefaults, rankMemos } = require("../ui/memo-catalog");

function normalizeMemo(item, index = 0) {
  const tags = Array.isArray(item?.tags)
    ? item.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
    : String(item?.tags || "").split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean);
  return {
    id: String(item?.id || `memo-${Date.now().toString(36)}-${index}`).trim(),
    title: String(item?.title || "未命名备忘").trim(),
    category: categorySegments(item?.category).join(" / "),
    description: String(item?.description || "").trim(),
    tags,
    content: String(item?.content || "")
  };
}

function createMemoRuntime({ activate }) {
  let configuredItems = [];
  let usesDefaults = true;

  return {
    configure(config) {
      const items = config.plugins?.memo?.settings?.items;
      usesDefaults = !Array.isArray(items);
      configuredItems = (usesDefaults ? cloneDefaults() : items).map(normalizeMemo);
    },
    search({ query = "", limit = 12, offset = 0 } = {}) {
      return rankMemos(configuredItems, query, limit, offset);
    },
    actions: {
      activate: ({ content }) => activate(String(content || "")),
      defaults: () => ({ ok: true, items: cloneDefaults(), usesDefaults })
    }
  };
}

module.exports = { createMemoRuntime, normalizeMemo };

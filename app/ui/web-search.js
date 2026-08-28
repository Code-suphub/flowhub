(function exposeWebSearch(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FlowHubWebSearch = api;
}(typeof globalThis === "object" ? globalThis : this, () => {
  function normalize(value) {
    return String(value || "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
  }

  function tokensFor(query) {
    const eastAsian = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
    const withScriptBoundaries = normalize(query)
      .replace(new RegExp(`([a-z0-9])([${eastAsian}])`, "giu"), "$1 $2")
      .replace(new RegExp(`([${eastAsian}])([a-z0-9])`, "giu"), "$1 $2");
    return [...new Set(withScriptBoundaries.split(/[\s\-_/.,:：·|]+/u).filter(Boolean))];
  }

  function directoryText(page) {
    if (Array.isArray(page?.path)) {
      return normalize(page.path.slice(0, -1).map((entry) => entry?.title || "").join(" "));
    }
    const breadcrumb = String(page?.breadcrumb || "");
    const parts = breadcrumb.split("/").map((part) => part.trim()).filter(Boolean);
    if (normalize(parts.at(-1)) === normalize(page?.title)) parts.pop();
    return normalize(parts.join(" "));
  }

  function rankPage(page, query, index) {
    const normalizedQuery = normalize(query);
    const tokens = tokensFor(normalizedQuery);
    if (!tokens.length) return { page, index, tier: 0, detail: 0 };

    const fields = {
      title: normalize(page?.title),
      context: normalize(`${directoryText(page)} ${page?.note || ""}`),
      url: normalize(page?.url)
    };
    const tokenFields = tokens.map((token) => {
      if (fields.title.includes(token)) return "title";
      if (fields.context.includes(token)) return "context";
      if (fields.url.includes(token)) return "url";
      return "";
    });
    if (tokenFields.some((field) => !field)) return null;

    if (fields.title === normalizedQuery) return { page, index, tier: 0, detail: 0 };
    if (fields.title.startsWith(normalizedQuery)) return { page, index, tier: 1, detail: fields.title.length - normalizedQuery.length };
    if (tokenFields.every((field) => field === "title")) {
      return { page, index, tier: 2, detail: tokens.reduce((score, token) => score + fields.title.indexOf(token), 0) };
    }
    if (!tokenFields.includes("url")) {
      const contextTokens = tokenFields.filter((field) => field === "context").length;
      return { page, index, tier: 3, detail: contextTokens };
    }
    const urlTokens = tokenFields.filter((field) => field === "url").length;
    return { page, index, tier: 4, detail: urlTokens };
  }

  function rankWebPages(pages, query, limit = 12, offset = 0) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 12));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) return (pages || []).slice(safeOffset, safeOffset + safeLimit);
    return (pages || [])
      .map((page, index) => rankPage(page, normalizedQuery, index))
      .filter(Boolean)
      .sort((left, right) => left.tier - right.tier || left.detail - right.detail || left.index - right.index)
      .slice(safeOffset, safeOffset + safeLimit)
      .map((entry) => entry.page);
  }

  return { normalize, tokensFor, rankWebPages };
}));

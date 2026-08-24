const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const initSqlJs = require("sql.js");

let SQL = null;
let db = null;
let dataDir = "";
let imageDir = "";
let dbPath = "";
const searchCache = new Map();
const imageBufferCache = new Map();
let imageBufferCacheBytes = 0;
let persistTimer = null;
let persistPending = false;

const USAGE_FREQUENT_MIN_COUNT = 3;
const USAGE_HALF_LIFE_DAYS = 30;
const IMAGE_BUFFER_CACHE_MAX_ENTRIES = 4;
const IMAGE_BUFFER_CACHE_MAX_BYTES = 32 * 1024 * 1024;

function rows(sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const result = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}

function first(sql, params = []) {
  return rows(sql, params)[0] || null;
}

function persistNow() {
  if (!db) return;
  const tempPath = `${dbPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, Buffer.from(db.export()));
  fs.renameSync(tempPath, dbPath);
}

function persist() {
  if (!db) return;
  persistPending = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!persistPending) return;
    persistPending = false;
    persistNow();
  }, 250);
}

function flushPersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  if (persistPending) {
    persistPending = false;
    persistNow();
  }
}

function imagePath(fileName) {
  return path.join(imageDir, fileName);
}

function removeCachedImage(fileName) {
  const buffer = imageBufferCache.get(fileName);
  if (!buffer) return;
  imageBufferCache.delete(fileName);
  imageBufferCacheBytes -= buffer.length;
}

function cacheImageBuffer(fileName, buffer) {
  if (!fileName || !Buffer.isBuffer(buffer) || !buffer.length || buffer.length > IMAGE_BUFFER_CACHE_MAX_BYTES) return;
  removeCachedImage(fileName);
  imageBufferCache.set(fileName, buffer);
  imageBufferCacheBytes += buffer.length;
  while (imageBufferCache.size > IMAGE_BUFFER_CACHE_MAX_ENTRIES || imageBufferCacheBytes > IMAGE_BUFFER_CACHE_MAX_BYTES) {
    const oldestFileName = imageBufferCache.keys().next().value;
    if (!oldestFileName) break;
    removeCachedImage(oldestFileName);
  }
}

function cachedImageBuffer(fileName) {
  const buffer = imageBufferCache.get(fileName);
  if (!buffer) return null;
  // Map 的插入顺序作为 LRU 顺序，命中后移动到末尾。
  imageBufferCache.delete(fileName);
  imageBufferCache.set(fileName, buffer);
  return buffer;
}

const IMAGE_FILE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|svg|ico)$/i;

function classifyFilePath(filePath) {
  try {
    if (fs.statSync(filePath).isDirectory()) return "folder";
  } catch {}
  return IMAGE_FILE_EXTENSIONS.test(path.basename(filePath)) ? "image" : "file";
}

function toPublicRecord(row) {
  if (!row) return null;
  let filePaths = [];
  let fileTypes = [];
  if (row.kind === "file" && row.file_paths) {
    try { filePaths = JSON.parse(row.file_paths); } catch {}
  }
  if (row.kind === "file" && row.file_types) {
    try { fileTypes = JSON.parse(row.file_types); } catch {}
  }
  if (row.kind === "file") {
    fileTypes = filePaths.map((filePath, index) => fileTypes[index] || classifyFilePath(filePath));
  }
  const distinctFileTypes = [...new Set(fileTypes)];
  return {
    id: Number(row.id),
    kind: row.kind,
    hash: row.hash,
    content: row.content || "",
    sourceName: row.source_name || "",
    filePaths,
    fileNames: filePaths.map((filePath) => path.basename(filePath)),
    fileCount: filePaths.length,
    fileTypes,
    fileType: distinctFileTypes.length === 1 ? distinctFileTypes[0] : "file",
    imageUrl: row.file_name ? pathToFileURL(imagePath(row.file_name)).href : "",
    size: Number(row.size || 0),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    copyCount: Number(row.copy_count || 1)
  };
}

function toPublicUsageRecord(row, now = Date.now()) {
  if (!row) return null;
  const targetType = row.target_type === "page" ? "page" : "app";
  const lastUsedAt = row.last_used_at || row.first_used_at;
  const ageDays = Math.max(0, (now - Date.parse(lastUsedAt)) / (24 * 60 * 60 * 1000));
  const useCount = Number(row.use_count || 0);
  return {
    usageType: targetType,
    usageKey: row.target_key,
    title: row.title || row.target_key,
    path: row.target_path || "",
    url: row.url || "",
    icon: row.icon || "",
    useCount,
    firstUsedAt: row.first_used_at,
    lastUsedAt,
    score: useCount * Math.pow(0.5, ageDays / USAGE_HALF_LIFE_DAYS)
  };
}

async function open(baseDir) {
  dataDir = path.join(baseDir, "clipboard");
  imageDir = path.join(dataDir, "images");
  dbPath = path.join(dataDir, "weborg.db");
  fs.mkdirSync(imageDir, { recursive: true });

  SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve("sql.js")), file)
  });

  const existing = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
  db = existing ? new SQL.Database(existing) : new SQL.Database();
  db.run(`
    CREATE TABLE IF NOT EXISTS clipboard_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      hash TEXT NOT NULL,
      content TEXT,
      file_name TEXT,
      source_name TEXT,
      file_paths TEXT,
      file_types TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      copy_count INTEGER NOT NULL DEFAULT 1,
      UNIQUE(kind, hash)
    );
    CREATE INDEX IF NOT EXISTS clipboard_records_recent
      ON clipboard_records(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS clipboard_records_hash
      ON clipboard_records(hash);
    CREATE TABLE IF NOT EXISTS usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_key TEXT NOT NULL,
      title TEXT NOT NULL,
      target_path TEXT,
      url TEXT,
      icon TEXT,
      use_count INTEGER NOT NULL DEFAULT 1,
      first_used_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      UNIQUE(target_type, target_key)
    );
    CREATE INDEX IF NOT EXISTS usage_records_recent
      ON usage_records(target_type, last_used_at DESC);
    CREATE INDEX IF NOT EXISTS usage_records_score
      ON usage_records(target_type, use_count DESC, last_used_at DESC);
  `);
  const columns = rows("PRAGMA table_info(clipboard_records)");
  if (!columns.some((column) => column.name === "file_paths")) {
    db.run("ALTER TABLE clipboard_records ADD COLUMN file_paths TEXT");
  }
  if (!columns.some((column) => column.name === "source_name")) {
    db.run("ALTER TABLE clipboard_records ADD COLUMN source_name TEXT");
  }
  if (!columns.some((column) => column.name === "file_types")) {
    db.run("ALTER TABLE clipboard_records ADD COLUMN file_types TEXT");
  }
  persistNow();
}

function isReady() {
  return Boolean(db);
}

function invalidateSearchCache() {
  searchCache.clear();
}

function touchExisting(row, now, shouldPersist = true) {
  db.run(
    "UPDATE clipboard_records SET last_seen_at = ?, copy_count = copy_count + 1 WHERE id = ?",
    [now, row.id]
  );
  invalidateSearchCache();
  if (shouldPersist) persist();
  return toPublicRecord(first("SELECT * FROM clipboard_records WHERE id = ?", [row.id]));
}

function addText(text, hash, shouldPersist = true) {
  if (!db || !String(text || "")) return null;
  const now = new Date().toISOString();
  const existing = first("SELECT * FROM clipboard_records WHERE kind = 'text' AND hash = ?", [hash]);
  if (existing) return touchExisting(existing, now, shouldPersist);
  db.run(
    `INSERT INTO clipboard_records(kind, hash, content, size, created_at, last_seen_at)
     VALUES ('text', ?, ?, ?, ?, ?)`,
    [hash, text, Buffer.byteLength(text, "utf8"), now, now]
  );
  invalidateSearchCache();
  if (shouldPersist) persist();
  return toPublicRecord(first("SELECT * FROM clipboard_records WHERE kind = 'text' AND hash = ?", [hash]));
}

function addImage(buffer, hash, sourceName = "", shouldPersist = true) {
  if (!db || !buffer?.length) return null;
  const now = new Date().toISOString();
  const existing = first("SELECT * FROM clipboard_records WHERE kind = 'image' AND hash = ?", [hash]);
  if (existing) {
    if (existing.file_name) cacheImageBuffer(existing.file_name, buffer);
    if (sourceName && existing.source_name !== sourceName) {
      db.run("UPDATE clipboard_records SET source_name = ? WHERE id = ?", [sourceName, existing.id]);
      invalidateSearchCache();
    }
    return touchExisting(existing, now, shouldPersist);
  }

  const fileName = `${hash}.png`;
  fs.writeFileSync(imagePath(fileName), buffer);
  cacheImageBuffer(fileName, buffer);
  db.run(
    `INSERT INTO clipboard_records(kind, hash, file_name, source_name, size, created_at, last_seen_at)
     VALUES ('image', ?, ?, ?, ?, ?, ?)`,
    [hash, fileName, sourceName, buffer.length, now, now]
  );
  invalidateSearchCache();
  if (shouldPersist) persist();
  return toPublicRecord(first("SELECT * FROM clipboard_records WHERE kind = 'image' AND hash = ?", [hash]));
}

function repairPlaceholderFile(placeholderPaths, normalizedPaths, hash, now, shouldPersist) {
  if (!Array.isArray(placeholderPaths) || !placeholderPaths.length) return null;
  const placeholders = new Set(placeholderPaths);
  const candidate = rows("SELECT * FROM clipboard_records WHERE kind = 'file'")
    .find((row) => {
      if (!row.file_paths) return false;
      try {
        const paths = JSON.parse(row.file_paths);
        return Array.isArray(paths) && paths.some((filePath) => placeholders.has(filePath));
      } catch {
        return false;
      }
    });
  if (!candidate) return null;

  const existing = first("SELECT * FROM clipboard_records WHERE kind = 'file' AND hash = ?", [hash]);
  if (existing && existing.id !== candidate.id) {
    db.run("DELETE FROM clipboard_records WHERE id = ?", [candidate.id]);
    invalidateSearchCache();
    return touchExisting(existing, now, shouldPersist);
  }

  const fileNames = normalizedPaths.map((filePath) => path.basename(filePath)).join(", ");
  const fileTypes = normalizedPaths.map(classifyFilePath);
  db.run(
    `UPDATE clipboard_records
     SET hash = ?, content = ?, file_paths = ?, file_types = ?, last_seen_at = ?, copy_count = copy_count + 1
     WHERE id = ?`,
    [hash, fileNames, JSON.stringify(normalizedPaths), JSON.stringify(fileTypes), now, candidate.id]
  );
  invalidateSearchCache();
  if (shouldPersist) persist();
  return toPublicRecord(first("SELECT * FROM clipboard_records WHERE id = ?", [candidate.id]));
}

function addFiles(filePaths, hash, shouldPersist = true, legacyPaths = []) {
  if (!db || !Array.isArray(filePaths) || !filePaths.length) return null;
  const normalizedPaths = [...new Set(filePaths.map((filePath) => String(filePath || "").trim()).filter(Boolean))];
  if (!normalizedPaths.length) return null;
  const now = new Date().toISOString();
  const repaired = repairPlaceholderFile(legacyPaths, normalizedPaths, hash, now, shouldPersist);
  if (repaired) return repaired;
  const existing = first("SELECT * FROM clipboard_records WHERE kind = 'file' AND hash = ?", [hash]);
  if (existing) return touchExisting(existing, now, shouldPersist);
  const fileNames = normalizedPaths.map((filePath) => path.basename(filePath)).join(", ");
  const fileTypes = normalizedPaths.map(classifyFilePath);
  db.run(
    `INSERT INTO clipboard_records(kind, hash, content, file_paths, file_types, size, created_at, last_seen_at)
     VALUES ('file', ?, ?, ?, ?, 0, ?, ?)`,
    [hash, fileNames, JSON.stringify(normalizedPaths), JSON.stringify(fileTypes), now, now]
  );
  invalidateSearchCache();
  if (shouldPersist) persist();
  return toPublicRecord(first("SELECT * FROM clipboard_records WHERE kind = 'file' AND hash = ?", [hash]));
}

function addBatch(payloads = []) {
  if (!db || !payloads.length) return [];
  db.run("BEGIN");
  try {
    const records = payloads.map((payload) => {
      if (payload.kind === "image") return addImage(payload.value, payload.hash, payload.sourceName || "", false);
      if (payload.kind === "file") return addFiles(payload.value, payload.hash, false, payload.legacyPaths || []);
      return addText(payload.value, payload.hash, false);
    });
    db.run("COMMIT");
    persist();
    return records;
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

function search(query = "", limit = 12, kind = "all") {
  if (!db) return [];
  const keyword = String(query || "").trim();
  const normalizedKeyword = keyword.toLowerCase();
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 12));
  const safeKind = ["text", "image", "file"].includes(kind) ? kind : "all";
  const cacheKey = `${normalizedKeyword}\u0000${safeLimit}\u0000${safeKind}`;
  if (searchCache.has(cacheKey)) return searchCache.get(cacheKey);
  const candidateLimit = safeKind === "all" ? safeLimit : 250;
  const conditions = [];
  const parameters = [];
  if (keyword) {
    const like = `%${keyword}%`;
    const imageKeyword = ["图片", "图像", "image"].includes(normalizedKeyword) ? keyword : "";
    conditions.push("(content LIKE ? OR source_name LIKE ? OR hash LIKE ? OR (kind = 'image' AND ? <> ''))");
    parameters.push(like, like, like, imageKeyword);
  }
  if (safeKind === "text") conditions.push("kind = 'text'");
  if (safeKind === "image") conditions.push("kind IN ('image', 'file')");
  if (safeKind === "file") conditions.push("kind = 'file'");
  parameters.push(candidateLimit);
  const result = rows(
    `SELECT * FROM clipboard_records
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY last_seen_at DESC LIMIT ?`,
    parameters
  );
  const publicRecords = result.map(toPublicRecord).filter((record) => {
    if (safeKind === "text") return record.kind === "text";
    if (safeKind === "image") return record.kind === "image" || (record.kind === "file" && record.fileType === "image");
    if (safeKind === "file") return record.kind === "file" && record.fileType !== "image";
    return true;
  }).slice(0, safeLimit);
  searchCache.set(cacheKey, publicRecords);
  if (searchCache.size > 32) searchCache.delete(searchCache.keys().next().value);
  return publicRecords;
}

function recordUsage(target = {}) {
  if (!db || !target || !["app", "page"].includes(target.type)) return null;
  const targetType = target.type;
  const targetKey = String(target.key || (targetType === "app" ? target.path : target.id || target.url) || "").trim();
  if (!targetKey) return null;
  const now = new Date().toISOString();
  const title = String(target.title || targetKey).trim() || targetKey;
  const targetPath = String(target.path || "").trim();
  const url = String(target.url || "").trim();
  const icon = String(target.icon || "").trim();
  const existing = first(
    "SELECT * FROM usage_records WHERE target_type = ? AND target_key = ?",
    [targetType, targetKey]
  );
  if (existing) {
    db.run(
      `UPDATE usage_records
       SET title = ?, target_path = ?, url = ?, icon = ?, last_used_at = ?, use_count = use_count + 1
       WHERE id = ?`,
      [title, targetPath, url, icon, now, existing.id]
    );
  } else {
    db.run(
      `INSERT INTO usage_records(target_type, target_key, title, target_path, url, icon, use_count, first_used_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [targetType, targetKey, title, targetPath, url, icon, now, now]
    );
  }
  persist();
  return toPublicUsageRecord(first(
    "SELECT * FROM usage_records WHERE target_type = ? AND target_key = ?",
    [targetType, targetKey]
  ));
}

function usageSections(scope = "all", limit = 6) {
  if (!db) return { frequent: [], recent: [] };
  const safeLimit = Math.max(1, Math.min(12, Number(limit) || 6));
  const targetType = scope === "app" ? "app" : scope === "web" ? "page" : "";
  const storedRows = targetType
    ? rows("SELECT * FROM usage_records WHERE target_type = ?", [targetType])
    : rows("SELECT * FROM usage_records");
  const now = Date.now();
  const entries = storedRows.map((row) => ({ row, value: toPublicUsageRecord(row, now) }));
  const frequent = entries
    .filter(({ value }) => value.useCount >= USAGE_FREQUENT_MIN_COUNT)
    .sort((a, b) => b.value.score - a.value.score || Date.parse(b.value.lastUsedAt) - Date.parse(a.value.lastUsedAt))
    .slice(0, safeLimit);
  const frequentKeys = new Set(frequent.map(({ value }) => `${value.usageType}:${value.usageKey}`));
  const recent = entries
    .filter(({ value }) => !frequentKeys.has(`${value.usageType}:${value.usageKey}`))
    .sort((a, b) => Date.parse(b.value.lastUsedAt) - Date.parse(a.value.lastUsedAt))
    .slice(0, safeLimit);
  return {
    frequent: frequent.map(({ value }) => value),
    recent: recent.map(({ value }) => value)
  };
}

function get(id) {
  return db ? toPublicRecord(first("SELECT * FROM clipboard_records WHERE id = ?", [id])) : null;
}

function getImageBuffer(id) {
  if (!db) return null;
  const row = first("SELECT file_name FROM clipboard_records WHERE id = ? AND kind = 'image'", [id]);
  if (!row?.file_name) return null;
  const cached = cachedImageBuffer(row.file_name);
  if (cached) return cached;
  try {
    const buffer = fs.readFileSync(imagePath(row.file_name));
    cacheImageBuffer(row.file_name, buffer);
    return buffer;
  } catch {
    return null;
  }
}

function getFilePaths(id) {
  if (!db) return [];
  const row = first("SELECT file_paths FROM clipboard_records WHERE id = ? AND kind = 'file'", [id]);
  if (!row?.file_paths) return [];
  try {
    const paths = JSON.parse(row.file_paths);
    return Array.isArray(paths) ? paths.filter((filePath) => typeof filePath === "string" && filePath) : [];
  } catch {
    return [];
  }
}

function remove(id) {
  if (!db) return false;
  const row = first("SELECT id, file_name FROM clipboard_records WHERE id = ?", [id]);
  if (!row) return false;
  if (row.file_name) {
    removeCachedImage(row.file_name);
    try { fs.unlinkSync(imagePath(row.file_name)); } catch {}
  }
  db.run("DELETE FROM clipboard_records WHERE id = ?", [id]);
  invalidateSearchCache();
  persist();
  return true;
}

function cleanup(retentionDays) {
  if (!db) return 0;
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const expired = rows("SELECT id, file_name FROM clipboard_records WHERE last_seen_at < ?", [cutoff]);
  if (!expired.length) return 0;
  for (const row of expired) {
    if (row.file_name) {
      removeCachedImage(row.file_name);
      try { fs.unlinkSync(imagePath(row.file_name)); } catch {}
    }
  }
  db.run("DELETE FROM clipboard_records WHERE last_seen_at < ?", [cutoff]);
  invalidateSearchCache();
  persist();
  return expired.length;
}

function close() {
  flushPersist();
  if (db) {
    persistNow();
    db.close();
  }
  db = null;
  invalidateSearchCache();
  imageBufferCache.clear();
  imageBufferCacheBytes = 0;
}

module.exports = {
  addBatch,
  addImage,
  addText,
  cleanup,
  close,
  get,
  getFilePaths,
  getImageBuffer,
  isReady,
  open,
  recordUsage,
  remove,
  search,
  usageSections
};

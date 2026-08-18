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
let persistTimer = null;
let persistPending = false;

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

function toPublicRecord(row) {
  if (!row) return null;
  let filePaths = [];
  if (row.kind === "file" && row.file_paths) {
    try { filePaths = JSON.parse(row.file_paths); } catch {}
  }
  return {
    id: Number(row.id),
    kind: row.kind,
    hash: row.hash,
    content: row.content || "",
    filePaths,
    fileNames: filePaths.map((filePath) => path.basename(filePath)),
    fileCount: filePaths.length,
    imageUrl: row.file_name ? pathToFileURL(imagePath(row.file_name)).href : "",
    size: Number(row.size || 0),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    copyCount: Number(row.copy_count || 1)
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
      file_paths TEXT,
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
  `);
  const columns = rows("PRAGMA table_info(clipboard_records)");
  if (!columns.some((column) => column.name === "file_paths")) {
    db.run("ALTER TABLE clipboard_records ADD COLUMN file_paths TEXT");
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

function addImage(buffer, hash, shouldPersist = true) {
  if (!db || !buffer?.length) return null;
  const now = new Date().toISOString();
  const existing = first("SELECT * FROM clipboard_records WHERE kind = 'image' AND hash = ?", [hash]);
  if (existing) return touchExisting(existing, now, shouldPersist);

  const fileName = `${hash}.png`;
  fs.writeFileSync(imagePath(fileName), buffer);
  db.run(
    `INSERT INTO clipboard_records(kind, hash, file_name, size, created_at, last_seen_at)
     VALUES ('image', ?, ?, ?, ?, ?)`,
    [hash, fileName, buffer.length, now, now]
  );
  invalidateSearchCache();
  if (shouldPersist) persist();
  return toPublicRecord(first("SELECT * FROM clipboard_records WHERE kind = 'image' AND hash = ?", [hash]));
}

function addFiles(filePaths, hash, shouldPersist = true) {
  if (!db || !Array.isArray(filePaths) || !filePaths.length) return null;
  const normalizedPaths = [...new Set(filePaths.map((filePath) => String(filePath || "").trim()).filter(Boolean))];
  if (!normalizedPaths.length) return null;
  const now = new Date().toISOString();
  const existing = first("SELECT * FROM clipboard_records WHERE kind = 'file' AND hash = ?", [hash]);
  if (existing) return touchExisting(existing, now, shouldPersist);
  const fileNames = normalizedPaths.map((filePath) => path.basename(filePath)).join(", ");
  db.run(
    `INSERT INTO clipboard_records(kind, hash, content, file_paths, size, created_at, last_seen_at)
     VALUES ('file', ?, ?, ?, 0, ?, ?)`,
    [hash, fileNames, JSON.stringify(normalizedPaths), now, now]
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
      if (payload.kind === "image") return addImage(payload.value, payload.hash, false);
      if (payload.kind === "file") return addFiles(payload.value, payload.hash, false);
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

function search(query = "", limit = 12) {
  if (!db) return [];
  const keyword = String(query || "").trim();
  const normalizedKeyword = keyword.toLowerCase();
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 12));
  const cacheKey = `${normalizedKeyword}\u0000${safeLimit}`;
  if (searchCache.has(cacheKey)) return searchCache.get(cacheKey);
  let result;
  if (!keyword) {
    result = rows("SELECT * FROM clipboard_records ORDER BY last_seen_at DESC LIMIT ?", [safeLimit]);
  } else {
    const like = `%${keyword}%`;
    const imageKeyword = ["图片", "图像", "image"].includes(normalizedKeyword) ? keyword : "";
    result = rows(
      `SELECT * FROM clipboard_records
       WHERE content LIKE ? OR hash LIKE ? OR (kind = 'image' AND ? <> '')
       ORDER BY last_seen_at DESC LIMIT ?`,
      [like, like, imageKeyword, safeLimit]
    );
  }
  const publicRecords = result.map(toPublicRecord);
  searchCache.set(cacheKey, publicRecords);
  if (searchCache.size > 32) searchCache.delete(searchCache.keys().next().value);
  return publicRecords;
}

function get(id) {
  return db ? toPublicRecord(first("SELECT * FROM clipboard_records WHERE id = ?", [id])) : null;
}

function getImageBuffer(id) {
  if (!db) return null;
  const row = first("SELECT file_name FROM clipboard_records WHERE id = ? AND kind = 'image'", [id]);
  if (!row?.file_name) return null;
  try { return fs.readFileSync(imagePath(row.file_name)); } catch { return null; }
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

function cleanup(retentionDays) {
  if (!db) return 0;
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const expired = rows("SELECT id, file_name FROM clipboard_records WHERE last_seen_at < ?", [cutoff]);
  if (!expired.length) return 0;
  for (const row of expired) {
    if (row.file_name) {
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
  search
};

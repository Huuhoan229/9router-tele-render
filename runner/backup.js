const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const crypto = require("crypto");

const GIST_DESCRIPTION = "9router-render-backup (DO NOT DELETE)";
const GIST_FILENAME = "9router-state.gz.b64";

let cachedGistId = process.env.BACKUP_GIST_ID || null;
let lastUploadedHash = null;

function getGitHubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "9router-tele-render-sync",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function findOrCreateBackupGist(token) {
  if (cachedGistId) return cachedGistId;

  // Search existing gists (up to 100) for matching description or filename
  const res = await fetch("https://api.github.com/gists?per_page=100", {
    headers: getGitHubHeaders(token),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API list gists failed (${res.status}): ${body}`);
  }

  const gists = await res.json();
  const existing = gists.find(
    (g) => g.description === GIST_DESCRIPTION || (g.files && g.files[GIST_FILENAME])
  );

  if (existing) {
    cachedGistId = existing.id;
    return cachedGistId;
  }

  return null;
}

/**
 * Safely export a compact copy of data.sqlite without requestDetails/usageHistory bloat.
 */
function exportCleanSqliteBuffer(srcDbPath) {
  const tmpDbPath = path.join(os.tmpdir(), `9r-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const escapedTmp = tmpDbPath.replace(/\\/g, "/").replace(/'/g, "''");

  try {
    // Prefer Node 22+ built-in node:sqlite
    let usedNodeSqlite = false;
    try {
      const { DatabaseSync } = require("node:sqlite");
      const srcDb = new DatabaseSync(srcDbPath, { open: true, readOnly: true });
      srcDb.exec(`VACUUM INTO '${escapedTmp}'`);
      srcDb.close();

      const cleanDb = new DatabaseSync(tmpDbPath);
      try { cleanDb.exec("DELETE FROM requestDetails;"); } catch {}
      try { cleanDb.exec("DELETE FROM usageHistory;"); } catch {}
      cleanDb.exec("VACUUM;");
      cleanDb.close();
      usedNodeSqlite = true;
    } catch {
      // Fallback to better-sqlite3 bundled in /app/node_modules
      const BetterSqlite = require(path.resolve("/app/node_modules/better-sqlite3"));
      const srcDb = new BetterSqlite(srcDbPath, { readonly: true });
      srcDb.exec(`VACUUM INTO '${escapedTmp}'`);
      srcDb.close();

      const cleanDb = new BetterSqlite(tmpDbPath);
      try { cleanDb.exec("DELETE FROM requestDetails;"); } catch {}
      try { cleanDb.exec("DELETE FROM usageHistory;"); } catch {}
      cleanDb.exec("VACUUM;");
      cleanDb.close();
      usedNodeSqlite = true;
    }

    if (usedNodeSqlite && fs.existsSync(tmpDbPath)) {
      return fs.readFileSync(tmpDbPath);
    }
    return fs.readFileSync(srcDbPath);
  } finally {
    try {
      if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
    } catch {}
  }
}

/**
 * Collect essential configuration & auth files from dataDir into a map of { relPath: base64 }.
 */
function buildBackupMap(dataDir) {
  const filesMap = {};
  if (!fs.existsSync(dataDir)) return filesMap;

  const singleFiles = [
    "jwt-secret",
    "machine-id",
    "telebot-config.json",
    "zalo-credentials.json",
    "chat-histories.json",
    "db.json",
    "auth/cli-secret",
    "db/.migrated-from-json",
  ];

  for (const rel of singleFiles) {
    const full = path.join(dataDir, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      filesMap[rel] = fs.readFileSync(full).toString("base64");
    }
  }

  // Also include any extra small files inside auth/
  const authDir = path.join(dataDir, "auth");
  if (fs.existsSync(authDir) && fs.statSync(authDir).isDirectory()) {
    for (const entry of fs.readdirSync(authDir)) {
      const full = path.join(authDir, entry);
      if (fs.statSync(full).isFile() && fs.statSync(full).size < 1024 * 1024) {
        filesMap[`auth/${entry}`] = fs.readFileSync(full).toString("base64");
      }
    }
  }

  const sqlitePath = path.join(dataDir, "db", "data.sqlite");
  if (fs.existsSync(sqlitePath) && fs.statSync(sqlitePath).size > 0) {
    const cleanBuf = exportCleanSqliteBuffer(sqlitePath);
    filesMap["db/data.sqlite"] = cleanBuf.toString("base64");
  }

  return filesMap;
}

/**
 * Restore state from Private GitHub Gist into dataDir BEFORE starting 9Router.
 */
async function restoreFromCloud(dataDir, token = process.env.GITHUB_TOKEN) {
  if (!token || !token.trim()) {
    console.log("[Backup] No GITHUB_TOKEN configured — skipping cloud restore.");
    return false;
  }

  try {
    const gistId = await findOrCreateBackupGist(token.trim());
    if (!gistId) {
      console.log("[Backup] No existing backup Gist found yet — starting fresh.");
      return false;
    }

    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: getGitHubHeaders(token.trim()),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch Gist ${gistId}: HTTP ${res.status}`);
    }

    const gist = await res.json();
    const fileObj = gist.files && gist.files[GIST_FILENAME];
    if (!fileObj) {
      console.log("[Backup] Backup Gist has no state file yet.");
      return false;
    }

    let b64Content = fileObj.content || "";
    if (fileObj.truncated && fileObj.raw_url) {
      const rawRes = await fetch(fileObj.raw_url, {
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      b64Content = await rawRes.text();
    }

    if (!b64Content.trim()) return false;

    const gzBuf = Buffer.from(b64Content.trim(), "base64");
    const jsonStr = zlib.gunzipSync(gzBuf).toString("utf8");
    const filesMap = JSON.parse(jsonStr);

    let restoredCount = 0;
    for (const [relPath, b64] of Object.entries(filesMap)) {
      const targetPath = path.join(dataDir, relPath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, Buffer.from(b64, "base64"));
      restoredCount++;
    }

    lastUploadedHash = crypto.createHash("sha256").update(jsonStr).digest("hex");
    console.log(`[Backup] Restored ${restoredCount} files from Secret Gist (${gistId}).`);
    return true;
  } catch (err) {
    console.error("[Backup] Cloud restore error:", err.message);
    return false;
  }
}

/**
 * Backup current dataDir state to Private GitHub Gist if changed (or if force = true).
 */
async function backupToCloud(dataDir, { token = process.env.GITHUB_TOKEN, force = false } = {}) {
  if (!token || !token.trim()) {
    return { ok: false, skipped: true, reason: "GITHUB_TOKEN chưa được cấu hình" };
  }

  try {
    const filesMap = buildBackupMap(dataDir);
    if (Object.keys(filesMap).length === 0) {
      return { ok: false, skipped: true, reason: "Chưa có dữ liệu để sao lưu" };
    }

    const jsonStr = JSON.stringify(filesMap);
    const currentHash = crypto.createHash("sha256").update(jsonStr).digest("hex");

    if (!force && lastUploadedHash && currentHash === lastUploadedHash) {
      return { ok: true, skipped: true, reason: "Không có thay đổi mới" };
    }

    const gzBuf = zlib.gzipSync(Buffer.from(jsonStr, "utf8"), { level: 9 });
    const b64Payload = gzBuf.toString("base64");
    const sizeKB = (gzBuf.length / 1024).toFixed(1);

    let gistId = await findOrCreateBackupGist(token.trim());
    const payload = {
      description: GIST_DESCRIPTION,
      public: false,
      files: {
        [GIST_FILENAME]: {
          content: b64Payload,
        },
      },
    };

    const url = gistId
      ? `https://api.github.com/gists/${gistId}`
      : "https://api.github.com/gists";
    const method = gistId ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: getGitHubHeaders(token.trim()),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub Gist ${method} failed (${res.status}): ${body}`);
    }

    const saved = await res.json();
    cachedGistId = saved.id;
    lastUploadedHash = currentHash;

    console.log(`[Backup] Saved ${Object.keys(filesMap).length} files (${sizeKB} KB) to Secret Gist (${cachedGistId}).`);
    return { ok: true, gistId: cachedGistId, sizeKB };
  } catch (err) {
    console.error("[Backup] Cloud backup error:", err.message);
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  restoreFromCloud,
  backupToCloud,
};


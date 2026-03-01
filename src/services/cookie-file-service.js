const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const db = require("../db");
const config = require("../config");
const { AppError } = require("../utils/app-error");

function sanitizeFileName(name) {
  if (!name) {
    return "cookies.txt";
  }
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function decodeCookieBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return "";
  }

  // UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.slice(3).toString("utf8");
  }

  // UTF-16 LE BOM
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.slice(2).toString("utf16le");
  }

  // UTF-16 BE BOM -> convert to LE first
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const source = buffer.slice(2);
    const swapped = Buffer.alloc(source.length);
    for (let i = 0; i + 1 < source.length; i += 2) {
      swapped[i] = source[i + 1];
      swapped[i + 1] = source[i];
    }
    return swapped.toString("utf16le");
  }

  return buffer.toString("utf8");
}

function isAuthDomain(domain) {
  const normalized = String(domain || "").trim().toLowerCase().replace(/^\./, "");
  if (!normalized) {
    return false;
  }
  return (
    normalized === "youtu.be" ||
    normalized.endsWith(".youtu.be") ||
    normalized.endsWith("youtube.com") ||
    normalized.endsWith("google.com") ||
    normalized.endsWith("googlevideo.com")
  );
}

function extractDomainsFromNetscape(text) {
  const lines = String(text || "").split(/\r?\n/);
  const domains = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const parts = trimmed.split("\t");
    if (parts.length >= 7) {
      domains.push(parts[0]);
      continue;
    }
    const whitespaceParts = trimmed.split(/\s+/);
    if (whitespaceParts.length >= 7) {
      domains.push(whitespaceParts[0]);
    }
  }
  return domains;
}

function ensureAuthCookieDomains(domains) {
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new AppError(
      400,
      "BAD_REQUEST",
      "Cookie file has no valid cookie entries"
    );
  }
  if (!domains.some((domain) => isAuthDomain(domain))) {
    throw new AppError(
      400,
      "BAD_REQUEST",
      "Cookie file must include YouTube/Google auth cookies"
    );
  }
}

function toEpochSeconds(value) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  if (numeric > 1e12) {
    return Math.floor(numeric / 1000);
  }
  return Math.floor(numeric);
}

function parseJsonCookieText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || (!trimmed.startsWith("[") && !trimmed.startsWith("{"))) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new AppError(400, "BAD_REQUEST", "Invalid JSON cookie file");
  }

  const candidates = Array.isArray(parsed) ? parsed : parsed && parsed.cookies;
  if (!Array.isArray(candidates)) {
    throw new AppError(
      400,
      "BAD_REQUEST",
      "JSON cookie file must be an array or contain a cookies array"
    );
  }

  const rows = [];
  for (const item of candidates) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const domainRaw = item.domain || item.host || item.hostKey || item.domainName;
    const domain = String(domainRaw || "").trim();
    const name = String(item.name || "").trim();
    const value = item.value === undefined || item.value === null ? "" : String(item.value);
    if (!domain || !name) {
      continue;
    }

    const includeSubdomain = domain.startsWith(".") ? "TRUE" : "FALSE";
    const cookiePath = String(item.path || "/").trim() || "/";
    const secure = item.secure ? "TRUE" : "FALSE";
    const expiry = item.session ? 0 : toEpochSeconds(item.expirationDate || item.expires);
    rows.push(
      [domain, includeSubdomain, cookiePath, secure, String(expiry), name, value].join("\t")
    );
  }

  const domains = rows.map((line) => line.split("\t")[0]);
  ensureAuthCookieDomains(domains);

  return `# Netscape HTTP Cookie File\n${rows.join("\n")}\n`;
}

function normalizeNetscapeCookieText(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (normalized.length < 20) {
    throw new AppError(400, "BAD_REQUEST", "Cookie file is too small");
  }
  const domains = extractDomainsFromNetscape(normalized);
  ensureAuthCookieDomains(domains);
  return `${normalized}\n`;
}

function normalizeCookieText(rawText) {
  const jsonNormalized = parseJsonCookieText(rawText);
  if (jsonNormalized) {
    return jsonNormalized;
  }
  return normalizeNetscapeCookieText(rawText);
}

async function saveUserCookieFile(user, file) {
  if (!file) {
    throw new AppError(400, "BAD_REQUEST", "cookieFile is required");
  }
  if (!file.buffer || file.buffer.length === 0) {
    throw new AppError(400, "BAD_REQUEST", "Uploaded cookie file is empty");
  }
  if (file.buffer.length > config.cookieUploadMaxBytes) {
    throw new AppError(
      400,
      "BAD_REQUEST",
      `Cookie file exceeds max size (${config.cookieUploadMaxBytes} bytes)`
    );
  }

  const rawText = decodeCookieBuffer(file.buffer);
  const normalizedText = normalizeCookieText(rawText);

  const userDir = path.join(config.cookieDir, user.id);
  await fs.mkdir(userDir, { recursive: true });

  const fileId = crypto.randomUUID();
  const safeName = sanitizeFileName(file.originalname || "cookies.txt");
  const fileName = `${fileId}_${safeName}`;
  const absolutePath = path.join(userDir, fileName);
  await fs.writeFile(absolutePath, normalizedText, "utf8");

  const { rows } = await db.query(
    `INSERT INTO user_cookie_files (id, user_id, original_file_name, file_path, is_active)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id, original_file_name, created_at`,
    [fileId, user.id, file.originalname || "cookies.txt", absolutePath]
  );
  return rows[0];
}

async function resolveCookieFileForUser(user, cookieFileId) {
  if (!cookieFileId) {
    return null;
  }

  const { rows } = await db.query(
    `SELECT id, user_id, file_path, is_active
     FROM user_cookie_files
     WHERE id = $1`,
    [cookieFileId]
  );
  const file = rows[0];
  if (!file || file.user_id !== user.id || !file.is_active) {
    throw new AppError(400, "BAD_REQUEST", "Invalid cookieFileId");
  }

  try {
    await fs.access(file.file_path);
  } catch {
    throw new AppError(400, "BAD_REQUEST", "Cookie file does not exist on server");
  }
  return file;
}

async function markCookieFileUsed(cookieFileId) {
  if (!cookieFileId) {
    return;
  }
  await db.query(
    `UPDATE user_cookie_files
     SET last_used_at = now()
     WHERE id = $1`,
    [cookieFileId]
  );
}

async function listCookieFilesForUser(user) {
  const { rows } = await db.query(
    `SELECT id, original_file_name, is_active, created_at, updated_at, last_used_at
     FROM user_cookie_files
     WHERE user_id = $1
       AND is_active = true
     ORDER BY created_at DESC
     LIMIT 100`,
    [user.id]
  );
  return rows;
}

async function deleteCookieFileForUser(user, cookieFileId) {
  const { rows } = await db.query(
    `SELECT id, user_id, is_active
     FROM user_cookie_files
     WHERE id = $1`,
    [cookieFileId]
  );
  const file = rows[0];
  if (!file || file.user_id !== user.id) {
    throw new AppError(404, "COOKIE_FILE_NOT_FOUND", "Cookie file not found");
  }
  if (!file.is_active) {
    return {
      id: file.id,
      deleted: false,
    };
  }

  await db.query(
    `UPDATE user_cookie_files
     SET is_active = false,
         updated_at = now()
     WHERE id = $1`,
    [cookieFileId]
  );

  return {
    id: file.id,
    deleted: true,
  };
}

module.exports = {
  saveUserCookieFile,
  resolveCookieFileForUser,
  markCookieFileUsed,
  listCookieFilesForUser,
  deleteCookieFileForUser,
};

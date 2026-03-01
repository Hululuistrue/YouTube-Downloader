const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { v5: uuidv5, validate: isUuid } = require("uuid");
const config = require("../config");
const db = require("../db");

function buildAnonymousKey(req) {
  const explicit = req.get("x-anon-id");
  if (explicit) {
    return `anon:${explicit}`;
  }
  const source = `${req.ip || "unknown"}:${req.get("user-agent") || "unknown"}`;
  const digest = crypto.createHash("sha256").update(source).digest("hex");
  return `anon:${digest}`;
}

function decodeToken(req) {
  const auth = req.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return null;
  }
  const token = auth.slice(7).trim();
  if (!token) {
    return null;
  }
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

async function upsertAnonymousUser(req) {
  const anonKey = buildAnonymousKey(req);
  const userId = uuidv5(anonKey, config.anonNamespaceUuid);

  await db.query(
    `INSERT INTO users (id, role, status, quota_daily)
     VALUES ($1, 'anonymous', 'active', $2)
     ON CONFLICT (id) DO UPDATE
     SET role = 'anonymous',
         status = 'active',
         quota_daily = EXCLUDED.quota_daily`,
    [userId, config.anonDailyQuota]
  );

  const { rows } = await db.query(
    `SELECT id, email, role, status, quota_daily
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return rows[0];
}

async function upsertRegisteredUserFromToken(payload) {
  const subject = payload && typeof payload.sub === "string" ? payload.sub : "";
  if (!subject || !isUuid(subject)) {
    return null;
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  await db.query(
    `INSERT INTO users (id, email, role, status, quota_daily)
     VALUES ($1, $2, 'registered', 'active', $3)
     ON CONFLICT (id) DO UPDATE
     SET email = COALESCE(EXCLUDED.email, users.email),
         role = 'registered',
         status = 'active',
         quota_daily = EXCLUDED.quota_daily`,
    [subject, email, config.registeredDailyQuota]
  );

  const { rows } = await db.query(
    `SELECT id, email, role, status, quota_daily
     FROM users
     WHERE id = $1`,
    [subject]
  );
  return rows[0] || null;
}

async function resolveRequestUser(req) {
  const tokenPayload = decodeToken(req);
  if (tokenPayload) {
    const registered = await upsertRegisteredUserFromToken(tokenPayload);
    if (registered) {
      return registered;
    }
  }
  return upsertAnonymousUser(req);
}

module.exports = {
  resolveRequestUser,
};

"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const db = require("./db");

const DATA_DIR = process.env.LICENSE_DATA_DIR || path.join(__dirname, "data");
const KEYS_DIR = path.join(DATA_DIR, "keys");
const ADMIN_TOKEN = String(process.env.LICENSE_ADMIN_TOKEN || "");
const ALLOW_SELF_ACTIVATION = process.env.LICENSE_ALLOW_SELF_ACTIVATION === "1";
const SEED_DEMO = process.env.LICENSE_SEED_DEMO === "1";
const TRUST_PROXY = process.env.LICENSE_TRUST_PROXY === "1" || Boolean(process.env.VERCEL);
const TOKEN_DAYS = Number(process.env.LICENSE_TOKEN_DAYS || 30);
const GRACE_DAYS = Number(process.env.LICENSE_GRACE_DAYS || 14);
const UPDATES_DIR = process.env.LICENSE_UPDATES_DIR || path.join(__dirname, "updates");
const SERVER_VERSION = process.env.LICENSE_SERVER_VERSION || "2.1.0";
const DEMO_KEY = "550e8400-e29b-41d4-a716-446655440000";

const PLANS = {
  starter: { staff_max: 4, label: "Starter (4 estilistas)" },
  pro: { staff_max: 10, label: "Pro (10 estilistas)" },
  enterprise: { staff_max: 0, label: "Ilimitado" },
};

const RL = {
  windowMs: Number(process.env.LICENSE_RL_WINDOW_MS || 60000),
  activate: Number(process.env.LICENSE_RL_ACTIVATE || 10),
  verify: Number(process.env.LICENSE_RL_VERIFY || 60),
  admin: Number(process.env.LICENSE_RL_ADMIN || 30),
  updates: Number(process.env.LICENSE_RL_UPDATES || 120),
};

function b64url(buf) {
  return buf.toString("base64url");
}

function normalizePem(value) {
  let text = String(value || "").replace(/\\n/g, "\n").trim();
  if (!text) return "";
  if (!text.includes("BEGIN")) text = Buffer.from(text, "base64").toString("utf8").trim();
  return text + "\n";
}

function ensureKeys() {
  const privateEnv = normalizePem(process.env.LICENSE_PRIVATE_KEY_PEM);
  const publicEnv = normalizePem(process.env.LICENSE_PUBLIC_KEY_PEM);

  if (privateEnv) {
    const privateKey = crypto.createPrivateKey(privateEnv);
    const publicKey = publicEnv || crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" });
    return { privateKey, publicKey };
  }
  if (publicEnv) throw new Error("LICENSE_PUBLIC_KEY_PEM requiere LICENSE_PRIVATE_KEY_PEM");
  if (process.env.VERCEL_ENV === "production") {
    throw new Error("Configura LICENSE_PRIVATE_KEY_PEM y LICENSE_PUBLIC_KEY_PEM en Vercel");
  }

  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const privFile = path.join(KEYS_DIR, "private.pem");
  const pubFile = path.join(KEYS_DIR, "public.pem");
  if (!fs.existsSync(privFile) || !fs.existsSync(pubFile)) {
    const pair = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(privFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { encoding: "utf8", mode: 0o600 });
    fs.writeFileSync(pubFile, pair.publicKey.export({ type: "spki", format: "pem" }), "utf8");
    console.log("[license-server] generada nueva llave Ed25519");
  }
  try { fs.chmodSync(privFile, 0o600); } catch {}
  return { privateKey: crypto.createPrivateKey(fs.readFileSync(privFile)), publicKey: fs.readFileSync(pubFile, "utf8") };
}

const KEYS = ensureKeys();

function signToken(payload) {
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = crypto.sign(null, Buffer.from(payloadB64, "utf8"), KEYS.privateKey);
  return payloadB64 + "." + b64url(sig);
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  let ok;
  try {
    ok = crypto.verify(null, Buffer.from(payloadB64, "utf8"), KEYS.publicKey, Buffer.from(sigB64, "base64url"));
  } catch { return null; }
  if (!ok) return null;
  try { return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")); } catch { return null; }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function validateManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("manifiesto de actualización inválido");
  const manifest = {
    version: String(raw.version || ""),
    url: String(raw.url || ""),
    sha256: String(raw.sha256 || ""),
  };
  if (raw.notes !== undefined && raw.notes !== null) manifest.notes = String(raw.notes);
  if (raw.min_version !== undefined && raw.min_version !== null && raw.min_version !== "") manifest.min_version = String(raw.min_version);
  if (raw.published_at !== undefined && raw.published_at !== null) manifest.published_at = String(raw.published_at);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error("versión de actualización inválida");
  if (!manifest.url) throw new Error("URL de actualización inválida");
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) throw new Error("SHA-256 de actualización inválido");
  if (manifest.min_version && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.min_version)) {
    throw new Error("versión mínima inválida");
  }
  return manifest;
}

async function readUpdateManifest(channel) {
  let raw = await db.get(
    "SELECT version, url, sha256, notes, min_version, published_at FROM updates WHERE channel=?",
    [channel]
  );
  if (!raw) {
    const file = path.join(UPDATES_DIR, channel + ".json");
    if (!fs.existsSync(file)) return null;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error("manifiesto de actualización inválido");
    }
  }
  const manifest = validateManifest(raw);
  const signature = b64url(crypto.sign(null, Buffer.from(canonicalJson(manifest), "utf8"), KEYS.privateKey));
  return { ...manifest, signature };
}

function nowISO() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function addDays(n) {
  const dt = new Date();
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt;
}

function issueToken({ license_key, hwid, salon, cliente_email, plan, staff_max }) {
  const payload = {
    license_key,
    hwid,
    salon: salon || null,
    cliente_email: cliente_email || null,
    plan,
    staff_max,
    exp: Date.now() + TOKEN_DAYS * 24 * 60 * 60 * 1000,
    iat: Date.now(),
  };
  return signToken(payload);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HWID_RE = /^[A-Za-z0-9:_-]{16,128}$/;

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanText(value, max) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function validHwid(value) {
  return typeof value === "string" && HWID_RE.test(value);
}

function requestIp(req) {
  return String(req.ip || req.socket.remoteAddress || "").slice(0, 64);
}

async function addEvent(type, { license_key, hwid, detail, ip } = {}) {
  try {
    await db.run(
      "INSERT INTO events (type, license_key, hwid, ip, detail) VALUES (?,?,?,?,?)",
      [type, license_key || null, hwid || null, ip || null, detail || null]
    );
  } catch {}
}

const rateBuckets = new Map();

function rateLimit(name, max) {
  return (req, res, next) => {
    if (!Number.isFinite(max) || max <= 0) return next();
    const now = Date.now();
    const key = name + "|" + requestIp(req);
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start >= RL.windowMs) {
      bucket = { start: now, count: 0 };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retry = Math.max(1, Math.ceil((bucket.start + RL.windowMs - now) / 1000));
      res.set("Retry-After", String(retry));
      return res.status(429).json({ ok: false, error: "RATE_LIMIT", message: "Demasiadas solicitudes. Intenta de nuevo en unos segundos." });
    }
    next();
  };
}

setInterval(() => {
  const cutoff = Date.now() - RL.windowMs * 2;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.start < cutoff) rateBuckets.delete(key);
  }
}, RL.windowMs).unref();

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  return bufA.length === bufB.length && bufA.length > 0 && crypto.timingSafeEqual(bufA, bufB);
}

function adminToken(req) {
  const header = String(req.get("authorization") || "");
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return String(req.get("x-admin-token") || "").trim();
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ ok: false, error: "ADMIN_DISABLED", message: "Configura LICENSE_ADMIN_TOKEN." });
  }
  if (!safeEqual(adminToken(req), ADMIN_TOKEN)) {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }
  next();
}

const app = express();
app.disable("x-powered-by");
if (TRUST_PROXY) app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));
app.use((_req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", "no-store");
  next();
});

let bootPromise = null;
function boot() {
  if (!bootPromise) {
    bootPromise = (async () => {
      await db.ready();
      if (SEED_DEMO) {
        await db.run("INSERT OR IGNORE INTO licenses (key, plan, staff_max) VALUES (?, 'pro', 10)", [DEMO_KEY]);
        console.log("[license-server] licencia demo: " + DEMO_KEY + " (pro, 10 staff)");
      }
    })();
  }
  return bootPromise;
}

app.use(async (_req, res, next) => {
  try {
    await boot();
    next();
  } catch (err) {
    console.error("[license-server] base de datos:", err.message);
    res.status(503).json({ ok: false, error: "DATABASE_UNAVAILABLE" });
  }
});

app.get("/public", (_req, res) => res.json({ ok: true, public_key: KEYS.publicKey, algorithm: "Ed25519" }));
app.get("/health", async (_req, res) => {
  try {
    await db.ready();
    res.json({ ok: true, time: nowISO(), version: SERVER_VERSION });
  } catch (err) {
    res.status(503).json({ ok: false, error: "DATABASE_UNAVAILABLE" });
  }
});

app.get("/api/version", rateLimit("updates", RL.updates), async (req, res) => {
  const channel = String(req.query.channel || "stable").toLowerCase();
  if (channel !== "stable" && channel !== "beta") {
    return res.status(400).json({ ok: false, error: "INVALID_CHANNEL" });
  }
  try {
    const manifest = await readUpdateManifest(channel);
    if (!manifest) return res.status(404).json({ ok: false, error: "NO_UPDATE_MANIFEST" });
    res.json({ ok: true, ...manifest });
  } catch (err) {
    console.error("[license-server] manifiesto:", err.message);
    res.status(500).json({ ok: false, error: "UPDATE_MANIFEST_INVALID" });
  }
});

app.get("/api/download/:file", (req, res) => {
  const file = String(req.params.file || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(exe|zip|msi)$/i.test(file)) {
    return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  }
  const dir = path.join(UPDATES_DIR, "files");
  const absolute = path.join(dir, file);
  if (path.dirname(absolute) !== dir || !fs.existsSync(absolute)) {
    return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  }
  let stat;
  try { stat = fs.statSync(absolute); } catch { return res.status(404).json({ ok: false, error: "NOT_FOUND" }); }
  if (!stat.isFile()) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  res.set("Cache-Control", "public, max-age=3600");
  res.download(absolute, file, (err) => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

app.post("/activate", rateLimit("activate", RL.activate), async (req, res, next) => {
  try {
    const body = req.body || {};
    const key = normalizeKey(body.license_key);
    const hwid = String(body.hwid || "");
    const salon = cleanText(body.salon, 120);
    const clienteEmail = cleanText(body.cliente_email, 200);

    if (!UUID_RE.test(key)) return res.status(400).json({ ok: false, error: "INVALID_LICENSE_KEY" });
    if (!validHwid(hwid)) return res.status(400).json({ ok: false, error: "HWID_REQUIRED" });

    let lic = await db.get("SELECT * FROM licenses WHERE key=?", [key]);
    if (!lic && ALLOW_SELF_ACTIVATION) {
      await db.run("INSERT OR IGNORE INTO licenses (key, plan, staff_max) VALUES (?, 'starter', 4)", [key]);
      lic = await db.get("SELECT * FROM licenses WHERE key=?", [key]);
    }
    if (!lic) return res.status(404).json({ ok: false, error: "LICENSE_NOT_FOUND", message: "Licencia no encontrada. Contacta al soporte." });

    const activeForKey = await db.get("SELECT * FROM activations WHERE license_key=? AND revoked=0", [key]);
    if (activeForKey && activeForKey.hwid !== hwid) {
      await addEvent("activate_denied", { license_key: key, hwid, ip: requestIp(req), detail: "activation_limit" });
      return res.status(409).json({
        ok: false,
        error: "ACTIVATION_LIMIT",
        message: "Esta licencia ya está registrada a otro equipo. Contacta al soporte.",
      });
    }

    const token = issueToken({
      license_key: key, hwid, salon, cliente_email: clienteEmail,
      plan: lic.plan, staff_max: lic.staff_max,
    });
    const expiresAt = addDays(TOKEN_DAYS).toISOString();
    const existing = await db.get("SELECT * FROM activations WHERE hwid=?", [hwid]);

    try {
      if (existing) {
        const changedLicense = existing.license_key !== key;
        await db.run(
          "UPDATE activations SET license_key=?, salon=?, cliente_email=?, token=?, issued_at=datetime('now'), expires_at=?, revoked=0, revoked_at=NULL, last_seen_at=datetime('now') WHERE id=?",
          [key, salon || null, clienteEmail || null, token, expiresAt, existing.id]
        );
        if (changedLicense) {
          await db.run("UPDATE licenses SET issued_count = issued_count + 1 WHERE key=?", [key]);
        }
      } else {
        await db.run(
          "INSERT INTO activations (license_key, hwid, salon, cliente_email, token, expires_at, last_seen_at) VALUES (?,?,?,?,?,?,datetime('now'))",
          [key, hwid, salon || null, clienteEmail || null, token, expiresAt]
        );
        await db.run("UPDATE licenses SET issued_count = issued_count + 1 WHERE key=?", [key]);
      }
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(String(err && err.message))) {
        return res.status(409).json({
          ok: false,
          error: "ACTIVATION_LIMIT",
          message: "Esta licencia ya está registrada a otro equipo. Contacta al soporte.",
        });
      }
      throw err;
    }

    await addEvent("activate", { license_key: key, hwid, ip: requestIp(req), detail: salon || null });

    res.json({
      ok: true,
      token,
      plan: lic.plan,
      staff_max: lic.staff_max,
      salon: salon || null,
      cliente_email: clienteEmail || null,
      expires_at: expiresAt,
      public_key: KEYS.publicKey,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/verify", rateLimit("verify", RL.verify), async (req, res, next) => {
  try {
    const body = req.body || {};
    const token = String(body.token || "");
    const hwid = String(body.hwid || "");
    if (!validHwid(hwid)) return res.status(400).json({ ok: false, error: "HWID_REQUIRED" });
    const payload = verifyToken(token);
    if (!payload) return res.status(400).json({ ok: false, error: "INVALID_TOKEN" });
    if (payload.hwid && payload.hwid !== hwid) {
      return res.status(403).json({ ok: false, reason: "hwid_mismatch", error: "HWID_MISMATCH" });
    }

    const row = await db.get("SELECT * FROM activations WHERE hwid=?", [hwid]);
    if (!row) return res.status(403).json({ ok: false, reason: "not_activated", error: "NOT_ACTIVATED" });
    if (row.license_key !== normalizeKey(payload.license_key)) {
      return res.status(403).json({ ok: false, reason: "token_superseded", error: "TOKEN_REVOKED" });
    }
    if (row.revoked) {
      await addEvent("verify_revoked", { license_key: row.license_key, hwid, ip: requestIp(req) });
      return res.status(403).json({ ok: false, reason: "revoked", error: "REVOKED" });
    }

    const lic = await db.get("SELECT * FROM licenses WHERE key=?", [row.license_key]);
    if (!lic) return res.status(403).json({ ok: false, reason: "not_activated", error: "NOT_ACTIVATED" });

    const expiresMs = new Date(row.expires_at).getTime();
    const graceMs = GRACE_DAYS * 86400000;
    if (Date.now() > expiresMs + graceMs) {
      return res.status(403).json({ ok: false, reason: "expired", error: "EXPIRED" });
    }

    const refreshed = issueToken({
      license_key: lic.key,
      hwid,
      salon: row.salon,
      cliente_email: row.cliente_email,
      plan: lic.plan,
      staff_max: lic.staff_max,
    });
    const newExpiry = addDays(TOKEN_DAYS).toISOString();
    await db.run("UPDATE activations SET token=?, expires_at=?, last_seen_at=datetime('now') WHERE id=?", [refreshed, newExpiry, row.id]);

    res.json({
      ok: true,
      license_key: lic.key,
      plan: lic.plan,
      staff_max: lic.staff_max,
      salon: row.salon,
      cliente_email: row.cliente_email,
      expires_at: newExpiry,
      token: refreshed,
      grace: Date.now() > expiresMs,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/admin/licenses", rateLimit("admin", RL.admin), requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const licenses = await db.all(`
      SELECT l.key, l.plan, l.staff_max, l.cliente_email, l.issued_count, l.created_at,
        (SELECT COUNT(*) FROM activations a WHERE a.license_key=l.key AND a.revoked=0) AS active_activations
      FROM licenses l ORDER BY l.created_at DESC, l.key LIMIT ?
    `, [limit]);
    res.json({ ok: true, licenses });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/licenses", rateLimit("admin", RL.admin), requireAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    const plan = String(body.plan || "starter").toLowerCase();
    if (!PLANS[plan]) return res.status(400).json({ ok: false, error: "INVALID_PLAN" });
    const email = cleanText(body.cliente_email, 200);
    const key = crypto.randomUUID();
    await db.run("INSERT INTO licenses (key, plan, staff_max, cliente_email) VALUES (?,?,?,?)", [
      key, plan, PLANS[plan].staff_max, email || null,
    ]);
    await addEvent("admin_create", { license_key: key, ip: requestIp(req), detail: plan });
    res.status(201).json({ ok: true, license: { key, plan, staff_max: PLANS[plan].staff_max, cliente_email: email || null } });
  } catch (err) {
    next(err);
  }
});

app.get("/admin/licenses/:key", rateLimit("admin", RL.admin), requireAdmin, async (req, res, next) => {
  try {
    const key = normalizeKey(req.params.key);
    const license = await db.get("SELECT * FROM licenses WHERE key=?", [key]);
    if (!license) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    const activations = await db.all(
      "SELECT id, hwid, salon, cliente_email, issued_at, expires_at, revoked, revoked_at, last_seen_at FROM activations WHERE license_key=? ORDER BY issued_at DESC",
      [key]
    );
    res.json({ ok: true, license, activations });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/revoke", rateLimit("admin", RL.admin), requireAdmin, async (req, res, next) => {
  try {
    const hwid = String((req.body || {}).hwid || "");
    if (!validHwid(hwid)) return res.status(400).json({ ok: false, error: "HWID_REQUIRED" });
    const row = await db.get("SELECT * FROM activations WHERE hwid=? AND revoked=0", [hwid]);
    if (!row) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    await db.run("UPDATE activations SET revoked=1, revoked_at=datetime('now') WHERE id=?", [row.id]);
    await addEvent("admin_revoke", { license_key: row.license_key, hwid, ip: requestIp(req) });
    res.json({ ok: true, revoked: true });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/reactivate", rateLimit("admin", RL.admin), requireAdmin, async (req, res, next) => {
  try {
    const hwid = String((req.body || {}).hwid || "");
    if (!validHwid(hwid)) return res.status(400).json({ ok: false, error: "HWID_REQUIRED" });
    const row = await db.get("SELECT * FROM activations WHERE hwid=?", [hwid]);
    if (!row) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    await db.run("UPDATE activations SET revoked=0, revoked_at=NULL, last_seen_at=datetime('now') WHERE id=?", [row.id]);
    await addEvent("admin_reactivate", { license_key: row.license_key, hwid, ip: requestIp(req) });
    res.json({ ok: true, reactivated: true });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/licenses/:key/revoke", rateLimit("admin", RL.admin), requireAdmin, async (req, res, next) => {
  try {
    const key = normalizeKey(req.params.key);
    const row = await db.get("SELECT * FROM activations WHERE license_key=? AND revoked=0", [key]);
    if (!row) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    await db.run("UPDATE activations SET revoked=1, revoked_at=datetime('now') WHERE id=?", [row.id]);
    await addEvent("admin_revoke", { license_key: key, hwid: row.hwid, ip: requestIp(req), detail: "by_license" });
    res.json({ ok: true, revoked: true });
  } catch (err) {
    next(err);
  }
});

app.get("/admin/events", rateLimit("admin", RL.admin), requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const events = await db.all(
      "SELECT id, type, license_key, hwid, ip, detail, created_at FROM events ORDER BY id DESC LIMIT ?",
      [limit]
    );
    res.json({ ok: true, events });
  } catch (err) {
    next(err);
  }
});

app.post("/revoke", rateLimit("admin", RL.admin), requireAdmin, async (req, res, next) => {
  try {
    const hwid = String((req.body || {}).hwid || "");
    if (!validHwid(hwid)) return res.status(400).json({ ok: false, error: "HWID_REQUIRED" });
    const row = await db.get("SELECT * FROM activations WHERE hwid=? AND revoked=0", [hwid]);
    if (!row) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    await db.run("UPDATE activations SET revoked=1, revoked_at=datetime('now') WHERE id=?", [row.id]);
    await addEvent("admin_revoke", { license_key: row.license_key, hwid, ip: requestIp(req) });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/updates", rateLimit("admin", RL.admin), requireAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    const channel = String(body.channel || "stable").toLowerCase();
    if (channel !== "stable" && channel !== "beta") {
      return res.status(400).json({ ok: false, error: "INVALID_CHANNEL" });
    }
    const manifest = validateManifest({
      version: body.version,
      url: body.url,
      sha256: body.sha256,
      notes: body.notes,
      min_version: body.min_version,
      published_at: body.published_at || new Date().toISOString(),
    });
    await db.run(`
      INSERT INTO updates (channel, version, url, sha256, notes, min_version, published_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(channel) DO UPDATE SET
        version=excluded.version, url=excluded.url, sha256=excluded.sha256,
        notes=excluded.notes, min_version=excluded.min_version, published_at=excluded.published_at
    `, [
      channel, manifest.version, manifest.url, manifest.sha256,
      manifest.notes || null, manifest.min_version || null, manifest.published_at,
    ]);
    await addEvent("admin_update", { ip: requestIp(req), detail: channel + " " + manifest.version });
    res.json({ ok: true, channel, ...manifest });
  } catch (err) {
    next(err);
  }
});

app.get("/admin/updates", rateLimit("admin", RL.admin), requireAdmin, async (_req, res, next) => {
  try {
    const rows = await db.all("SELECT channel, version, url, sha256, notes, min_version, published_at FROM updates ORDER BY channel");
    res.json({ ok: true, updates: rows });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "INVALID_JSON" });
  }
  console.error("[license-server] error:", err && err.message);
  res.status(500).json({ ok: false, error: "INTERNAL" });
});

app.use((_req, res) => res.status(404).json({ ok: false, error: "NOT_FOUND" }));

module.exports = app;

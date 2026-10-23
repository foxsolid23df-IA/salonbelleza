"use strict";
require("./env").load();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFileSync } = require("child_process");
const { CONFIG } = require("./db");

const APP_ROOT = path.join(__dirname, "..");
const LICENSE_DIR = path.join(APP_ROOT, ".license");

const GRACE_DAYS = Number(process.env.SALON_GRACE_DAYS || 14);
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEV_SKIP = process.env.SALON_DEV_SKIP_LICENSE === "1";
const LICENSE_SERVER = process.env.LICENSE_SERVER_URL || "https://get.salonsuite.com";

const LICENSE_KEY_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function ensureDir() {
  try { fs.mkdirSync(LICENSE_DIR, { recursive: true }); } catch {}
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function readWmi(prop) {
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-NoLogo", "-Command", `Get-CimInstance -ClassName Win32_ComputerSystemProduct -ErrorAction Stop | Select-Object -First 1 -ExpandProperty ${prop}`],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }
    ).toString().trim();
    if (out) return out;
  } catch {}
  return "";
}

function readDiskSerial() {
  try {
    const out = execFileSync("wmic", ["diskdrive", "get", "serialnumber", "/value"], {
      stdio: ["ignore", "pipe", "ignore"], timeout: 4000,
    }).toString().trim();
    const m = /SerialNumber=(.+)/i.exec(out);
    if (m && m[1].trim()) return m[1].trim();
  } catch {}
  return "";
}

function getHwid() {
  if (os.platform() !== "win32") {
    const stored = path.join(LICENSE_DIR, "hwid_local");
    try {
      if (fs.existsSync(stored)) return fs.readFileSync(stored, "utf8").trim();
    } catch {}
    const rnd = crypto.randomBytes(24).toString("hex");
    ensureDir();
    fs.writeFileSync(stored, rnd, { encoding: "utf8" });
    return rnd;
  }
  const board = readWmi("SerialNumber");
  const uuid = readWmi("UUID");
  const disk = readDiskSerial();
  const parts = [board, disk, uuid].filter(Boolean);
  if (parts.length === 0) {
    const rnd = "fallback-" + crypto.randomBytes(12).toString("hex");
    return sha256(rnd);
  }
  return sha256(parts.join("|"));
}

function loadTokenFile() {
  ensureDir();
  const file = path.join(LICENSE_DIR, "token");
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null;
  }
}

function saveTokenFile(obj) {
  ensureDir();
  fs.writeFileSync(path.join(LICENSE_DIR, "token"), JSON.stringify(obj), "utf8");
}

function loadPublicKey() {
  const envKey = process.env.LICENSE_PUBLIC_KEY;
  if (envKey) return envKey;
  const pemFile = path.join(LICENSE_DIR, "public_key.pem");
  if (fs.existsSync(pemFile)) return fs.readFileSync(pemFile, "utf8");
  const bundled = path.join(APP_ROOT, "public_key.pem");
  if (fs.existsSync(bundled)) return fs.readFileSync(bundled, "utf8");
  return null;
}

function verifySignature(payloadB64, sigB64, pubKeyPem) {
  if (!pubKeyPem) return false;
  try {
    const key = crypto.createPublicKey(pubKeyPem);
    const payloadBuf = Buffer.from(payloadB64, "utf8");
    const sigBuf = Buffer.from(sigB64, "base64url");
    return crypto.verify(null, payloadBuf, key, sigBuf);
  } catch {
    return false;
  }
}

function parseToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  const pub = loadPublicKey();
  if (!verifySignature(payloadB64, sigB64, pub)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    return payload;
  } catch {
    return null;
  }
}

function activationState() {
  if (DEV_SKIP) return { activated: true, grace: false, token: null, hwid: getHwid() };
  if (CONFIG.get("license_revoked") === "1") {
    return { activated: false, grace: false, graceDaysLeft: 0, hwid: getHwid(), token: null, reason: "revoked" };
  }
  if (CONFIG.get("license_force_setup") === "1") {
    return { activated: false, grace: false, graceDaysLeft: 0, hwid: getHwid(), token: null, reason: "needs_activation" };
  }
  const token = loadTokenFile();
  if (!token || !token.token) {
    return { activated: false, grace: GRACE_DAYS >= 0, graceDaysLeft: GRACE_DAYS, hwid: getHwid(), token: null };
  }
  const payload = parseToken(String(token.token));
  if (!payload) return { activated: false, grace: false, graceDaysLeft: 0, hwid: getHwid(), token: null, reason: "token_invalid" };
  const hwid = getHwid();
  const matches = (!payload.hwid || payload.hwid === hwid);
  if (!matches) return { activated: false, grace: false, graceDaysLeft: 0, hwid, token: null, reason: "hwid_mismatch" };
  const exp = Number(payload.exp) || 0;
  const now = Date.now();
  if (exp <= now) {
    const overdue = Math.floor((now - exp) / 86400000);
    return overdue <= GRACE_DAYS
      ? { activated: true, grace: true, graceDaysLeft: GRACE_DAYS - overdue, hwid, token: payload }
      : { activated: false, grace: false, graceDaysLeft: 0, hwid, token: null, reason: "expired" };
  }
  return { activated: true, grace: false, graceDaysLeft: GRACE_DAYS, hwid, token: payload };
}

function persistActivation({ token, salon, cliente_email, plan, staff_max, expires_at, license_key }) {
  ensureDir();
  saveTokenFile({ token, salon, cliente_email, plan, staff_max, expires_at, license_key });
}

async function revalidate() {
  const checkedAt = new Date().toISOString();
  if (DEV_SKIP) return { ok: true, skipped: true };
  const stored = loadTokenFile();
  if (!stored || !stored.token) {
    CONFIG.set("license_status", "inactive");
    CONFIG.set("license_last_check", checkedAt);
    return { ok: false, reason: "inactive" };
  }
  const hwid = getHwid();
  let resp;
  try {
    resp = await fetch(LICENSE_SERVER + "/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: stored.token, hwid }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    CONFIG.set("license_status", "offline");
    CONFIG.set("license_last_check", checkedAt);
    return { ok: false, reason: "offline" };
  }
  let payload = {};
  try { payload = await resp.json(); } catch {}
  CONFIG.set("license_last_check", checkedAt);
  if (resp.ok && payload.ok) {
    CONFIG.set("license_status", "active");
    CONFIG.set("license_revoked", "0");
    CONFIG.set("license_force_setup", "0");
    if (payload.token && payload.token !== stored.token) {
      stored.token = payload.token;
      saveTokenFile(stored);
    }
    if (payload.expires_at) {
      stored.expires_at = payload.expires_at;
      saveTokenFile(stored);
    }
    return { ok: true };
  }
  const reason = payload.reason || "";
  if (reason === "revoked" || payload.error === "REVOKED") {
    CONFIG.set("license_status", "revoked");
    CONFIG.set("license_revoked", "1");
    dbRevoke();
    return { ok: false, reason: "revoked" };
  }
  if (reason === "token_superseded" || reason === "not_activated" || payload.error === "TOKEN_REVOKED") {
    CONFIG.set("license_status", "needs_activation");
    CONFIG.set("license_force_setup", "1");
    return { ok: false, reason: "needs_activation" };
  }
  CONFIG.set("license_status", reason || payload.error || "invalid");
  return { ok: false, reason: reason || payload.error || "invalid" };
}

function dbRevoke() {
  try {
    const { db } = require("./db");
    db.prepare("UPDATE license_tokens SET revoked=1 WHERE revoked=0").run();
  } catch {}
}

function validateLicenseKey(key) {
  return LICENSE_KEY_REGEX.test(String(key || "").trim().toLowerCase());
}

module.exports = {
  ensureDir,
  getHwid,
  loadTokenFile,
  saveTokenFile,
  loadPublicKey,
  verifySignature,
  parseToken,
  activationState,
  persistActivation,
  revalidate,
  validateLicenseKey,
  TOKEN_TTL_MS,
  GRACE_DAYS,
  LICENSE_SERVER,
  DEV_SKIP: !!DEV_SKIP,
};

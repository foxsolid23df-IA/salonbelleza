"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { CONFIG } = require("./db");
const license = require("./license");

const APP_ROOT = path.join(__dirname, "..");
const INSTALL_ROOT = path.resolve(APP_ROOT, "..");
const DATA_DIR = path.join(APP_ROOT, "data");
const PROGRAM_DATA = String(process.env.ProgramData || process.env.ALLUSERSPROFILE || "C:\\ProgramData").replace(/[\\/]+$/, "");
const ADMIN_INSTALL = (INSTALL_ROOT.toLowerCase() + path.sep).startsWith(PROGRAM_DATA.toLowerCase() + path.sep);
const CURRENT_VERSION = String(process.env.APP_VERSION || "0.2.0");
const SERVER = String(process.env.LICENSE_SERVER_URL || "https://get.salonsuite.com").replace(/\/+$/, "");
const CHANNEL = String(process.env.SALON_UPDATE_CHANNEL || "stable").toLowerCase();
const ALLOW_UNSIGNED = process.env.SALON_ALLOW_UNSIGNED_UPDATES === "1";
const ALLOW_HTTP = process.env.SALON_UPDATE_ALLOW_HTTP === "1";
const STATE_KEY = "update_state";
const INSTALLING_KEY = "update_installing";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CACHE_MS = 60 * 60 * 1000;
const MAX_DOWNLOAD = 250 * 1024 * 1024;

let inFlight = null;
let installing = false;
let schedulerStarted = false;

function parseVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1;
  if (!pb.pre.length) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
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

function verifySignedManifest(manifest, signature, publicKeyPem) {
  if (!signature) return false;
  const pem = publicKeyPem || license.loadPublicKey();
  if (!pem) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(canonicalJson(manifest), "utf8"),
      crypto.createPublicKey(pem),
      Buffer.from(String(signature), "base64url")
    );
  } catch {
    return false;
  }
}

function allowedUrl(value) {
  let url;
  try { url = new URL(String(value), SERVER + "/"); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.protocol === "http:" && !ALLOW_HTTP) {
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (!local) return null;
  }
  return url;
}

function normalizeManifest(manifest) {
  const version = String(manifest.version || "").trim();
  if (!parseVersion(version)) throw new Error("Versión de actualización inválida");
  const sha256 = String(manifest.sha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("SHA-256 de actualización inválido");
  const url = allowedUrl(manifest.url);
  if (!url) throw new Error("URL de actualización inválida o sin HTTPS");
  const notes = String(manifest.notes || "").trim().slice(0, 8000);
  const minVersion = manifest.min_version ? String(manifest.min_version).trim() : "";
  if (minVersion && !parseVersion(minVersion)) throw new Error("Versión mínima inválida");
  return {
    version,
    url: url.toString(),
    sha256,
    notes,
    min_version: minVersion,
    mandatory: !!minVersion && compareVersions(CURRENT_VERSION, minVersion) < 0,
    available: compareVersions(version, CURRENT_VERSION) > 0,
  };
}

function getState() {
  const raw = CONFIG.get(STATE_KEY, "");
  if (!raw) return { ok: null, lastCheck: null, current: CURRENT_VERSION, channel: CHANNEL, available: false };
  try {
    const state = JSON.parse(raw);
    state.current = CURRENT_VERSION;
    if (state.version) {
      state.available = compareVersions(state.version, CURRENT_VERSION) > 0;
      state.mandatory = !!state.min_version && compareVersions(CURRENT_VERSION, state.min_version) < 0;
    }
    return state;
  } catch {
    return { ok: null, lastCheck: null, current: CURRENT_VERSION, channel: CHANNEL, available: false };
  }
}

function saveState(state) {
  try { CONFIG.set(STATE_KEY, JSON.stringify(state)); } catch {}
}

async function check(options = {}) {
  if (inFlight) return inFlight;
  const previous = getState();
  if (!options.force && previous.lastCheck) {
    const age = Date.now() - new Date(previous.lastCheck).getTime();
    if (Number.isFinite(age) && age >= 0 && age < CACHE_MS) return previous;
  }
  inFlight = (async () => {
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch(`${SERVER}/api/version?channel=${encodeURIComponent(CHANNEL)}`, {
        headers: { "accept": "application/json" },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) throw new Error(`Servidor de actualizaciones ${res.status}`);
      const data = await res.json();
      if (!data || !data.ok || typeof data.version !== "string") throw new Error("Respuesta de actualización inválida");
      const { signature, ok: _ok, ...manifest } = data;
      const pub = license.loadPublicKey();
      if (!pub && !ALLOW_UNSIGNED) throw new Error("Falta la llave pública para verificar la actualización");
      if (pub && !verifySignedManifest(manifest, signature, pub)) throw new Error("Firma de actualización inválida");
      const info = normalizeManifest(manifest);
      const state = {
        ok: true,
        lastCheck: checkedAt,
        current: CURRENT_VERSION,
        channel: CHANNEL,
        version: info.version,
        url: info.url,
        sha256: info.sha256,
        notes: info.notes,
        min_version: info.min_version,
        mandatory: info.mandatory,
        available: info.available,
        error: null,
      };
      saveState(state);
      return state;
    } catch (err) {
      const state = {
        ...previous,
        ok: false,
        lastCheck: checkedAt,
        current: CURRENT_VERSION,
        channel: CHANNEL,
        available: previous.version ? compareVersions(previous.version, CURRENT_VERSION) > 0 : false,
        mandatory: !!previous.min_version && compareVersions(CURRENT_VERSION, previous.min_version) < 0,
        error: err.message,
      };
      saveState(state);
      return state;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function isInstalled() {
  return (
    fs.existsSync(path.join(INSTALL_ROOT, "runtime", "node.exe")) &&
    fs.existsSync(path.join(INSTALL_ROOT, "launcher.exe")) &&
    fs.existsSync(path.join(APP_ROOT, "server.js"))
  );
}

async function download(state) {
  if (!state || !state.url || !state.sha256) throw new Error("No hay actualización para descargar");
  const res = await fetch(state.url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`Descarga falló con estado ${res.status}`);
  const length = Number(res.headers.get("content-length") || 0);
  if (length > MAX_DOWNLOAD) throw new Error("La actualización excede el tamaño máximo permitido");
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD) throw new Error("La actualización excede el tamaño máximo permitido");
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (hash !== state.sha256) throw new Error("SHA-256 de la descarga no coincide");
  const dir = path.join(os.tmpdir(), "salonsuite-updates");
  fs.mkdirSync(dir, { recursive: true });
  const safeVersion = String(state.version || "update").replace(/[^0-9A-Za-z._-]/g, "_");
  const suffix = crypto.randomBytes(6).toString("hex");
  const file = path.join(dir, `SalonSuite-${safeVersion}-${suffix}-setup.exe`);
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  return { file, sha256: hash, size: buffer.length };
}

function install(state, file) {
  if (installing) throw new Error("Ya hay una actualización en curso");
  if (!state || !state.version || !state.sha256) throw new Error("Actualización inválida");
  if (!isInstalled()) throw new Error("La instalación automática solo está disponible en una instalación de Windows");
  if (!fs.existsSync(file)) throw new Error("No se encontró el instalador descargado");
  const actualHash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actualHash !== state.sha256) throw new Error("El instalador cambió después de la descarga");
  const portFile = path.join(DATA_DIR, "port.txt");
  let port = Number(process.env.PORT || 3000);
  try {
    const actual = Number(fs.readFileSync(portFile, "utf8").trim());
    if (actual > 0 && actual < 65536) port = actual;
  } catch {}
  const configPath = path.join(os.tmpdir(), `salonsuite-update-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`);
  fs.writeFileSync(configPath, JSON.stringify({
    installRoot: INSTALL_ROOT,
    appDir: APP_ROOT,
    installer: file,
    sha256: state.sha256,
    version: state.version,
    fromVersion: CURRENT_VERSION,
    serviceName: "SalonSuite",
    serviceInstall: ADMIN_INSTALL,
    healthUrl: `http://127.0.0.1:${port}/health`,
    logFile: path.join(INSTALL_ROOT, "logs", "update.log"),
  }, null, 2), "utf8");
  const helper = path.join(__dirname, "update-helper.js");
  const helperDir = path.join(os.tmpdir(), "salonsuite-updates");
  let helperNode = process.execPath;
  try {
    fs.mkdirSync(helperDir, { recursive: true });
    const copy = path.join(helperDir, "node-helper.exe");
    fs.copyFileSync(process.execPath, copy);
    helperNode = copy;
  } catch {}
  const child = spawn(helperNode, [helper, configPath], {
    cwd: INSTALL_ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  installing = true;
  try { CONFIG.set(INSTALLING_KEY, JSON.stringify({ version: state.version, started_at: new Date().toISOString() })); } catch {}
  const timer = setTimeout(() => { installing = false; }, 10 * 60 * 1000);
  if (timer.unref) timer.unref();
  return { pid: child.pid, version: state.version };
}

function onStartup() {
  installing = false;
  try { CONFIG.set(INSTALLING_KEY, ""); } catch {}
}

function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const run = () => check().then((state) => {
    if (state && state.available) console.log("[actualizaciones] disponible " + state.version);
  }).catch((err) => console.error("[actualizaciones]", err.message));
  const first = setTimeout(run, 20000);
  if (first.unref) first.unref();
  const daily = setInterval(run, CHECK_INTERVAL_MS);
  if (daily.unref) daily.unref();
}

module.exports = {
  APP_ROOT,
  INSTALL_ROOT,
  CURRENT_VERSION,
  CHANNEL,
  SERVER,
  ADMIN_INSTALL,
  check,
  download,
  install,
  isInstalled,
  getState,
  onStartup,
  startScheduler,
  parseVersion,
  compareVersions,
  canonicalJson,
  verifySignedManifest,
};

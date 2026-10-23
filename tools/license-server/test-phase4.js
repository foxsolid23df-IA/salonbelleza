"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = 44000 + Math.floor(Math.random() * 900);
const BASE = "http://127.0.0.1:" + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "salon-update-"));
const UPDATES_DIR = path.join(DATA_DIR, "updates");
const FILES_DIR = path.join(UPDATES_DIR, "files");
fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "app"), { recursive: true });

const payload = Buffer.from("salonsuite-update-test-" + crypto.randomBytes(32).toString("hex"));
const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
fs.writeFileSync(path.join(FILES_DIR, "test-update.exe"), payload);
fs.writeFileSync(path.join(UPDATES_DIR, "stable.json"), JSON.stringify({
  version: "9.9.9",
  url: "/api/download/test-update.exe",
  sha256,
  notes: "Prueba de actualización",
  min_version: "0.2.0",
  published_at: new Date().toISOString(),
}, null, 2));

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: "127.0.0.1",
  LICENSE_DATA_DIR: path.join(DATA_DIR, "data"),
  LICENSE_UPDATES_DIR: UPDATES_DIR,
  LICENSE_ADMIN_TOKEN: "test-admin",
  LICENSE_SEED_DEMO: "0",
  LICENSE_ALLOW_SELF_ACTIVATION: "0",
};

let logs = "";
const child = spawn(process.execPath, [path.join(__dirname, "index.js")], {
  cwd: __dirname,
  env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout.on("data", (d) => { logs += d.toString(); });
child.stderr.on("data", (d) => { logs += d.toString(); });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error("el servidor terminó antes de iniciar");
    try {
      const res = await fetch(BASE + "/health");
      if (res.ok) return;
    } catch {}
    await sleep(150);
  }
  throw new Error("timeout esperando /health");
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

async function call(route) {
  const res = await fetch(BASE + route);
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}

async function main() {
  await waitReady();

  const version = await call("/api/version?channel=stable");
  assert.equal(version.status, 200);
  assert.equal(version.data.ok, true);
  assert.equal(version.data.version, "9.9.9");
  assert.equal(version.data.sha256, sha256);
  assert.ok(version.data.signature);

  const publicRes = await call("/public");
  const publicKey = publicRes.data.public_key;
  const { signature, ok: _ok, ...manifest } = version.data;
  assert.equal(
    crypto.verify(null, Buffer.from(canonicalJson(manifest), "utf8"), crypto.createPublicKey(publicKey), Buffer.from(signature, "base64url")),
    true
  );

  const tampered = { ...manifest, version: "9.9.8" };
  assert.equal(
    crypto.verify(null, Buffer.from(canonicalJson(tampered), "utf8"), crypto.createPublicKey(publicKey), Buffer.from(signature, "base64url")),
    false
  );

  const invalidChannel = await call("/api/version?channel=nope");
  assert.equal(invalidChannel.status, 400);
  const missingChannel = await call("/api/version?channel=beta");
  assert.equal(missingChannel.status, 404);

  const download = await fetch(BASE + "/api/download/test-update.exe");
  assert.equal(download.status, 200);
  const downloaded = Buffer.from(await download.arrayBuffer());
  assert.equal(downloaded.equals(payload), true);
  assert.ok(String(download.headers.get("content-disposition") || "").includes("test-update.exe"));

  const blockedManifest = await fetch(BASE + "/api/download/stable.json");
  assert.equal(blockedManifest.status, 404);
  const blockedTraversal = await fetch(BASE + "/api/download/..%2Fstable.json");
  assert.equal(blockedTraversal.status, 404);

  const published = await fetch(BASE + "/admin/updates", {
    method: "POST",
    headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" },
    body: JSON.stringify({
      channel: "beta",
      version: "9.9.9-beta.1",
      url: "https://example.com/SalonSuite-9.9.9-beta.1-setup.exe",
      sha256,
      notes: "Prueba beta",
      published_at: new Date().toISOString(),
    }),
  });
  assert.equal(published.status, 200);
  const beta = await call("/api/version?channel=beta");
  assert.equal(beta.status, 200);
  assert.equal(beta.data.version, "9.9.9-beta.1");
  assert.equal(beta.data.min_version, undefined);
  const { signature: betaSignature, ok: _betaOk, ...betaManifest } = beta.data;
  assert.equal(
    crypto.verify(null, Buffer.from(canonicalJson(betaManifest), "utf8"), crypto.createPublicKey(publicKey), Buffer.from(betaSignature, "base64url")),
    true
  );

  process.env.LICENSE_SERVER_URL = BASE;
  process.env.LICENSE_PUBLIC_KEY = publicKey;
  process.env.APP_VERSION = "0.2.0";
  process.env.SALON_UPDATE_CHANNEL = "stable";
  process.env.SALON_DB = path.join(DATA_DIR, "app", "salon.db");
  process.env.SALON_ALLOW_UNSIGNED_UPDATES = "0";

  const updates = require("../../src/updates");
  assert.equal(updates.compareVersions("0.2.0", "0.2.1"), -1);
  assert.equal(updates.compareVersions("0.3.0", "0.3.0"), 0);
  assert.equal(updates.compareVersions("0.3.0-beta.1", "0.3.0"), -1);

  const state = await updates.check({ force: true });
  assert.equal(state.ok, true, state.error);
  assert.equal(state.available, true);
  assert.equal(state.version, "9.9.9");
  assert.equal(state.notes, "Prueba de actualización");
  assert.equal(updates.getState().version, "9.9.9");

  const checkTampered = { ...manifest, version: "9.9.8" };
  assert.equal(updates.verifySignedManifest(checkTampered, signature, publicKey), false);
  assert.equal(updates.verifySignedManifest(manifest, signature, publicKey), true);

  const file = await updates.download(state);
  assert.equal(fs.readFileSync(file.file).equals(payload), true);
  assert.equal(file.sha256, sha256);
  fs.rmSync(file.file, { force: true });

  console.log("PASS Fase 4: manifiesto firmado, canales, descarga y verificación del cliente");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    console.error("--- logs del servidor ---");
    console.error(logs);
    process.exitCode = 1;
  })
  .finally(() => {
    try { child.kill(); } catch {}
    setTimeout(() => {
      try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    }, 300);
  });

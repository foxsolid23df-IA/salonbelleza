"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const Database = require("better-sqlite3");

const PORT = 45000 + Math.floor(Math.random() * 900);
const BASE = "http://127.0.0.1:" + PORT;
const ROOT = path.join(__dirname, "..");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "salon-update-ui-"));
const DB_PATH = path.join(DATA_DIR, "salon.db");

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: "127.0.0.1",
  SALON_DB: DB_PATH,
  SALON_SECRET: "test-secret-update-ui",
  SALON_DEV_SKIP_LICENSE: "1",
  LICENSE_SERVER_URL: "http://127.0.0.1:1",
  APP_VERSION: "0.2.0",
};

let logs = "";
const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
  cwd: ROOT,
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
    if (child.exitCode !== null) throw new Error("la app terminó antes de iniciar");
    try {
      const res = await fetch(BASE + "/health");
      if (res.ok) return;
    } catch {}
    await sleep(150);
  }
  throw new Error("timeout esperando /health");
}

async function main() {
  await waitReady();

  const login = await fetch(BASE + "/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "admin@salon.local", password: "admin123" }),
    redirect: "manual",
  });
  assert.equal(login.status, 302);
  const cookie = String(login.headers.getSetCookie()[0] || "").split(";")[0];
  assert.ok(cookie.startsWith("connect.sid="));

  const page = await fetch(BASE + "/updates", { headers: { cookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.includes("Actualizaciones"));
  assert.ok(html.includes("0.2.0"));

  const db = new Database(DB_PATH);
  db.prepare("INSERT INTO config(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    "update_state",
    JSON.stringify({
      ok: true,
      lastCheck: new Date().toISOString(),
      current: "0.2.0",
      channel: "stable",
      version: "0.2.1",
      url: "https://example.com/SalonSuite-0.2.1-setup.exe",
      sha256: "a".repeat(64),
      notes: "Prueba",
      min_version: "0.2.0",
      mandatory: false,
      available: true,
      error: null,
    })
  );
  db.close();

  const dashboard = await fetch(BASE + "/", { headers: { cookie } });
  const dashHtml = await dashboard.text();
  assert.equal(dashboard.status, 200);
  assert.ok(dashHtml.includes("Nueva versión"));
  assert.ok(dashHtml.includes("0.2.1"));

  console.log("PASS Fase 4 UI: banner y página de actualizaciones");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    console.error("--- logs ---");
    console.error(logs);
    process.exitCode = 1;
  })
  .finally(() => {
    try { child.kill(); } catch {}
    setTimeout(() => {
      try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    }, 300);
  });

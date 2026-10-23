"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HELPER = path.join(ROOT, "src", "update-helper.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "salon-helper-"));
const INSTALL = path.join(TMP, "install");
const APP = path.join(INSTALL, "app");
const LOG_DIR = path.join(INSTALL, "logs");
const STATUS = path.join(LOG_DIR, "update-status.json");

let healthVersion = "0.2.1";
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, version: healthVersion }));
  }
  res.writeHead(404);
  res.end();
});

function seedApp() {
  fs.rmSync(INSTALL, { recursive: true, force: true });
  fs.mkdirSync(path.join(APP, "src"), { recursive: true });
  fs.mkdirSync(path.join(APP, "data"), { recursive: true });
  fs.mkdirSync(path.join(APP, ".license"), { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(APP, "server.js"), "console.log('test');\n");
  fs.writeFileSync(path.join(APP, "src", "app.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(APP, "data", "salon.db"), "database");
  fs.writeFileSync(path.join(APP, ".license", "token"), "license");
  fs.writeFileSync(path.join(APP, ".env"), "PORT=3000\n");
}

function listen() {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function runHelper(options) {
  fs.rmSync(STATUS, { force: true });
  const config = path.join(TMP, `helper-${crypto.randomBytes(4).toString("hex")}.json`);
  const port = options.port;
  fs.writeFileSync(config, JSON.stringify({
    installRoot: INSTALL,
    appDir: APP,
    installer: process.execPath,
    sha256: options.sha256,
    version: options.version,
    fromVersion: options.fromVersion,
    serviceName: "__SalonSuiteTest__",
    healthUrl: `http://127.0.0.1:${port}/health`,
    logFile: path.join(LOG_DIR, "update.log"),
    verifyTimeoutMs: 4000,
    rollbackTimeoutMs: 4000,
  }, null, 2));
  const child = spawn(process.execPath, [HELPER, config], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout esperando al helper")), 30000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return JSON.parse(fs.readFileSync(STATUS, "utf8"));
}

async function main() {
  const port = await listen();
  const goodHash = crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");

  seedApp();
  healthVersion = "0.2.1";
  const success = await runHelper({ port, version: "0.2.1", fromVersion: "0.2.0", sha256: goodHash });
  assert.equal(success.state, "success");
  assert.equal(fs.existsSync(path.join(INSTALL, "app.old")), false);
  assert.equal(fs.readFileSync(path.join(APP, ".env"), "utf8"), "PORT=3000\n");
  assert.equal(fs.readFileSync(path.join(APP, "data", "salon.db"), "utf8"), "database");
  assert.equal(fs.readFileSync(path.join(APP, ".license", "token"), "utf8"), "license");

  seedApp();
  healthVersion = "0.2.0";
  const rolled = await runHelper({ port, version: "0.2.1", fromVersion: "0.2.0", sha256: goodHash });
  assert.equal(rolled.state, "rolled_back");
  assert.equal(fs.existsSync(path.join(INSTALL, "app.old")), true);
  assert.equal(fs.existsSync(path.join(APP, "server.js")), true);

  seedApp();
  healthVersion = "0.2.1";
  const rejected = await runHelper({ port, version: "0.2.1", fromVersion: "0.2.0", sha256: "0".repeat(64) });
  assert.equal(rejected.state, "failed");
  assert.equal(fs.existsSync(path.join(INSTALL, "app.old")), false);

  console.log("PASS Fase 4 helper: respaldo, actualización simulada, rollback y hash inválido");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    server.close();
    setTimeout(() => {
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    }, 300);
  });

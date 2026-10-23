"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const configPath = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const LOG_FILE = cfg.logFile || path.join(cfg.installRoot, "logs", "update.log");
const STATUS_FILE = path.join(path.dirname(LOG_FILE), "update-status.json");
const VERIFY_TIMEOUT = Number(cfg.verifyTimeoutMs) || 90000;
const ROLLBACK_TIMEOUT = Number(cfg.rollbackTimeoutMs) || 60000;
const SERVICE_NAME = String(cfg.serviceName || "SalonSuite");
const SERVICE_INSTALL = cfg.serviceInstall === true;

function log(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {}
}

function writeStatus(state, message) {
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      state,
      version: cfg.version,
      fromVersion: cfg.fromVersion,
      message: message || "",
      at: new Date().toISOString(),
    }, null, 2), "utf8");
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function health() {
  try {
    const res = await fetch(cfg.healthUrl, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function serviceExists() {
  try {
    execFileSync("sc.exe", ["query", SERVICE_NAME], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function startApp() {
  if (serviceExists()) {
    try {
      execFileSync("sc.exe", ["start", SERVICE_NAME], { stdio: "ignore", windowsHide: true });
    } catch {}
    return;
  }
  if (SERVICE_INSTALL) {
    const serviceExe = path.join(cfg.installRoot, "salonsuite-service.exe");
    if (fs.existsSync(serviceExe)) {
      try {
        execFileSync(serviceExe, ["install"], { stdio: "ignore", windowsHide: true, cwd: cfg.installRoot });
        execFileSync("sc.exe", ["start", SERVICE_NAME], { stdio: "ignore", windowsHide: true });
        return;
      } catch {}
    }
  }
  const launcher = path.join(cfg.installRoot, "launcher.exe");
  if (fs.existsSync(launcher)) {
    try {
      const child = spawn(launcher, ["--check"], { detached: true, stdio: "ignore", windowsHide: true, cwd: cfg.installRoot });
      child.unref();
      return;
    } catch {}
  }
  const nodeExe = path.join(cfg.installRoot, "runtime", "node.exe");
  const server = path.join(cfg.appDir, "server.js");
  if (fs.existsSync(nodeExe) && fs.existsSync(server)) {
    try {
      const child = spawn(nodeExe, [server], { detached: true, stdio: "ignore", windowsHide: true, cwd: cfg.appDir });
      child.unref();
    } catch {}
  }
}

function stopApp() {
  if (serviceExists()) {
    try {
      execFileSync("sc.exe", ["stop", SERVICE_NAME], { stdio: "ignore", windowsHide: true });
    } catch {}
    return;
  }
  try {
    const pid = Number(fs.readFileSync(path.join(cfg.appDir, "data", "server.pid"), "utf8").trim());
    if (pid > 0) execFileSync("taskkill.exe", ["/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
  } catch {}
}

async function waitHealthy(expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let triedStart = false;
  while (Date.now() < deadline) {
    const state = await health();
    if (state && String(state.version) === String(expected)) return state;
    if (!triedStart && Date.now() > deadline - timeoutMs + 7000) {
      triedStart = true;
      startApp();
    }
    await sleep(2000);
  }
  return null;
}

function verifyInstaller() {
  if (!cfg.sha256) return true;
  try {
    const hash = crypto.createHash("sha256").update(fs.readFileSync(cfg.installer)).digest("hex");
    return hash === cfg.sha256;
  } catch {
    return false;
  }
}

function backupApp() {
  const target = path.join(cfg.installRoot, "app.old");
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(cfg.appDir, target, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(cfg.appDir, src);
      const first = rel.split(path.sep)[0];
      return !["data", ".license", ".env", "logs", "app.old"].includes(first);
    },
  });
  return target;
}

function restoreApp() {
  const source = path.join(cfg.installRoot, "app.old");
  if (!fs.existsSync(source)) throw new Error("No existe app.old para restaurar");
  fs.cpSync(source, cfg.appDir, { recursive: true, force: true });
}

function runInstaller() {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cfg.installer, ["/S", "/D=" + cfg.installRoot], {
        stdio: "ignore",
        windowsHide: true,
        cwd: cfg.installRoot,
      });
    } catch (err) {
      return reject(err);
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error("El instalador excedió el tiempo máximo"));
    }, 300000);
    if (timer.unref) timer.unref();
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function main() {
  log(`inicio actualización ${cfg.fromVersion} -> ${cfg.version}`);
  writeStatus("running", "Preparando actualización");
  await sleep(2500);

  if (!verifyInstaller()) {
    log("el SHA-256 del instalador no coincide");
    writeStatus("failed", "El instalador descargado no es válido");
    return;
  }

  try {
    backupApp();
    log("respaldo app.old creado");
  } catch (err) {
    log("no se pudo crear app.old: " + err.message);
    writeStatus("failed", "No se pudo preparar el respaldo");
    return;
  }

  let code = -1;
  try {
    code = await runInstaller();
    log("instalador terminó con código " + code);
  } catch (err) {
    log("instalador falló: " + err.message);
  }

  await sleep(2500);
  const updated = await waitHealthy(cfg.version, VERIFY_TIMEOUT);
  if (updated) {
    log("actualización verificada: " + updated.version);
    writeStatus("success", "Actualización aplicada");
    try { fs.rmSync(path.join(cfg.installRoot, "app.old"), { recursive: true, force: true }); } catch {}
    return;
  }

  log("la versión nueva no respondió; restaurando app.old");
  writeStatus("rollback", "Restaurando la versión anterior");
  stopApp();
  await sleep(1200);
  try {
    restoreApp();
    log("app.old restaurado");
  } catch (err) {
    log("rollback falló: " + err.message);
    writeStatus("failed", "No se pudo restaurar la versión anterior");
    return;
  }

  startApp();
  const restored = await waitHealthy(cfg.fromVersion, ROLLBACK_TIMEOUT);
  if (restored) {
    log("rollback verificado: " + restored.version);
    writeStatus("rolled_back", "Se restauró la versión anterior");
  } else {
    log("la versión anterior tampoco respondió");
    writeStatus("failed", "La aplicación no responde después del rollback");
  }
}

main()
  .catch((err) => {
    log("error no controlado: " + (err && err.message));
    writeStatus("failed", "Error inesperado");
  })
  .finally(() => {
    try { fs.unlinkSync(configPath); } catch {}
  });

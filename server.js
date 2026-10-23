"use strict";
const env = require("./src/env");
env.load();
env.ensureSecret();

const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");

const { db, DB_PATH } = require("./src/db");
const backup = require("./src/backup");
const license = require("./src/license");
const updates = require("./src/updates");
const licenseMw = require("./src/middleware/license");

updates.onStartup();

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SALON_SECRET || "salon-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" },
  })
);

const APP_VERSION = updates.CURRENT_VERSION;

app.use("/static", express.static(path.join(__dirname, "public")));
app.use("/vendor/htmx", express.static(path.join(__dirname, "node_modules", "htmx.org", "dist")));

app.use((req, res, next) => {
  req.htmx = req.get("HX-Request") === "true";
  res.locals.user = req.session.user || null;
  res.locals.currentPath = req.path;
  res.locals.query = req.query;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.appVersion = APP_VERSION;
  res.locals.updateInfo = updates.getState();
  res.locals.mod = (p) => (p === "/" || req.path === p || req.path.startsWith(p + "/") ? "active" : "");
  next();
});

app.use("/setup", require("./src/routes/setup"));
app.use("/perfil", require("./src/routes/profile"));

app.get("/health", (_req, res) => res.json({ ok: true, version: APP_VERSION }));

if (!license.DEV_SKIP) {
  app.use(licenseMw.requireActivated);
}

app.use("/", require("./src/routes/auth"));
app.use("/", require("./src/routes/dashboard"));
app.use("/clientes", require("./src/routes/clients"));
app.use("/personal", require("./src/routes/staff"));
app.use("/servicios", require("./src/routes/services"));
app.use("/productos", require("./src/routes/products"));
app.use("/citas", require("./src/routes/appointments"));
app.use("/ventas", require("./src/routes/sales"));
app.use("/caja", require("./src/routes/cash"));
app.use("/reportes", require("./src/routes/reports"));
app.use("/updates", require("./src/routes/updates"));

app.use((req, res) => res.status(404).render("error", { title: "No encontrado", message: "Página no encontrada" }));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render("error", { title: "Error", message: "Ocurrió un error: " + err.message });
});

const HOST = process.env.HOST || "127.0.0.1";
const PREFERRED_PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.dirname(DB_PATH);
const PORT_FILE = path.join(DATA_DIR, "port.txt");
const PID_FILE = path.join(DATA_DIR, "server.pid");

function writePort(port) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PORT_FILE, String(port), "utf8");
    fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
  } catch {}
}

function startJobs() {
  const check = () =>
    license
      .revalidate()
      .then((r) => console.log("[licencia]", JSON.stringify(r)))
      .catch((e) => console.error("[licencia]", e.message));
  const first = setTimeout(check, 15000);
  if (first.unref) first.unref();
  const daily = setInterval(check, 24 * 60 * 60 * 1000);
  if (daily.unref) daily.unref();
  backup.startDailyBackup();
  updates.startScheduler();
}

function listen(port, attempts) {
  const server = app.listen(port, HOST);
  let settled = false;
  server.on("listening", () => {
    settled = true;
    const actual = server.address().port;
    writePort(actual);
    console.log(`Salon app en http://${HOST}:${actual}`);
    startJobs();
  });
  server.on("error", (err) => {
    if (settled) return console.error(err);
    if (err.code === "EADDRINUSE" && attempts > 0) {
      console.warn(`[puerto] ${port} ocupado, probando ${port + 1}`);
      return listen(port + 1, attempts - 1);
    }
    console.error(err);
    process.exit(1);
  });
  return server;
}

const server = listen(PREFERRED_PORT, 10);

function shutdown() {
  try { fs.unlinkSync(PID_FILE); } catch {}
  try { server.close(); } catch {}
  try { db.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.LICENSE_DATA_DIR || path.join(__dirname, "data");
const LICENSE_DB = path.join(DATA_DIR, "licenses.sqlite");

const PLANS = {
  starter: { staff_max: 4 },
  pro: { staff_max: 10 },
  enterprise: { staff_max: 0 },
};

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const args = argv.filter((a) => a !== "--json");
const [cmd, ...rest] = args;

if (!fs.existsSync(LICENSE_DB)) {
  console.error("No existe " + LICENSE_DB + ". Inicia el servidor una vez (node index.js) para crear el esquema.");
  process.exit(1);
}

const db = new Database(LICENSE_DB);
db.pragma("journal_mode = WAL");

function out(value, text) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(text);
}

function usage() {
  console.log([
    "Uso: node admin.js <comando> [opciones] [--json]",
    "",
    "  create <starter|pro|enterprise> [email]   Crea una licencia pre-emitida",
    "  list [limite]                             Lista licencias y activaciones activas",
    "  show <key>                                Detalle de una licencia",
    "  revoke <hwid>                             Revoca la activación de un equipo",
    "  reactivate <hwid>                         Reactiva un equipo revocado",
    "  events [limite]                           Últimos eventos de auditoría",
    "",
    "Datos: " + LICENSE_DB,
  ].join("\n"));
}

if (cmd === "create") {
  const plan = String(rest[0] || "starter").toLowerCase();
  const email = String(rest[1] || "").trim();
  if (!PLANS[plan]) {
    console.error("Plan inválido. Usa starter, pro o enterprise.");
    process.exit(1);
  }
  const key = crypto.randomUUID();
  db.prepare("INSERT INTO licenses (key, plan, staff_max, cliente_email) VALUES (?,?,?,?)").run(
    key, plan, PLANS[plan].staff_max, email || null
  );
  out(
    { ok: true, license: { key, plan, staff_max: PLANS[plan].staff_max, cliente_email: email || null } },
    ["Licencia creada:", "  key: " + key, "  plan: " + plan + " (staff_max=" + PLANS[plan].staff_max + ")", "  cliente: " + (email || "(sin asignar)")].join("\n")
  );
} else if (cmd === "list") {
  const limit = Math.min(500, Math.max(1, Number(rest[0]) || 100));
  const rows = db.prepare(`
    SELECT l.key, l.plan, l.staff_max, l.cliente_email, l.issued_count, l.created_at,
      (SELECT COUNT(*) FROM activations a WHERE a.license_key=l.key AND a.revoked=0) AS active_activations
    FROM licenses l ORDER BY l.created_at DESC, l.key LIMIT ?
  `).all(limit);
  out({ ok: true, licenses: rows }, rows.length === 0 ? "Sin licencias." : rows.map((r) =>
    [r.key, r.plan, "staff=" + r.staff_max, "activas=" + r.active_activations, r.cliente_email || "-", r.created_at].join("  ")
  ).join("\n"));
} else if (cmd === "show") {
  const key = String(rest[0] || "").trim().toLowerCase();
  const license = db.prepare("SELECT * FROM licenses WHERE key=?").get(key);
  if (!license) {
    console.error("Licencia no encontrada.");
    process.exit(1);
  }
  const activations = db.prepare(
    "SELECT id, hwid, salon, cliente_email, issued_at, expires_at, revoked, revoked_at, last_seen_at FROM activations WHERE license_key=? ORDER BY issued_at DESC"
  ).all(key);
  out({ ok: true, license, activations }, JSON.stringify({ license, activations }, null, 2));
} else if (cmd === "revoke") {
  const hwid = String(rest[0] || "").trim();
  const row = db.prepare("SELECT * FROM activations WHERE hwid=? AND revoked=0").get(hwid);
  if (!row) {
    console.error("No hay activación activa para ese HWID.");
    process.exit(1);
  }
  db.prepare("UPDATE activations SET revoked=1, revoked_at=datetime('now') WHERE id=?").run(row.id);
  out({ ok: true, revoked: hwid }, "Revocado: " + hwid);
} else if (cmd === "reactivate") {
  const hwid = String(rest[0] || "").trim();
  const row = db.prepare("SELECT * FROM activations WHERE hwid=?").get(hwid);
  if (!row) {
    console.error("HWID no encontrado.");
    process.exit(1);
  }
  db.prepare("UPDATE activations SET revoked=0, revoked_at=NULL, last_seen_at=datetime('now') WHERE id=?").run(row.id);
  out({ ok: true, reactivated: hwid }, "Reactivado: " + hwid);
} else if (cmd === "events") {
  const limit = Math.min(500, Math.max(1, Number(rest[0]) || 50));
  const rows = db.prepare("SELECT id, type, license_key, hwid, ip, detail, created_at FROM events ORDER BY id DESC LIMIT ?").all(limit);
  out({ ok: true, events: rows }, rows.map((r) =>
    [r.created_at, r.type, r.license_key || "-", r.hwid || "-", r.detail || ""].join("  ")
  ).join("\n") || "Sin eventos.");
} else {
  usage();
  process.exit(cmd ? 1 : 0);
}

db.close();

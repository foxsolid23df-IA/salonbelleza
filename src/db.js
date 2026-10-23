"use strict";
require("./env").load();
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DB_PATH = process.env.SALON_DB || path.join(__dirname, "..", "data", "salon.db");
require("fs").mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','caja','estilista')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name1 TEXT NOT NULL DEFAULT '',
  last_name2 TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  instagram TEXT NOT NULL DEFAULT '',
  credit_balance REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT 'Estilista',
  phone TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#3b82f6',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS service_families (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  family_id INTEGER REFERENCES service_families(id),
  price REAL NOT NULL DEFAULT 0,
  duration_min INTEGER NOT NULL DEFAULT 30,
  color TEXT NOT NULL DEFAULT '#8b5cf6',
  tax_rate REAL NOT NULL DEFAULT 0.16,
  cost REAL NOT NULL DEFAULT 0,
  bookable INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  supplier TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'retail' CHECK (kind IN ('retail','technical')),
  cost REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  stock REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS product_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty_delta REAL NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  date TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','confirmed','in_service','done','cancelled','no_show')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointment_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id),
  staff_id INTEGER REFERENCES staff(id),
  price REAL NOT NULL DEFAULT 0,
  duration_min INTEGER NOT NULL DEFAULT 30
);

CREATE TABLE IF NOT EXISTS cash_registers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  opening_amount REAL NOT NULL DEFAULT 0,
  opened_by INTEGER REFERENCES users(id),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  closing_amount REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL,
  client_id INTEGER REFERENCES clients(id),
  appointment_id INTEGER REFERENCES appointments(id),
  register_id INTEGER REFERENCES cash_registers(id),
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','paid','cancelled')),
  subtotal REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'MXN',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_number ON tickets(number);

CREATE TABLE IF NOT EXISTS ticket_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('service','product')),
  ref_id INTEGER,
  name TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  price REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0.16,
  staff_id INTEGER REFERENCES staff(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('cash','transfer','card','credit','gift','other')),
  amount REAL NOT NULL,
  bank TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  concept TEXT NOT NULL,
  amount REAL NOT NULL,
  category TEXT NOT NULL DEFAULT 'varios',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS license_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT NOT NULL,
  hwid TEXT NOT NULL,
  salon TEXT,
  cliente_email TEXT,
  plan TEXT,
  staff_max INTEGER,
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS gift_certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  client_id INTEGER REFERENCES clients(id),
  staff_id INTEGER REFERENCES staff(id),
  amount REAL NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

const migrations = [
  ["users", "active", "ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1"],
  ["users", "force_change", "ALTER TABLE users ADD COLUMN force_change INTEGER NOT NULL DEFAULT 1"],
  ["license_tokens", "revoked", "ALTER TABLE license_tokens ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0"],
];
for (const [table, column, sql] of migrations) {
  if (!columnExists(table, column)) db.exec(sql);
}

const CONFIG = {
  get(key, fallback) {
    const row = db.prepare("SELECT value FROM config WHERE key=?").get(key);
    return row ? row.value : fallback;
  },
  set(key, value) {
    db.prepare("INSERT INTO config(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));
    return CONFIG.get(key);
  },
};
module.exports.CONFIG = CONFIG;

const APP_SCHEMA_VERSION = "3";
if (CONFIG.get("schema_version") !== APP_SCHEMA_VERSION) CONFIG.set("schema_version", APP_SCHEMA_VERSION);

function nowISO(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  return d.toISOString().replace("T", " ").slice(0, 19);
}
function daysFromNow(n) { const d = new Date(); d.setDate(d.getDate() + n); return nowISO(d); }

const hasSeed = db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0;
if (!hasSeed) {
  db.prepare(
    "INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'admin')"
  ).run("admin@salon.local", hashPassword("admin123"), "Administrador");

  db.prepare("INSERT INTO clients (first_name, last_name1, phone, email) VALUES (?,?,?,?)").run(
    "Público", "General", "", ""
  );

  const staffRows = [
    ["Ana López", "Estilista", "#3b82f6"],
    ["María García", "Manicurista", "#10b981"],
    ["Sofía Ruiz", "Estilista", "#f59e0b"],
  ];
  const insStaff = db.prepare("INSERT INTO staff (name, position, color, sort) VALUES (?,?,?,?)");
  staffRows.forEach((r, i) => insStaff.run(r[0], r[1], r[2], i));

  const fams = ["Corte", "Color", "Manos y Pies", "Tratamientos", "Peinado"];
  const insFam = db.prepare("INSERT INTO service_families (name) VALUES (?)");
  fams.forEach((f) => insFam.run(f));
  const famId = (name) => db.prepare("SELECT id FROM service_families WHERE name=?").get(name).id;

  const services = [
    ["Corte de caballero", "Corte", 250, 30, "#3b82f6"],
    ["Corte de dama", "Corte", 380, 45, "#6366f1"],
    ["Lavado y peinado", "Peinado", 200, 30, "#8b5cf6"],
    ["Color completo", "Color", 950, 120, "#ec4899"],
    ["Retoque de raíz", "Color", 650, 90, "#f43f5e"],
    ["Manicure básica", "Manos y Pies", 250, 40, "#10b981"],
    ["Pedicure spa", "Manos y Pies", 320, 50, "#14b8a6"],
    ["Tratamiento capilar", "Tratamientos", 550, 60, "#f59e0b"],
  ];
  const insSvc = db.prepare(
    "INSERT INTO services (name, family_id, price, duration_min, color) VALUES (?,?,?,?,?)"
  );
  services.forEach((s) => insSvc.run(s[0], famId(s[1]), s[2], s[3], s[4]));

  const products = [
    ["Shampoo hidratante 1L", "SH-100", "Distribuidora Uno", "MarcaA", "technical", 180, 0, 8],
    ["Mascarilla reparadora", "MS-200", "Distribuidora Uno", "MarcaA", "technical", 220, 0, 5],
    ["Crema para peinar 500ml", "CP-300", "Belleza SA", "MarcaB", "retail", 150, 320, 12],
    ["Esmalte gel rojo", "EG-400", "Nails Supply", "MarcaC", "technical", 60, 0, 20],
    ["Aceite de cutículas", "AC-500", "Nails Supply", "MarcaC", "retail", 45, 120, 15],
  ];
  const insProd = db.prepare(
    "INSERT INTO products (name, code, supplier, brand, kind, cost, price, stock) VALUES (?,?,?,?,?,?,?,?)"
  );
  products.forEach((p) => insProd.run(...p));
}

function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function nextTicketNumber() {
  const row = db.prepare("SELECT COALESCE(MAX(number),0)+1 AS n FROM tickets").get();
  return row.n;
}

function recalcTicket(ticketId) {
  const lines = db.prepare("SELECT qty, price, tax_rate FROM ticket_lines WHERE ticket_id=?").all(ticketId);
  let subtotal = 0, tax = 0;
  for (const l of lines) {
    const line = r2(l.qty * l.price);
    subtotal += line;
    tax += r2(line * (l.tax_rate || 0));
  }
  subtotal = r2(subtotal); tax = r2(tax);
  db.prepare("UPDATE tickets SET subtotal=?, tax_total=?, total=? WHERE id=?").run(subtotal, tax, r2(subtotal + tax), ticketId);
  return { subtotal, tax_total: tax, total: r2(subtotal + tax) };
}

module.exports = { db, hashPassword, verifyPassword, r2, nextTicketNumber, recalcTicket, CONFIG, nowISO, daysFromNow, DB_PATH };

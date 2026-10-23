"use strict";
const fs = require("fs");
const path = require("path");
const { createClient } = require("@libsql/client");

const DATA_DIR = process.env.LICENSE_DATA_DIR || path.join(__dirname, "data");
const LICENSE_DB = path.join(DATA_DIR, "licenses.sqlite");
const DB_URL = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || process.env.DATABASE_URL || "file:" + LICENSE_DB.replace(/\\/g, "/");
const AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || undefined;
const REMOTE = /^(libsql|https?|wss?):/i.test(DB_URL);

if (process.env.VERCEL_ENV === "production" && !REMOTE) {
  throw new Error("Configura TURSO_DATABASE_URL y TURSO_AUTH_TOKEN en Vercel");
}
if (!REMOTE) fs.mkdirSync(path.dirname(LICENSE_DB), { recursive: true });

const client = createClient({ url: DB_URL, authToken: AUTH_TOKEN, intMode: "number" });

const schema = [
  `CREATE TABLE IF NOT EXISTS licenses (
    key TEXT PRIMARY KEY,
    plan TEXT NOT NULL DEFAULT 'starter',
    staff_max INTEGER NOT NULL DEFAULT 4,
    cliente_email TEXT,
    issued_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS activations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    license_key TEXT NOT NULL REFERENCES licenses(key),
    hwid TEXT NOT NULL,
    salon TEXT,
    cliente_email TEXT,
    token TEXT NOT NULL,
    issued_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    revoked_at TEXT,
    last_seen_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_activations_hwid ON activations(hwid)`,
  `CREATE INDEX IF NOT EXISTS idx_activations_key ON activations(license_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_activations_active_key ON activations(license_key) WHERE revoked=0`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    license_key TEXT,
    hwid TEXT,
    ip TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at)`,
  `CREATE TABLE IF NOT EXISTS updates (
    channel TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    url TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    notes TEXT,
    min_version TEXT,
    published_at TEXT NOT NULL
  )`,
];

async function addColumn(table, column, ddl) {
  const result = await client.execute("PRAGMA table_info(" + table + ")");
  if (!result.rows.some((row) => row.name === column)) {
    await client.execute("ALTER TABLE " + table + " ADD COLUMN " + ddl);
  }
}

async function init() {
  await client.batch(schema, "write");
  try {
    await client.execute("PRAGMA foreign_keys = ON");
  } catch {}
  await addColumn("licenses", "cliente_email", "cliente_email TEXT");
  await addColumn("activations", "revoked_at", "revoked_at TEXT");
  await addColumn("activations", "last_seen_at", "last_seen_at TEXT");
  return client;
}

let readyPromise = null;

function ready() {
  if (!readyPromise) readyPromise = init();
  return readyPromise;
}

async function get(sql, args = []) {
  await ready();
  const result = await client.execute({ sql, args });
  return result.rows[0] || null;
}

async function all(sql, args = []) {
  await ready();
  const result = await client.execute({ sql, args });
  return result.rows;
}

async function run(sql, args = []) {
  await ready();
  return client.execute({ sql, args });
}

async function batch(statements, mode = "write") {
  await ready();
  return client.batch(statements, mode);
}

function close() {
  try { client.close(); } catch {}
}

module.exports = { ready, get, all, run, batch, close, DB_URL, LICENSE_DB, REMOTE };

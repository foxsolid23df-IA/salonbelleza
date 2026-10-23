"use strict";
const fs = require("fs");
const path = require("path");
const { db, DB_PATH } = require("./db");

const BACKUP_DIR = path.join(path.dirname(DB_PATH), "backups");
const KEEP = Number(process.env.SALON_BACKUP_KEEP || 14);
const DAY_MS = 24 * 60 * 60 * 1000;

function stamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function prune() {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^salon-\d{8}.*\.db$/.test(f)).sort();
    while (files.length > KEEP) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch {}
    }
  } catch {}
}

async function runBackup({ force = false } = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, force ? `salon-${stamp()}-${Date.now()}.db` : `salon-${stamp()}.db`);
  if (!force && fs.existsSync(file)) return { ok: true, file, skipped: true };
  await db.backup(file);
  prune();
  return { ok: true, file, skipped: false };
}

function startDailyBackup() {
  const run = () => runBackup().catch((e) => console.error("[backup]", e.message));
  const first = setTimeout(run, 20000);
  const daily = setInterval(run, DAY_MS);
  if (first.unref) first.unref();
  if (daily.unref) daily.unref();
}

module.exports = { runBackup, startDailyBackup, BACKUP_DIR };

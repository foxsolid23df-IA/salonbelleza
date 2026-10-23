"use strict";
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.LICENSE_DATA_DIR || path.join(__dirname, "data");
const LICENSE_DB = path.join(DATA_DIR, "licenses.sqlite");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const KEEP = Math.max(1, Number(process.env.LICENSE_BACKUP_KEEP || 14));

async function main() {
  if (!fs.existsSync(LICENSE_DB)) {
    console.error("No existe " + LICENSE_DB);
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dest = path.join(BACKUP_DIR, "licenses-" + stamp + ".sqlite");
  const db = new Database(LICENSE_DB, { readonly: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
  console.log("backup: " + dest);

  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^licenses-\d{8}-\d{6}\.sqlite$/.test(f))
    .sort()
    .reverse();
  for (const old of files.slice(KEEP)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch {}
  }
  console.log("copias conservadas: " + Math.min(files.length, KEEP));

  const priv = path.join(DATA_DIR, "keys", "private.pem");
  console.log("IMPORTANTE: respalda " + priv + " cifrado y fuera del servidor.");
}

main().catch((err) => {
  console.error("backup falló:", err.message);
  process.exit(1);
});

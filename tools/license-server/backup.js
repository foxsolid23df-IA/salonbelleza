"use strict";
const fs = require("fs");
const path = require("path");
const db = require("./db");

const DATA_DIR = process.env.LICENSE_DATA_DIR || path.join(__dirname, "data");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const KEEP = Math.max(1, Number(process.env.LICENSE_BACKUP_KEEP || 14));

async function main() {
  await db.ready();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dest = path.join(BACKUP_DIR, "licenses-" + stamp + ".json");
  const payload = {
    exported_at: new Date().toISOString(),
    source: db.REMOTE ? "turso" : "local",
    licenses: await db.all("SELECT * FROM licenses ORDER BY created_at"),
    activations: await db.all("SELECT * FROM activations ORDER BY id"),
    events: await db.all("SELECT * FROM events ORDER BY id"),
    updates: await db.all("SELECT * FROM updates ORDER BY channel"),
  };
  fs.writeFileSync(dest, JSON.stringify(payload, null, 2), "utf8");
  console.log("backup: " + dest);

  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^licenses-\d{8}-\d{6}\.json$/.test(f))
    .sort()
    .reverse();
  for (const old of files.slice(KEEP)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch {}
  }
  console.log("copias conservadas: " + Math.min(files.length, KEEP));
  if (!process.env.LICENSE_PRIVATE_KEY_PEM) {
    console.log("IMPORTANTE: respalda " + path.join(DATA_DIR, "keys", "private.pem") + " cifrado y fuera del servidor.");
  }
}

main()
  .catch((err) => {
    console.error("backup falló:", err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());

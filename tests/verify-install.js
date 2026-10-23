const Database = require("better-sqlite3");
const file = process.argv[2];
if (!file) {
  console.error("uso: node tests/verify-install.js <ruta\\salon.db>");
  process.exit(1);
}
const db = new Database(file, { readonly: true });
const cols = db.prepare("PRAGMA table_info(clients)").all().map((c) => c.name);
const count = (t) => db.prepare("SELECT COUNT(*) AS n FROM " + t).get().n;
const nameCol = cols.includes("name") ? "name" : cols.includes("first_name") ? "first_name" : null;console.log("columnas clients:", cols.join(","));
console.log("staff=" + count("staff"), "services=" + count("services"), "clients=" + count("clients"));
if (nameCol) {
  const marker = db.prepare("SELECT COUNT(*) AS n FROM clients WHERE " + nameCol + " LIKE 'Marcador%'").get().n;
  console.log("marcador=" + marker);
}
console.log("config:", db.prepare("SELECT key,value FROM config WHERE key IN ('schema_version','salon')").all());
db.close();

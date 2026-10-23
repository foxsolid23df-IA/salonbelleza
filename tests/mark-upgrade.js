const Database = require("better-sqlite3");
const file = process.argv[2];
const db = new Database(file);
db.prepare("INSERT INTO clients (first_name, phone) VALUES ('Marcador Upgrade', '555')").run();
console.log("cliente marcador insertado");
db.close();

"use strict";
process.env.LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL || "http://localhost:4000";
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const BASE = "http://127.0.0.1:3000";
const ADMIN = process.env.LICENSE_ADMIN_TOKEN || "dev-admin-token";
const results = [];
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? "OK  " : "FALLA"} ${name}${extra ? " | " + extra : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status < 500) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

function cookieFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie()[0] : res.headers.get("set-cookie");
  return raw ? raw.split(";")[0] : "";
}

(async () => {
  ok("servidor app responde", await waitServer(BASE + "/setup"));
  ok("servidor licencias responde", await waitServer("http://localhost:4000/health"));

  const envText = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  ok("SALON_SECRET persistido en .env", /^SALON_SECRET=[0-9a-f]{64}$/m.test(envText));

  const port = fs.readFileSync(path.join(ROOT, "data", "port.txt"), "utf8").trim();
  ok("puerto real escrito", port === "3000", `port=${port}`);

  const hwidRes = await fetch(BASE + "/setup/hwid");
  const { hwid } = await hwidRes.json();
  ok("hwid disponible", /^[0-9a-f]{64}$/.test(hwid), hwid.slice(0, 12) + "...");

  const create = await fetch("http://localhost:4000/admin/licenses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + ADMIN },
    body: JSON.stringify({ plan: "pro", cliente_email: "dueno@rossa.com" }),
  });
  const created = await create.json();
  const licenseKey = created && created.license && created.license.key;
  ok("licencia de prueba creada", create.status === 201 && !!licenseKey, create.status + " " + (created.error || ""));
  if (!licenseKey) throw new Error("No se pudo crear la licencia; revisa LICENSE_ADMIN_TOKEN del servidor");

  const act = await fetch(BASE + "/setup/activar", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ license_key: licenseKey, salon: "Rossa", cliente_email: "dueno@rossa.com" }),
    redirect: "manual",
  });
  ok("activación redirige a /setup/inicio", act.status === 302 && act.headers.get("location") === "/setup/inicio", `${act.status} ${act.headers.get("location")}`);

  const license = require(path.join(ROOT, "src", "license"));
  const first = await license.revalidate();
  ok("revalidación online OK", first.ok === true, JSON.stringify(first));

  const db = new Database(path.join(ROOT, "data", "salon.db"));
  const status = db.prepare("SELECT value FROM config WHERE key='license_status'").get();
  ok("config license_status=active", status && status.value === "active", JSON.stringify(status));

  const backup = require(path.join(ROOT, "src", "backup"));
  const b = await backup.runBackup({ force: true });
  const copy = new Database(b.file, { readonly: true });
  const users = copy.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  copy.close();
  ok("backup creado y legible", fs.existsSync(b.file) && users > 0, `${path.basename(b.file)} users=${users}`);
  const files = fs.readdirSync(path.join(ROOT, "data", "backups"));
  ok("backup único por día", files.length >= 1, files.join(","));

  const rev = await fetch("http://localhost:4000/revoke", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + ADMIN },
    body: JSON.stringify({ hwid }),
  });
  ok("revocación en servidor", rev.ok, String(rev.status));

  const second = await license.revalidate();
  ok("revalidación detecta revocación", second.ok === false && second.reason === "revoked", JSON.stringify(second));

  const blocked = await fetch(BASE + "/", { redirect: "manual" });
  ok("acceso bloqueado a /setup?err=revoked", blocked.status === 302 && String(blocked.headers.get("location")).includes("err=revoked"), `${blocked.status} ${blocked.headers.get("location")}`);

  const page = await fetch(BASE + "/setup?err=revoked");
  const html = await page.text();
  ok("wizard muestra mensaje de desactivación", page.status === 200 && /desactivada por soporte/i.test(html));

  const re = await fetch(BASE + "/setup/activar", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ license_key: licenseKey, salon: "Rossa", cliente_email: "dueno@rossa.com" }),
    redirect: "manual",
  });
  ok("reactivación permitida", re.status === 302 && re.headers.get("location") === "/setup/inicio", `${re.status} ${re.headers.get("location")}`);

  const third = await license.revalidate();
  ok("revalidación tras reactivar", third.ok === true, JSON.stringify(third));
  const unblocked = await fetch(BASE + "/", { redirect: "manual" });
  ok("acceso restablecido", unblocked.status === 302 && String(unblocked.headers.get("location")) === "/login", `${unblocked.status} ${unblocked.headers.get("location")}`);

  const login = await fetch(BASE + "/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "dueno@rossa.com", password: "admin123" }),
    redirect: "manual",
  });
  const cookie = cookieFrom(login);
  ok("login fuerza cambio de contraseña", login.status === 302 && String(login.headers.get("location")).startsWith("/perfil"), `${login.status} ${login.headers.get("location")}`);

  const dash = await fetch(BASE + "/perfil", { headers: { cookie }, redirect: "manual" });
  ok("perfil accesible con sesión", dash.status === 200, String(dash.status));

  const pass = await fetch(BASE + "/perfil/password", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ current: "admin123", next: "ClaveFase0x9", confirm: "ClaveFase0x9" }),
    redirect: "manual",
  });
  ok("cambio de contraseña redirige a /perfil", pass.status === 302 && pass.headers.get("location") === "/perfil", `${pass.status} ${pass.headers.get("location")}`);

  db.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\nRESUMEN: ${results.length - failed.length}/${results.length} OK`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("ERROR:", e);
  process.exit(2);
});


"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const PORT = 43000 + Math.floor(Math.random() * 900);
const BASE = "http://127.0.0.1:" + PORT;
const ADMIN = "test-admin-token";
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "salon-license-"));
const HWID_A = "a".repeat(64);
const HWID_B = "b".repeat(64);

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: "127.0.0.1",
  LICENSE_DATA_DIR: DATA_DIR,
  LICENSE_ADMIN_TOKEN: ADMIN,
  LICENSE_SEED_DEMO: "1",
  LICENSE_ALLOW_SELF_ACTIVATION: "0",
  LICENSE_RL_ACTIVATE: "100",
  LICENSE_RL_VERIFY: "4",
  LICENSE_RL_ADMIN: "100",
};

let logs = "";
const child = spawn(process.execPath, [path.join(__dirname, "index.js")], {
  cwd: __dirname,
  env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout.on("data", (d) => { logs += d.toString(); });
child.stderr.on("data", (d) => { logs += d.toString(); });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error("el servidor terminó antes de iniciar");
    try {
      const res = await fetch(BASE + "/health");
      if (res.ok) return;
    } catch {}
    await sleep(150);
  }
  throw new Error("timeout esperando /health");
}

async function call(method, route, body, headers) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}

function auth() {
  return { authorization: "Bearer " + ADMIN };
}

async function main() {
  await waitReady();

  const health = await call("GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);

  const noAuth = await call("GET", "/admin/licenses");
  assert.equal(noAuth.status, 401);

  const created = await call("POST", "/admin/licenses", { plan: "pro", cliente_email: "cliente@demo.com" }, auth());
  assert.equal(created.status, 201);
  const licenseKey = created.data.license.key;
  assert.match(licenseKey, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(created.data.license.staff_max, 10);

  const unknownKey = crypto.randomUUID();
  const unknown = await call("POST", "/activate", { license_key: unknownKey, hwid: HWID_A });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.error, "LICENSE_NOT_FOUND");

  let list = await call("GET", "/admin/licenses", null, auth());
  assert.equal(list.status, 200);
  assert.ok(!list.data.licenses.some((l) => l.key === unknownKey));
  const before = list.data.licenses.find((l) => l.key === licenseKey);
  assert.ok(before);
  assert.equal(before.issued_count, 0);

  const first = await call("POST", "/activate", {
    license_key: licenseKey, hwid: HWID_A, salon: "Salón Demo", cliente_email: "cliente@demo.com",
  });
  assert.equal(first.status, 200);
  assert.ok(first.data.token);
  assert.equal(first.data.plan, "pro");
  assert.equal(first.data.staff_max, 10);
  assert.ok(first.data.public_key.includes("BEGIN PUBLIC KEY"));

  const again = await call("POST", "/activate", { license_key: licenseKey, hwid: HWID_A, salon: "Salón Demo" });
  assert.equal(again.status, 200);
  assert.notEqual(again.data.token, first.data.token);

  list = await call("GET", "/admin/licenses", null, auth());
  const afterActivate = list.data.licenses.find((l) => l.key === licenseKey);
  assert.equal(afterActivate.issued_count, 1);
  assert.equal(afterActivate.active_activations, 1);

  const other = await call("POST", "/activate", { license_key: licenseKey, hwid: HWID_B });
  assert.equal(other.status, 409);
  assert.equal(other.data.error, "ACTIVATION_LIMIT");

  const verified = await call("POST", "/verify", { token: again.data.token, hwid: HWID_A });
  assert.equal(verified.status, 200);
  assert.ok(verified.data.token);
  assert.notEqual(verified.data.token, again.data.token);
  assert.ok(new Date(verified.data.expires_at).getTime() > Date.now());

  const mismatch = await call("POST", "/verify", { token: verified.data.token, hwid: HWID_B });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.data.reason, "hwid_mismatch");

  const revokeNoAuth = await call("POST", "/revoke", { hwid: HWID_A });
  assert.equal(revokeNoAuth.status, 401);

  const revoked = await call("POST", "/admin/revoke", { hwid: HWID_A }, { "x-admin-token": ADMIN });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.data.revoked, true);

  const afterRevoke = await call("POST", "/verify", { token: verified.data.token, hwid: HWID_A });
  assert.equal(afterRevoke.status, 403);
  assert.equal(afterRevoke.data.reason, "revoked");

  const reactivated = await call("POST", "/admin/reactivate", { hwid: HWID_A }, auth());
  assert.equal(reactivated.status, 200);

  const afterReactivate = await call("POST", "/verify", { token: verified.data.token, hwid: HWID_A });
  assert.equal(afterReactivate.status, 200);
  assert.ok(afterReactivate.data.token);

  const limited = await call("POST", "/verify", { token: afterReactivate.data.token, hwid: HWID_A });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error, "RATE_LIMIT");

  const detail = await call("GET", "/admin/licenses/" + licenseKey, null, auth());
  assert.equal(detail.status, 200);
  assert.equal(detail.data.activations.length, 1);
  assert.equal(detail.data.activations[0].revoked, 0);
  assert.ok(detail.data.activations[0].last_seen_at);

  const events = await call("GET", "/admin/events?limit=50", null, auth());
  assert.equal(events.status, 200);
  const types = events.data.events.map((e) => e.type);
  for (const type of ["admin_create", "activate", "activate_denied", "admin_revoke", "admin_reactivate"]) {
    assert.ok(types.includes(type), "falta evento " + type);
  }

  const cli = spawnSync(process.execPath, [path.join(__dirname, "admin.js"), "list", "--json"], {
    cwd: __dirname,
    env: { ...process.env, LICENSE_DATA_DIR: DATA_DIR },
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr);
  const cliData = JSON.parse(cli.stdout);
  assert.ok(cliData.licenses.some((l) => l.key === licenseKey));

  const backup = spawnSync(process.execPath, [path.join(__dirname, "backup.js")], {
    cwd: __dirname,
    env: { ...process.env, LICENSE_DATA_DIR: DATA_DIR, LICENSE_BACKUP_KEEP: "3" },
    encoding: "utf8",
  });
  assert.equal(backup.status, 0, backup.stderr);
  const backups = fs.readdirSync(path.join(DATA_DIR, "backups"));
  assert.equal(backups.length, 1);

  console.log("PASS Fase 3: 30 comprobaciones de servidor, admin, revocación, rate-limit, CLI y backup");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    console.error("--- logs del servidor ---");
    console.error(logs);
    process.exitCode = 1;
  })
  .finally(() => {
    try { child.kill(); } catch {}
    setTimeout(() => {
      try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    }, 300);
  });

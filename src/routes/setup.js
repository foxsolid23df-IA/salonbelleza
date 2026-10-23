"use strict";
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const express = require("express");
const { db, CONFIG, hashPassword } = require("../db");
const license = require("../license");

const router = express.Router();
const LICENSE_DIR = path.join(__dirname, "..", "..", ".license");
try { fs.mkdirSync(LICENSE_DIR, { recursive: true }); } catch {}

router.get("/", (req, res) => {
  const state = license.activationState();
  if (state.activated) return res.redirect("/");
  const existing = license.loadTokenFile();
  const messages = {
    revoked: "Esta licencia fue desactivada por soporte. Ingresa una licencia nueva para continuar.",
    expired: "La licencia expiró y el período de gracia terminó. Renueva tu licencia para continuar.",
    hwid_mismatch: "La licencia pertenece a otro equipo. Solicita una licencia para este equipo.",
    reactivar: "La licencia debe reactivarse en este equipo. Ingresa tu clave de licencia.",
  };
  res.render("setup/license", { title: "Activación", error: messages[req.query.err] || req.query.err, existing: !!existing });
});

router.get("/hwid", (req, res) => {
  res.json({ hwid: license.getHwid() });
});

router.post("/activar", async (req, res) => {
  try {
    const key = String(req.body.license_key || "").trim().toLowerCase();
    const salon = String(req.body.salon || "").trim();
    const clienteEmail = String(req.body.cliente_email || "").trim();

    if (!license.validateLicenseKey(key)) {
      return res.render("setup/license", { title: "Activación", error: "Formato de licencia inválido (debe ser UUID v4)." });
    }

    const hwid = license.getHwid();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    let resp;
    try {
      resp = await fetch(license.LICENSE_SERVER + "/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ license_key: key, hwid, salon: salon || undefined, cliente_email: clienteEmail || undefined }),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      return res.render("setup/license", {
        title: "Activación", error: "No se pudo contactar el servidor de licencias. Verifica tu conexión o usa SALON_DEV_SKIP_LICENSE=1.",
      });
    } finally {
      clearTimeout(timeout);
    }

    const payload = await resp.json();
    if (!resp.ok || !payload.ok) {
      const msg = payload && (payload.error || payload.message) || "Activación fallida";
      return res.render("setup/license", { title: "Activación", error: msg });
    }

    if (payload.token) {
      const pemFile = path.join(LICENSE_DIR, "public_key.pem");
      try { require("fs").writeFileSync(pemFile, payload.public_key); } catch {}
    }

    const expiresAt = payload.expires_at || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO license_tokens (license_key, hwid, salon, cliente_email, plan, staff_max, expires_at, revoked) VALUES (?,?,?,?,?,?,?,0)"
    ).run(key, hwid, payload.salon || salon || null, payload.cliente_email || clienteEmail || null, payload.plan || "starter", payload.staff_max || 4, expiresAt);

    license.persistActivation({
      token: payload.token,
      salon: payload.salon || salon || null,
      cliente_email: payload.cliente_email || clienteEmail || null,
      plan: payload.plan || "starter",
      staff_max: payload.staff_max || 4,
      expires_at: expiresAt,
      license_key: key,
    });

    CONFIG.set("salon", payload.salon || salon || "");
    CONFIG.set("cliente_email", payload.cliente_email || clienteEmail || "");
    CONFIG.set("plan", payload.plan || "starter");
    CONFIG.set("staff_max", payload.staff_max || 4);
    CONFIG.set("license_revoked", "0");
    CONFIG.set("license_force_setup", "0");
    CONFIG.set("license_status", "active");
    CONFIG.set("license_last_check", new Date().toISOString());
    db.prepare("UPDATE license_tokens SET revoked=0 WHERE hwid=?").run(hwid);

    const admin = db.prepare("SELECT * FROM users WHERE email=?").get(payload.cliente_email || clienteEmail || "admin@salon.local")
      || db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get();
    let seedPass = null;
    const targetEmail = payload.cliente_email || clienteEmail || (admin ? admin.email : "admin@salon.local");
    if (!admin) {
      seedPass = crypto.randomBytes(8).toString("base36").slice(0, 12);
      db.prepare("INSERT INTO users (email, password_hash, name, role, force_change) VALUES (?,?,?,?,1)").run(
        targetEmail, hashPassword(seedPass), "Administrador", "admin"
      );
      license.getHwid();
      require("fs").writeFileSync(path.join(LICENSE_DIR, "temp_password"), seedPass, "utf8");
    } else {
      db.prepare("UPDATE users SET force_change=1, email=? WHERE id=?").run(targetEmail, admin.id);
    }
    res.redirect("/setup/inicio");
  } catch (e) {
    console.error(e);
    res.render("setup/license", { title: "Activación", error: "Error interno. Intenta de nuevo." });
  }
});

router.get("/inicio", (req, res) => {
  const tempFile = path.join(LICENSE_DIR, "temp_password");
  let seedPass = null;
  try { if (fs.existsSync(tempFile)) seedPass = fs.readFileSync(tempFile, "utf8"); fs.unlinkSync(tempFile); } catch {}
  const cfg = { salon: CONFIG.get("salon"), cliente_email: CONFIG.get("cliente_email") };
  res.render("setup/inicio", { title: "¡Listo!", seedPass, email: cfg.cliente_email || "admin@salon.local", salon: cfg.salon || "Salón" });
});

module.exports = router;

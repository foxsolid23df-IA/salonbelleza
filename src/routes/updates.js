"use strict";
const fs = require("fs");
const path = require("path");
const express = require("express");
const updates = require("../updates");
const { requireRole } = require("../middleware");

const router = express.Router();
router.use(requireRole("admin"));

function statusFile() {
  try {
    const file = path.join(updates.INSTALL_ROOT, "logs", "update-status.json");
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function render(res, status, extra = {}) {
  res.render("updates/index", {
    title: "Actualizaciones",
    state: status,
    currentVersion: updates.CURRENT_VERSION,
    channel: updates.CHANNEL,
    installed: updates.isInstalled(),
    lastStatus: statusFile(),
    error: null,
    ...extra,
  });
}

router.get("/", async (req, res, next) => {
  try {
    let state = updates.getState();
    if (req.query.check === "1" || !state.lastCheck) state = await updates.check({ force: req.query.check === "1" });
    render(res, state);
  } catch (err) {
    next(err);
  }
});

router.post("/check", async (req, res, next) => {
  try {
    const state = await updates.check({ force: true });
    req.session.flash = state.available
      ? `Actualización ${state.version} disponible`
      : state.ok
        ? "No hay actualizaciones disponibles"
        : `No se pudo consultar: ${state.error}`;
    res.redirect("/updates");
  } catch (err) {
    next(err);
  }
});

router.post("/install", async (req, res, next) => {
  const state = updates.getState();
  try {
    if (!state.available) throw new Error("No hay una actualización disponible");
    if (!updates.isInstalled()) throw new Error("La instalación automática solo está disponible en una instalación de Windows");
    if (!state.url || !state.sha256) throw new Error("El manifiesto de actualización está incompleto");
    const downloaded = await updates.download(state);
    updates.install(state, downloaded.file);
    res.render("updates/installing", {
      title: "Actualizando",
      targetVersion: state.version,
      currentVersion: updates.CURRENT_VERSION,
    });
  } catch (err) {
    render(res, state, { error: err.message });
  }
});

module.exports = router;

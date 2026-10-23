"use strict";
const express = require("express");
const { db, hashPassword, verifyPassword } = require("../db");

const router = express.Router();

function mustLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

router.get("/", mustLogin, (req, res) => {
  res.render("profile", { title: "Perfil" });
});

router.post("/password", mustLogin, (req, res) => {
  const { current, next: np, confirm } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.session.user.id);
  if (!user || !verifyPassword(current, user.password_hash))
    return res.status(400).render("profile", { title: "Perfil", error: "ContraseÃ±a actual incorrecta" });
  if (String(np || "").length < 8)
    return res.status(400).render("profile", { title: "Perfil", error: "La nueva contraseÃ±a debe tener al menos 8 caracteres" });
  if (String(np) !== String(confirm || ""))
    return res.status(400).render("profile", { title: "Perfil", error: "Las contraseÃ±as no coinciden" });
  db.prepare("UPDATE users SET password_hash=?, force_change=0 WHERE id=?").run(hashPassword(np), user.id);
  req.session.flash = "ContraseÃ±a actualizada";
  res.redirect("/perfil");
});

module.exports = router;

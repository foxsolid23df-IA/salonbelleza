"use strict";
const express = require("express");
const { db, verifyPassword } = require("../db");

const router = express.Router();

router.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.render("login", { title: "Iniciar sesión", layout: false });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email=? AND active=1").get(String(email || "").trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ""), user.password_hash)) {
    return res.status(401).render("login", { title: "Iniciar sesión", layout: false, error: "Correo o contraseña incorrectos" });
  }
  req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role, forceChange: !!user.force_change };
  if (user.force_change) return res.redirect("/perfil#clave");
  res.redirect("/");
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;

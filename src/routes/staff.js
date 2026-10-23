"use strict";
const express = require("express");
const { db } = require("../db");
const { requireAuth } = require("../middleware");

const router = express.Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  const staff = db.prepare("SELECT * FROM staff ORDER BY sort, name").all();
  res.render("staff/list", { title: "Personal", staff });
});

router.get("/nuevo", (req, res) => res.render("staff/form", { title: "Nuevo miembro", member: null }));

router.get("/:id", (req, res) => {
  const member = db.prepare("SELECT * FROM staff WHERE id=?").get(req.params.id);
  if (!member) return res.status(404).render("error", { title: "Error", message: "Miembro no encontrado" });
  res.render("staff/form", { title: "Editar miembro", member });
});

router.post("/guardar", (req, res) => {
  const { id, name, position, phone, color, active } = req.body;
  if (!String(name || "").trim()) return res.status(400).render("error", { title: "Error", message: "El nombre es obligatorio" });
  const isActive = active === "on" || active === "1" ? 1 : 0;
  if (id) {
    db.prepare("UPDATE staff SET name=?, position=?, phone=?, color=?, active=? WHERE id=?").run(
      name, position || "Estilista", phone || "", color || "#3b82f6", isActive || (active === undefined ? 1 : isActive), id
    );
  } else {
    db.prepare("INSERT INTO staff (name, position, phone, color, active, sort) VALUES (?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM staff))").run(
      name, position || "Estilista", phone || "", color || "#3b82f6", isActive || 1
    );
  }
  req.session.flash = "Personal guardado";
  res.redirect("/personal");
});

module.exports = router;

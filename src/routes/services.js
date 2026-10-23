"use strict";
const express = require("express");
const { db, r2 } = require("../db");
const { requireAuth } = require("../middleware");

const router = express.Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  const familyId = req.query.familia ? Number(req.query.familia) : 0;
  const q = (req.query.q || "").trim();
  const like = `%${q}%`;
  const services = db
    .prepare(
      `SELECT s.*, f.name AS family_name
         FROM services s LEFT JOIN service_families f ON f.id=s.family_id
        WHERE (?=0 OR s.family_id=?) AND (?='' OR s.name LIKE ?)
        ORDER BY f.name, s.name LIMIT 300`
    )
    .all(familyId, familyId, q, like);
  const families = db.prepare("SELECT * FROM service_families ORDER BY name").all();
  res.render("services/list", { title: "Servicios", services, families, familyId, q });
});

router.get("/nuevo", (req, res) => {
  res.render("services/form", { title: "Nuevo servicio", service: null, families: db.prepare("SELECT * FROM service_families ORDER BY name").all() });
});

router.get("/:id", (req, res) => {
  const service = db.prepare("SELECT * FROM services WHERE id=?").get(req.params.id);
  if (!service) return res.status(404).render("error", { title: "Error", message: "Servicio no encontrado" });
  res.render("services/form", { title: "Editar servicio", service, families: db.prepare("SELECT * FROM service_families ORDER BY name").all() });
});

router.post("/guardar", (req, res) => {
  const { id, name, family_id, price, duration_min, color, tax_rate, cost, bookable, active } = req.body;
  if (!String(name || "").trim()) return res.status(400).render("error", { title: "Error", message: "El nombre es obligatorio" });
  const vals = [
    name,
    family_id ? Number(family_id) : null,
    r2(price),
    Math.max(5, Number(duration_min) || 30),
    color || "#8b5cf6",
    tax_rate === "" ? 0.16 : r2(tax_rate),
    r2(cost),
    bookable === "on" ? 1 : 0,
    active === undefined ? 1 : active === "on" ? 1 : 0,
  ];
  if (id) {
    db.prepare(
      `UPDATE services SET name=?, family_id=?, price=?, duration_min=?, color=?, tax_rate=?, cost=?, bookable=?, active=? WHERE id=?`
    ).run(...vals, id);
  } else {
    db.prepare(
      `INSERT INTO services (name, family_id, price, duration_min, color, tax_rate, cost, bookable, active) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(...vals);
  }
  req.session.flash = "Servicio guardado";
  res.redirect("/servicios");
});

router.post("/familia", (req, res) => {
  const name = String(req.body.name || "").trim();
  if (name) db.prepare("INSERT OR IGNORE INTO service_families (name) VALUES (?)").run(name);
  res.redirect(req.body.next || "/servicios");
});

module.exports = router;

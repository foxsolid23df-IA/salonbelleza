"use strict";
const express = require("express");
const { db, r2 } = require("../db");
const { requireAuth } = require("../middleware");

const router = express.Router();
router.use(requireAuth);

function clientList(q) {
  const like = `%${(q || "").trim()}%`;
  return db
    .prepare(
      `SELECT c.*,
              (SELECT MAX(a.date) FROM appointments a WHERE a.client_id=c.id AND a.status='done') AS last_visit,
              (SELECT COUNT(*) FROM appointments a WHERE a.client_id=c.id AND a.status='done') AS visits
         FROM clients c
        WHERE c.active=1 AND (?='' OR c.first_name||' '||c.last_name1||' '||c.last_name2 LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)
        ORDER BY c.first_name, c.last_name1 LIMIT 200`
    )
    .all(q || "", like, like, like);
}

router.get("/", (req, res) => {
  res.render("clients/list", { title: "Clientes", clients: clientList(req.query.q), q: req.query.q || "" });
});

router.get("/buscar", (req, res) => {
  res.render("clients/rows", { clients: clientList(req.query.q), partial: true, layout: false });
});

router.get("/nuevo", (req, res) => {
  res.render("clients/form", { title: "Nuevo cliente", client: null, partial: false });
});

router.get("/:id", (req, res) => {
  const client = db.prepare("SELECT * FROM clients WHERE id=?").get(req.params.id);
  if (!client) return res.status(404).render("error", { title: "Error", message: "Cliente no encontrado" });
  const history = db
    .prepare(
      `SELECT a.id, a.date, a.status, a.start_min,
              (SELECT GROUP_CONCAT(s.name, ', ') FROM appointment_services asv JOIN services s ON s.id=asv.service_id WHERE asv.appointment_id=a.id) AS services,
              (SELECT SUM(t.total) FROM tickets t WHERE t.appointment_id=a.id AND t.status='paid') AS spent
         FROM appointments a WHERE a.client_id=? ORDER BY a.date DESC, a.start_min DESC LIMIT 30`
    )
    .all(client.id);
  const tickets = db
    .prepare("SELECT id, number, total, status, created_at, paid_at FROM tickets WHERE client_id=? ORDER BY id DESC LIMIT 20")
    .all(client.id);
  res.render("clients/form", { title: "Cliente", client, history, tickets, partial: false });
});

router.post("/guardar", (req, res) => {
  const { id, first_name, last_name1, last_name2, phone, email, instagram, credit_balance, notes } = req.body;
  if (!String(first_name || "").trim())
    return res.status(400).render("error", { title: "Error", message: "El nombre es obligatorio" });
  if (id) {
    db.prepare(
      `UPDATE clients SET first_name=?, last_name1=?, last_name2=?, phone=?, email=?, instagram=?, credit_balance=?, notes=? WHERE id=?`
    ).run(first_name, last_name1 || "", last_name2 || "", phone || "", email || "", instagram || "", r2(credit_balance) || 0, notes || "", id);
  } else {
    db.prepare(
      `INSERT INTO clients (first_name, last_name1, last_name2, phone, email, instagram, credit_balance, notes) VALUES (?,?,?,?,?,?,?,?)`
    ).run(first_name, last_name1 || "", last_name2 || "", phone || "", email || "", instagram || "", r2(credit_balance) || 0, notes || "");
  }
  req.session.flash = "Cliente guardado";
  res.redirect("/clientes");
});

router.post("/:id/baja", (req, res) => {
  db.prepare("UPDATE clients SET active=0 WHERE id=?").run(req.params.id);
  req.session.flash = "Cliente desactivado";
  res.redirect("/clientes");
});

module.exports = router;

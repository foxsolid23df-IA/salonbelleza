"use strict";
const express = require("express");
const { db } = require("../db");
const { requireAuth } = require("../middleware");

const router = express.Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const tiles = [
    { href: "/citas", label: "Citas", icon: "📅" },
    { href: "/ventas", label: "Ventas", icon: "🧾" },
    { href: "/caja", label: "Caja", icon: "💰" },
    { href: "/clientes", label: "Clientes", icon: "👥" },
    { href: "/servicios", label: "Servicios", icon: "✂️" },
    { href: "/productos", label: "Productos", icon: "📦" },
    { href: "/personal", label: "Personal", icon: "👤" },
    { href: "/reportes", label: "Reportes", icon: "📊" },
  ];

  const upcoming = db
    .prepare(
      `SELECT a.id, a.start_min, a.end_min, a.status,
              c.first_name || ' ' || c.last_name1 AS client,
              (SELECT GROUP_CONCAT(s.name, ', ')
                 FROM appointment_services asv JOIN services s ON s.id = asv.service_id
                WHERE asv.appointment_id = a.id) AS services
         FROM appointments a JOIN clients c ON c.id = a.client_id
        WHERE a.date = ? AND a.status IN ('scheduled','confirmed','in_service')
        ORDER BY a.start_min LIMIT 8`
    )
    .all(today);

  const salesToday = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total
         FROM tickets WHERE status='paid' AND date(paid_at)=?`
    )
    .get(today);

  const heldTickets = db
    .prepare(
      `SELECT t.id, t.number, t.total, c.first_name || ' ' || c.last_name1 AS client
         FROM tickets t LEFT JOIN clients c ON c.id=t.client_id
        WHERE t.status='held' ORDER BY t.id DESC LIMIT 6`
    )
    .all();

  res.render("dashboard", { title: "Inicio", tiles, upcoming, salesToday, heldTickets, today });
});

module.exports = router;

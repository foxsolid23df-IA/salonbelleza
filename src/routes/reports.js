"use strict";
const express = require("express");
const { db, r2 } = require("../db");
const { requireAuth } = require("../middleware");

const router = express.Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const daily = db
    .prepare(
      `SELECT date(paid_at) AS day, COUNT(*) AS tickets, SUM(total) AS total
         FROM tickets WHERE status='paid' AND date(paid_at) >= date('now','-13 day')
        GROUP BY day ORDER BY day DESC`
    )
    .all();
  const byStaff = db
    .prepare(
      `SELECT st.name, st.color, COUNT(*) AS lines,
              SUM(CASE WHEN tl.kind='service' THEN tl.qty*tl.price ELSE 0 END) AS services,
              SUM(CASE WHEN tl.kind='product' THEN tl.qty*tl.price ELSE 0 END) AS products,
              SUM(tl.qty*tl.price) AS total
         FROM ticket_lines tl
         JOIN tickets t ON t.id=tl.ticket_id AND t.status='paid'
         JOIN staff st ON st.id=tl.staff_id
        WHERE date(t.paid_at)=?
        GROUP BY st.id ORDER BY total DESC`
    )
    .all(today);
  const byService = db
    .prepare(
      `SELECT tl.name, SUM(tl.qty) AS qty, SUM(tl.qty*tl.price) AS total
         FROM ticket_lines tl JOIN tickets t ON t.id=tl.ticket_id AND t.status='paid'
        WHERE tl.kind='service' AND date(t.paid_at)=?
        GROUP BY tl.name ORDER BY total DESC LIMIT 20`
    )
    .all(today);
  const byProduct = db
    .prepare(
      `SELECT tl.name, SUM(tl.qty) AS qty, SUM(tl.qty*tl.price) AS total
         FROM ticket_lines tl JOIN tickets t ON t.id=tl.ticket_id AND t.status='paid'
        WHERE tl.kind='product' AND date(t.paid_at)=?
        GROUP BY tl.name ORDER BY total DESC LIMIT 20`
    )
    .all(today);
  const apptStats = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM appointments WHERE date=? GROUP BY status`
    )
    .all(today);
  const topClients = db
    .prepare(
      `SELECT c.first_name||' '||c.last_name1 AS name, COUNT(t.id) AS visits, SUM(t.total) AS total
         FROM tickets t JOIN clients c ON c.id=t.client_id
        WHERE t.status='paid' AND date(t.paid_at)=?
        GROUP BY c.id ORDER BY total DESC LIMIT 10`
    )
    .all(today);
  res.render("reports/index", {
    title: "Reportes", today, days, daily,
    byStaff: byStaff.map((r) => ({ ...r, services: r2(r.services), products: r2(r.products), total: r2(r.total) })),
    byService, byProduct, apptStats, topClients,
  });
});

module.exports = router;

"use strict";
const express = require("express");
const { db, r2 } = require("../db");
const { requireAuth } = require("../middleware");

const router = express.Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  const date = req.query.fecha || new Date().toISOString().slice(0, 10);
  const register = db.prepare("SELECT * FROM cash_registers WHERE date=?").get(date);
  const tickets = db
    .prepare(
      `SELECT t.*, c.first_name||' '||c.last_name1 AS client
         FROM tickets t LEFT JOIN clients c ON c.id=t.client_id
        WHERE t.status='paid' AND date(t.paid_at)=? ORDER BY t.paid_at`
    )
    .all(date);
  const byMethod = db
    .prepare(
      `SELECT p.method, COALESCE(SUM(p.amount),0) AS amount, COUNT(DISTINCT p.ticket_id) AS n
         FROM payments p JOIN tickets t ON t.id=p.ticket_id
        WHERE t.status='paid' AND date(t.paid_at)=?
        GROUP BY p.method ORDER BY amount DESC`
    )
    .all(date);
  const expenses = db.prepare("SELECT * FROM expenses WHERE date=? ORDER BY id DESC").all(date);
  const salesByStaff = db
    .prepare(
      `SELECT st.name, st.color,
              COALESCE(SUM(CASE WHEN tl.kind='service' THEN tl.qty*tl.price ELSE 0 END),0) AS services,
              COALESCE(SUM(CASE WHEN tl.kind='product' THEN tl.qty*tl.price ELSE 0 END),0) AS products
         FROM ticket_lines tl
         JOIN tickets t ON t.id=tl.ticket_id
         JOIN staff st ON st.id=tl.staff_id
        WHERE t.status='paid' AND date(t.paid_at)=?
        GROUP BY st.id ORDER BY services+products DESC`
    )
    .all(date);
  const totals = tickets.reduce(
    (acc, t) => ({ subtotal: acc.subtotal + t.subtotal, tax: acc.tax + t.tax_total, total: acc.total + t.total }),
    { subtotal: 0, tax: 0, total: 0 }
  );
  const methodLabels = { cash: "Efectivo", transfer: "Transferencia", card: "Tarjeta", credit: "Crédito", gift: "Certificado regalo", other: "Otro" };
  const methodNames = Object.fromEntries(byMethod.map((m) => [m.method, m.amount]));
  for (const k of Object.keys(methodLabels)) if (!(k in methodNames)) methodNames[k] = 0;

  const expectedCash = register
    ? r2(register.opening_amount + methodNames.cash - expenses.reduce((s, e) => s + e.amount, 0))
    : null;

  res.render("cash/day", {
    title: "Caja", date, register, tickets, byMethod, methodLabels, methodNames, expenses,
    totals: { subtotal: r2(totals.subtotal), tax: r2(totals.tax), total: r2(totals.total) },
    salesByStaff, expectedCash,
  });
});

router.post("/abrir", (req, res) => {
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const amount = r2(req.body.opening_amount) || 0;
  db.prepare(
    "INSERT INTO cash_registers (date, opening_amount, opened_by, status) VALUES (?,?,?,'open') ON CONFLICT(date) DO NOTHING"
  ).run(date, amount, req.session.user.id);
  req.session.flash = "Caja abierta";
  res.redirect("/caja?fecha=" + date);
});

router.post("/cerrar", (req, res) => {
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const closing = r2(req.body.closing_amount);
  db.prepare("UPDATE cash_registers SET status='closed', closed_at=datetime('now'), closing_amount=? WHERE date=?").run(closing, date);
  req.session.flash = "Caja cerrada";
  res.redirect("/caja?fecha=" + date);
});

router.post("/gasto", (req, res) => {
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const concept = String(req.body.concept || "").trim();
  const amount = r2(req.body.amount);
  if (concept && amount > 0) db.prepare("INSERT INTO expenses (date, concept, amount, category) VALUES (?,?,?,?)").run(date, concept, amount, req.body.category || "varios");
  res.redirect("/caja?fecha=" + date);
});

module.exports = router;

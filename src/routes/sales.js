"use strict";
const express = require("express");
const { db, r2, nextTicketNumber, recalcTicket } = require("../db");
const { requireAuth } = require("../middleware");

const router = express.Router();
router.use(requireAuth);

const METHODS = [
  ["cash", "Efectivo"],
  ["transfer", "Transferencia"],
  ["card", "Tarjeta"],
  ["credit", "Crédito"],
  ["gift", "Certificado regalo"],
  ["other", "Otro"],
];

function getTicket(id) {
  return db.prepare("SELECT * FROM tickets WHERE id=?").get(id);
}

function ticketView(ticket) {
  const lines = db
    .prepare(
      `SELECT tl.*, st.name AS staff_name
         FROM ticket_lines tl LEFT JOIN staff st ON st.id=tl.staff_id
        WHERE tl.ticket_id=? ORDER BY tl.id`
    )
    .all(ticket.id);
  const client = ticket.client_id ? db.prepare("SELECT * FROM clients WHERE id=?").get(ticket.client_id) : null;
  const payments = db.prepare("SELECT * FROM payments WHERE ticket_id=?").all(ticket.id);
  const totals = recalcTicket(ticket.id);
  const fresh = getTicket(ticket.id);
  const paidSum = r2(payments.reduce((s, p) => s + p.amount, 0));
  return { ticket: fresh, lines, client, payments, totals, methods: METHODS, paidSum };
}

function currentTicket(req) {
  if (req.query.ticket) {
    const t = getTicket(Number(req.query.ticket));
    if (t && t.status === "held") return t;
  }
  const last = db.prepare("SELECT * FROM tickets WHERE status='held' ORDER BY id DESC LIMIT 1").get();
  if (last) return last;
  const number = nextTicketNumber();
  const r = db.prepare("INSERT INTO tickets (number, status) VALUES (?, 'held')").run(number);
  return getTicket(r.lastInsertRowid);
}

router.get("/", (req, res) => {
  const ticket = currentTicket(req);
  const services = db.prepare("SELECT * FROM services WHERE active=1 ORDER BY name LIMIT 200").all();
  const products = db.prepare("SELECT * FROM products WHERE active=1 AND stock>0 ORDER BY name LIMIT 200").all();
  const staff = db.prepare("SELECT * FROM staff WHERE active=1 ORDER BY sort, name").all();
  const clients = db.prepare("SELECT id, first_name||' '||last_name1 AS name FROM clients WHERE active=1 ORDER BY name LIMIT 300").all();
  const held = db.prepare("SELECT id, number, total, created_at FROM tickets WHERE status='held' ORDER BY id DESC LIMIT 10").all();
  res.render("sales/pos", { title: "Ventas", view: ticketView(ticket), services, products, staff, clients, held, q: "" });
});

router.get("/catalogo", (req, res) => {
  const tab = req.query.tab === "productos" ? "productos" : "servicios";
  const q = (req.query.q || "").trim();
  const like = `%${q}%`;
  const ticket = currentTicket(req);
  const items =
    tab === "productos"
      ? db.prepare("SELECT id, name, price, stock FROM products WHERE active=1 AND (?='' OR name LIKE ? OR code LIKE ?) ORDER BY name LIMIT 100").all(q, like, like)
      : db.prepare("SELECT id, name, price, duration_min AS stock FROM services WHERE active=1 AND (?='' OR name LIKE ?) ORDER BY name LIMIT 100").all(q, like);
  res.render("sales/catalog", { tab, items, ticket, q });
});

router.post("/cliente", (req, res) => {
  const ticket = currentTicket(req);
  const clientId = Number(req.body.client_id) || null;
  db.prepare("UPDATE tickets SET client_id=? WHERE id=?").run(clientId, ticket.id);
  res.redirect("/ventas?ticket=" + ticket.id);
});

router.post("/linea", (req, res) => {
  const ticket = currentTicket(req);
  const kind = req.body.kind === "product" ? "product" : "service";
  const refId = Number(req.body.ref_id);
  const qty = Math.max(0.01, r2(req.body.qty) || 1);
  const staffId = req.body.staff_id ? Number(req.body.staff_id) : null;
  let name, price, tax;
  if (kind === "product") {
    const p = db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(refId);
    if (!p) return res.status(400).render("error", { title: "Error", message: "Producto no encontrado" });
    name = p.name; price = p.price; tax = 0.16;
  } else {
    const s = db.prepare("SELECT * FROM services WHERE id=? AND active=1").get(refId);
    if (!s) return res.status(400).render("error", { title: "Error", message: "Servicio no encontrado" });
    name = s.name; price = s.price; tax = s.tax_rate;
  }
  db.prepare("INSERT INTO ticket_lines (ticket_id, kind, ref_id, name, qty, price, tax_rate, staff_id) VALUES (?,?,?,?,?,?,?,?)").run(
    ticket.id, kind, refId, name, qty, price, tax, staffId
  );
  recalcTicket(ticket.id);
  if (req.htmx) return res.render("sales/_ticket", { view: ticketView(ticket) });
  res.redirect("/ventas?ticket=" + ticket.id);
});

router.post("/linea/:lineId/quitar", (req, res) => {
  const line = db.prepare("SELECT * FROM ticket_lines WHERE id=?").get(req.params.lineId);
  if (line) {
    db.prepare("DELETE FROM ticket_lines WHERE id=?").run(line.id);
    recalcTicket(line.ticket_id);
  }
  const ticketId = line ? line.ticket_id : currentTicket(req).id;
  if (req.htmx) return res.render("sales/_ticket", { view: ticketView(getTicket(ticketId)) });
  res.redirect("/ventas?ticket=" + ticketId);
});

router.post("/cobrar", (req, res) => {
  const ticket = currentTicket(req);
  const { totals, lines } = ticketView(ticket);
  if (!lines.length) return res.status(400).render("error", { title: "Error", message: "El ticket no tiene líneas" });
  const paySpec = [
    ["cash", "Efectivo"], ["transfer", "Transferencia"], ["card", "Tarjeta"],
    ["credit", "Crédito"], ["gift", "Certificado regalo"], ["other", "Otro"],
  ];
  const payments = [];
  for (const [method] of paySpec) {
    const amount = r2(req.body["m_" + method]);
    if (amount > 0) payments.push({ method, amount, bank: method === "transfer" ? (req.body["bank_" + method] || "") : "" });
  }
  const sum = r2(payments.reduce((s, p) => s + p.amount, 0));
  if (sum !== totals.total)
    return res.status(400).render("error", { title: "Error", message: `La suma de pagos (${sum}) debe ser igual al total (${totals.total})` });
  if (!ticket.client_id) {
    const walkin = db.prepare("SELECT id FROM clients WHERE id=1").get();
    if (walkin) db.prepare("UPDATE tickets SET client_id=1 WHERE id=?").run(ticket.id);
  }
  const tx = db.transaction(() => {
    for (const p of payments)
      db.prepare("INSERT INTO payments (ticket_id, method, amount, bank) VALUES (?,?,?,?)").run(ticket.id, p.method, p.amount, p.bank);
    const tLines = db.prepare("SELECT * FROM ticket_lines WHERE ticket_id=?").all(ticket.id);
    for (const l of tLines) {
      if (l.kind === "product" && l.ref_id) {
        db.prepare("UPDATE products SET stock=stock-? WHERE id=?").run(l.qty, l.ref_id);
        db.prepare("INSERT INTO product_movements (product_id, qty_delta, reason, ref) VALUES (?,?,?,?)").run(l.ref_id, -l.qty, "venta", `Ticket #${ticket.number}`);
      }
    }
    db.prepare("UPDATE tickets SET status='paid', paid_at=datetime('now') WHERE id=?").run(ticket.id);
    for (const p of payments) {
      if (p.method === "credit" && ticket.client_id)
        db.prepare("UPDATE clients SET credit_balance=credit_balance+? WHERE id=?").run(p.amount, ticket.client_id);
      if (p.method === "gift") {
        const code = "GC-" + ticket.number + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
        db.prepare(
          "INSERT INTO gift_certificates (code, client_id, staff_id, amount, expires_at, status) VALUES (?,?,NULL,?,datetime('now','+1 year'),'active')"
        ).run(code, ticket.client_id, p.amount);
      }
    }
    if (ticket.appointment_id) db.prepare("UPDATE appointments SET status='done' WHERE id=?").run(ticket.appointment_id);
  });
  tx();
  req.session.flash = `Ticket #${ticket.number} cobrado ($${totals.total.toFixed(2)})`;
  res.redirect("/ventas");
});

router.get("/en-espera", (req, res) => {
  const held = db
    .prepare(
      `SELECT t.id, t.number, t.total, t.created_at, c.first_name||' '||c.last_name1 AS client
         FROM tickets t LEFT JOIN clients c ON c.id=t.client_id
        WHERE t.status='held' ORDER BY t.id DESC`
    )
    .all();
  res.render("sales/held", { title: "Tickets en espera", held });
});

router.post("/:id/cancelar", (req, res) => {
  const t = getTicket(req.params.id);
  if (t) db.prepare("UPDATE tickets SET status='cancelled' WHERE id=?").run(t.id);
  res.redirect("/ventas");
});

router.get("/nuevo", (req, res) => {
  const number = nextTicketNumber();
  db.prepare("INSERT INTO tickets (number, status) VALUES (?, 'held')").run(number);
  res.redirect("/ventas");
});

module.exports = router;

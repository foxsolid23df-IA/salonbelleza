"use strict";
const express = require("express");
const { db, r2 } = require("../db");
const { requireAuth } = require("../middleware");

const router = express.Router();
router.use(requireAuth);

const DAY_START = 9 * 60;
const DAY_END = 20 * 60 + 15;
const SLOT = 15;

function fmtTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseTime(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || "").trim());
  if (!m) return null;
  const min = Number(m[1]) * 60 + Number(m[2]);
  return min >= 0 && min < 24 * 60 ? min : null;
}

router.get("/", (req, res) => {
  const date = req.query.fecha || new Date().toISOString().slice(0, 10);
  const staff = db.prepare("SELECT * FROM staff WHERE active=1 ORDER BY sort, name").all();
  const appts = db
    .prepare(
      `SELECT a.*, c.first_name || ' ' || c.last_name1 AS client, c.phone
         FROM appointments a JOIN clients c ON c.id=a.client_id
        WHERE a.date=? ORDER BY a.start_min`
    )
    .all(date);
  const svcStmt = db.prepare(
    `SELECT asv.*, s.name AS service_name, s.color, st.name AS staff_name
       FROM appointment_services asv
       JOIN services s ON s.id=asv.service_id
       LEFT JOIN staff st ON st.id=asv.staff_id
      WHERE asv.appointment_id=?`
  );
  for (const a of appts) a.services = svcStmt.all(a.id);

  const slots = [];
  for (let t = DAY_START; t < DAY_END; t += SLOT) slots.push(t);

  const projected = db
    .prepare(
      `SELECT COALESCE(SUM(asv.price),0) AS total
         FROM appointment_services asv JOIN appointments a ON a.id=asv.appointment_id
        WHERE a.date=? AND a.status NOT IN ('cancelled','no_show')`
    )
    .get(date);

  res.render("appointments/day", {
    title: "Citas",
    date, staff, appts, slots, slotsList: slots, fmtTime, DAY_START, DAY_END, projected: projected.total,
  });
});

router.get("/slot", (req, res) => {
  const date = req.query.fecha;
  const staffId = Number(req.query.staff_id);
  const startMin = Number(req.query.start_min);
  const staffMember = db.prepare("SELECT * FROM staff WHERE id=?").get(staffId);
  const services = db.prepare("SELECT * FROM services WHERE active=1 AND bookable=1 ORDER BY name").all();
  const clients = db.prepare("SELECT id, first_name||' '||last_name1 AS name FROM clients WHERE active=1 ORDER BY name LIMIT 300").all();
  const staff = db.prepare("SELECT * FROM staff WHERE active=1 ORDER BY sort, name").all();
  res.render("appointments/slot", {
    title: "Nueva cita", date, staffId, staffMember, startMin, fmtTime, services, clients, staff, appointment: null, apptServices: [],
  });
});

router.get("/:id", (req, res) => {
  const appointment = db.prepare("SELECT * FROM appointments WHERE id=?").get(req.params.id);
  if (!appointment) return res.status(404).render("error", { title: "Error", message: "Cita no encontrada" });
  const apptServices = db.prepare("SELECT * FROM appointment_services WHERE appointment_id=?").all(appointment.id);
  const services = db.prepare("SELECT * FROM services WHERE active=1 ORDER BY name").all();
  const clients = db.prepare("SELECT id, first_name||' '||last_name1 AS name FROM clients WHERE active=1 ORDER BY name LIMIT 300").all();
  const staff = db.prepare("SELECT * FROM staff WHERE active=1 ORDER BY sort, name").all();
  res.render("appointments/slot", {
    title: "Editar cita", date: appointment.date, staffId: null, staffMember: null,
    startMin: appointment.start_min, fmtTime, services, clients, staff, appointment, apptServices,
  });
});

function checkOverlap(apptId, date, startMin, endMin, pairs) {
  for (const { staff_id } of pairs) {
    if (!staff_id) continue;
    const rows = db
      .prepare(
        `SELECT a.id, a.start_min, a.end_min
           FROM appointments a JOIN appointment_services asv ON asv.appointment_id=a.id
          WHERE a.date=? AND a.status NOT IN ('cancelled','no_show') AND asv.staff_id=?
            AND a.id != COALESCE(?, -1)
            AND a.start_min < ? AND a.end_min > ?`
      )
      .all(date, Number(staff_id), apptId || null, endMin, startMin);
    if (rows.length) return true;
  }
  return false;
}

router.post("/guardar", (req, res) => {
  const { id, client_id, date, start_time, end_time, status, notes, service_id, staff_id } = req.body;
  const startMin = parseTime(start_time);
  let endMin = parseTime(end_time);
  if (startMin === null)
    return res.status(400).render("error", { title: "Error", message: "Hora de inicio inválida" });
  const svcIds = [].concat(service_id || []).filter(Boolean).map(Number);
  const stIds = [].concat(staff_id || []).filter(Boolean).map(Number);
  if (!svcIds.length)
    return res.status(400).render("error", { title: "Error", message: "Selecciona al menos un servicio" });

  const stmt = db.prepare("SELECT duration_min, price FROM services WHERE id=?");
  let totalDur = 0;
  const items = svcIds.map((sid, i) => {
    const s = stmt.get(sid);
    if (!s) throw new Error("Servicio inválido");
    totalDur += s.duration_min;
    return { service_id: sid, staff_id: stIds[i] || stIds[0] || null, price: s.price, duration_min: s.duration_min };
  });
  if (endMin === null) endMin = startMin + totalDur;
  if (endMin <= startMin)
    return res.status(400).render("error", { title: "Error", message: "La duración debe ser positiva" });

  if (checkOverlap(id || null, date, startMin, endMin, items))
    return res.status(400).render("error", { title: "Conflicto", message: "Hay una cita que se traslapa con ese horario/personal." });

  const st = status || "scheduled";
  if (id) {
    const existing = db.prepare("SELECT * FROM appointments WHERE id=?").get(id);
    if (!existing) return res.status(404).render("error", { title: "Error", message: "Cita no encontrada" });
    db.prepare("UPDATE appointments SET client_id=?, date=?, start_min=?, end_min=?, status=?, notes=? WHERE id=?").run(
      Number(client_id), date, startMin, endMin, st, notes || "", id
    );
    db.prepare("DELETE FROM appointment_services WHERE appointment_id=?").run(id);
    for (const it of items)
      db.prepare(
        "INSERT INTO appointment_services (appointment_id, service_id, staff_id, price, duration_min) VALUES (?,?,?,?,?)"
      ).run(id, it.service_id, it.staff_id, it.price, it.duration_min);
  } else {
    const r = db
      .prepare("INSERT INTO appointments (client_id, date, start_min, end_min, status, notes) VALUES (?,?,?,?,?,?)")
      .run(Number(client_id), date, startMin, endMin, st, notes || "");
    const apptId = r.lastInsertRowid;
    for (const it of items)
      db.prepare(
        "INSERT INTO appointment_services (appointment_id, service_id, staff_id, price, duration_min) VALUES (?,?,?,?,?)"
      ).run(apptId, it.service_id, it.staff_id, it.price, it.duration_min);
  }
  req.session.flash = "Cita guardada";
  res.redirect(`/citas?fecha=${date}`);
});

const STATUS_ACTIONS = { confirmar: "confirmed", cancelar: "cancelled", noshow: "no_show", concluir: "done", iniciar: "in_service" };
router.post("/:id/estado/:accion", (req, res) => {
  const status = STATUS_ACTIONS[req.params.accion];
  const appt = db.prepare("SELECT * FROM appointments WHERE id=?").get(req.params.id);
  if (!appt || !status) return res.status(404).render("error", { title: "Error", message: "Acción inválida" });
  db.prepare("UPDATE appointments SET status=? WHERE id=?").run(status, appt.id);
  req.session.flash = "Cita actualizada";
  res.redirect(`/citas?fecha=${appt.date}`);
});

router.post("/:id/checkin", (req, res) => {
  const appt = db.prepare("SELECT * FROM appointments WHERE id=?").get(req.params.id);
  if (!appt) return res.status(404).render("error", { title: "Error", message: "Cita no encontrada" });
  const existing = db.prepare("SELECT id FROM tickets WHERE appointment_id=? AND status='held'").get(appt.id);
  if (existing) {
    db.prepare("UPDATE appointments SET status='in_service' WHERE id=?").run(appt.id);
    return res.redirect("/ventas?ticket=" + existing.id);
  }
  const { nextTicketNumber } = require("../db");
  const number = nextTicketNumber();
  const r = db
    .prepare("INSERT INTO tickets (number, client_id, appointment_id, status, notes) VALUES (?,?,?,'held',?)")
    .run(number, appt.client_id, appt.id, `Cita #${appt.id}`);
  const ticketId = r.lastInsertRowid;
  const items = db.prepare("SELECT * FROM appointment_services WHERE appointment_id=?").all(appt.id);
  for (const it of items) {
    const svc = db.prepare("SELECT name, tax_rate FROM services WHERE id=?").get(it.service_id);
    db.prepare(
      "INSERT INTO ticket_lines (ticket_id, kind, ref_id, name, qty, price, tax_rate, staff_id) VALUES (?, 'service', ?, ?, 1, ?, ?, ?)"
    ).run(ticketId, it.service_id, svc ? svc.name : "Servicio", it.price, svc ? svc.tax_rate : 0.16, it.staff_id);
  }
  require("../db").recalcTicket(ticketId);
  db.prepare("UPDATE appointments SET status='in_service' WHERE id=?").run(appt.id);
  res.redirect("/ventas?ticket=" + ticketId);
});

module.exports = router;

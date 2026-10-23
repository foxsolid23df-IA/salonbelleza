"use strict";
const express = require("express");
const { db, r2 } = require("../db");
const { requireAuth } = require("../middleware");

const router = express.Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  const q = (req.query.q || "").trim();
  const kind = req.query.tipo || "";
  const like = `%${q}%`;
  const products = db
    .prepare(
      `SELECT * FROM products
        WHERE active=1 AND (?='' OR kind=?) AND (?='' OR name LIKE ? OR code LIKE ? OR brand LIKE ? OR supplier LIKE ?)
        ORDER BY name LIMIT 300`
    )
    .all(kind, kind, q, like, like, like, like);
  res.render("products/list", { title: "Productos", products, q, kind });
});

router.get("/nuevo", (req, res) => res.render("products/form", { title: "Nuevo producto", product: null }));

router.get("/:id", (req, res) => {
  const product = db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id);
  if (!product) return res.status(404).render("error", { title: "Error", message: "Producto no encontrado" });
  const moves = db.prepare("SELECT * FROM product_movements WHERE product_id=? ORDER BY id DESC LIMIT 30").all(product.id);
  res.render("products/form", { title: "Editar producto", product, moves });
});

router.post("/guardar", (req, res) => {
  const { id, name, code, supplier, brand, kind, cost, price, stock, active } = req.body;
  if (!String(name || "").trim()) return res.status(400).render("error", { title: "Error", message: "El nombre es obligatorio" });
  const k = kind === "technical" ? "technical" : "retail";
  if (id) {
    const old = db.prepare("SELECT stock FROM products WHERE id=?").get(id);
    db.prepare(
      "UPDATE products SET name=?, code=?, supplier=?, brand=?, kind=?, cost=?, price=?, stock=?, active=? WHERE id=?"
    ).run(name, code || "", supplier || "", brand || "", k, r2(cost), r2(price), r2(stock), active === "on" ? 1 : 0, id);
    const delta = r2(Number(stock) - (old ? old.stock : 0));
    if (delta !== 0)
      db.prepare("INSERT INTO product_movements (product_id, qty_delta, reason, ref) VALUES (?,?,?,?)").run(id, delta, "ajuste", "edición");
  } else {
    db.prepare(
      "INSERT INTO products (name, code, supplier, brand, kind, cost, price, stock, active) VALUES (?,?,?,?,?,?,?,?,1)"
    ).run(name, code || "", supplier || "", brand || "", k, r2(cost), r2(price), r2(stock));
    const pid = db.prepare("SELECT last_insert_rowid() AS id").get().id;
    if (r2(stock) !== 0)
      db.prepare("INSERT INTO product_movements (product_id, qty_delta, reason, ref) VALUES (?,?,?,?)").run(pid, r2(stock), "inicial", "");
  }
  req.session.flash = "Producto guardado";
  res.redirect("/productos");
});

router.post("/:id/movimiento", (req, res) => {
  const product = db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id);
  if (!product) return res.status(404).render("error", { title: "Error", message: "Producto no encontrado" });
  const delta = r2(req.body.qty_delta);
  const reason = String(req.body.reason || "ajuste");
  if (delta !== 0) {
    db.prepare("UPDATE products SET stock=stock+? WHERE id=?").run(delta, product.id);
    db.prepare("INSERT INTO product_movements (product_id, qty_delta, reason, ref) VALUES (?,?,?,?)").run(product.id, delta, reason, req.body.ref || "");
  }
  res.redirect("/productos/" + product.id);
});

module.exports = router;

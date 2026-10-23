"use strict";

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect("/login");
    if (roles.length && !roles.includes(req.session.user.role))
      return res.status(403).render("error", { title: "Sin permiso", message: "No tienes permiso para esta sección." });
    next();
  };
}

module.exports = { requireAuth, requireRole };

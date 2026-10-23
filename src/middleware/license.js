"use strict";
const { db } = require("../db");
const license = require("../license");

const DEV_SKIP = license.DEV_SKIP;
const GRACE_DAYS = license.GRACE_DAYS;

function requireActivated(req, res, next) {
  if (DEV_SKIP) return next();
  const state = license.activationState();
  if (!state.activated) {
    if (state.reason === "revoked") return res.redirect("/setup?err=revoked");
    if (state.reason === "needs_activation") return res.redirect("/setup?err=reactivar");
    return res.redirect("/setup");
  }
  if (state.grace) {
    res.locals.licenseGrace = state.graceDaysLeft;
    res.locals.showGraceBanner = true;
  } else {
    res.locals.showGraceBanner = false;
  }
  res.locals.license = { ...state, activated: true };
  req.license = state;
  next();
}

function requireProfile(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

module.exports = { requireActivated, requireProfile };

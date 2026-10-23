"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");

function load() {
  if (!fs.existsSync(ENV_FILE)) return false;
  let text = "";
  try { text = fs.readFileSync(ENV_FILE, "utf8"); } catch { return false; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
  return true;
}

function appendVar(key, value) {
  const prefix = fs.existsSync(ENV_FILE) && fs.statSync(ENV_FILE).size > 0 ? "\n" : "";
  fs.appendFileSync(ENV_FILE, `${prefix}${key}=${value}\n`, "utf8");
}

function ensureSecret() {
  if (process.env.SALON_SECRET) return process.env.SALON_SECRET;
  const secret = crypto.randomBytes(32).toString("hex");
  process.env.SALON_SECRET = secret;
  try { appendVar("SALON_SECRET", secret); } catch {}
  return secret;
}

function setVar(key, value) {
  process.env[key] = String(value);
  let text = "";
  try { if (fs.existsSync(ENV_FILE)) text = fs.readFileSync(ENV_FILE, "utf8"); } catch {}
  const re = new RegExp("^\\s*" + key + "\\s*=.*$", "m");
  if (re.test(text)) {
    text = text.replace(re, `${key}=${value}`);
  } else {
    text += (text && !text.endsWith("\n") ? "\n" : "") + `${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_FILE, text, "utf8");
}

module.exports = { load, ensureSecret, setVar, ENV_FILE, ROOT };

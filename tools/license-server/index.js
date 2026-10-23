"use strict";
const app = require("./app");

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "127.0.0.1";

if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    console.log("[license-server] escuchando en http://" + HOST + ":" + PORT);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = app;

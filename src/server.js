const fs = require("fs/promises");
const config = require("./config");
const { createApp } = require("./app");
const db = require("./db");
const { connection } = require("./queue");
const { startCleanupLoop } = require("./services/cleanup-service");

async function start() {
  await fs.mkdir(config.outputDir, { recursive: true });
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[api] listening on http://localhost:${config.port}`);
  });
  startCleanupLoop();

  const shutdown = async (signal) => {
    console.log(`[api] received ${signal}, shutting down...`);
    server.close(async () => {
      await Promise.allSettled([db.pool.end(), connection.quit()]);
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((err) => {
  console.error("[api] startup failed:", err);
  process.exit(1);
});

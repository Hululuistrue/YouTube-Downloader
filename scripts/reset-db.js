const db = require("../src/db");

async function run() {
  await db.query(
    `TRUNCATE TABLE
      complaint_tickets,
      abuse_blocks,
      task_events,
      download_tasks,
      users
     RESTART IDENTITY CASCADE`
  );
  console.log("[db:reset] done");
  await db.pool.end();
}

run().catch(async (err) => {
  console.error("[db:reset] failed:", err);
  await db.pool.end();
  process.exit(1);
});

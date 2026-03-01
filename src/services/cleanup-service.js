const fs = require("fs/promises");
const path = require("path");
const db = require("../db");
const config = require("../config");

let timer = null;

async function expireTasksAndCleanupFiles() {
  const { rows } = await db.query(
    `SELECT id, output_object_key
     FROM download_tasks
     WHERE status = 'success'
       AND expires_at IS NOT NULL
       AND expires_at <= now()`
  );

  if (rows.length === 0) {
    return;
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      await client.query(
        `UPDATE download_tasks
         SET status = 'expired'
         WHERE id = $1 AND status = 'success'`,
        [row.id]
      );
      await client.query(
        `INSERT INTO task_events (task_id, from_status, to_status, message)
         VALUES ($1, 'success', 'expired', 'Link and file expired')`,
        [row.id]
      );

      if (row.output_object_key) {
        const filePath = path.join(config.outputDir, row.output_object_key);
        await fs.rm(filePath, { force: true });
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function startCleanupLoop(intervalMs = 60 * 1000) {
  if (timer) {
    return;
  }
  timer = setInterval(async () => {
    try {
      await expireTasksAndCleanupFiles();
    } catch (err) {
      console.error("[cleanup] failed:", err.message);
    }
  }, intervalMs);
}

module.exports = {
  startCleanupLoop,
  expireTasksAndCleanupFiles,
};

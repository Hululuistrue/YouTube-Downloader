const fs = require("fs/promises");
const path = require("path");
const db = require("../src/db");

async function run() {
  const schemaPath = path.join(process.cwd(), "db", "schema.sql");
  const sql = await fs.readFile(schemaPath, "utf8");
  await db.query(sql);
  console.log("[migrate] schema applied");
  await db.pool.end();
}

run().catch(async (err) => {
  console.error("[migrate] failed:", err);
  await db.pool.end();
  process.exit(1);
});

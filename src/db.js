const { Pool } = require("pg");
const config = require("./config");

const pool = new Pool({
  connectionString: config.databaseUrl,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected idle client error:", err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};

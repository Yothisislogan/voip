import pg from "pg";
import { config } from "./config.js";

let pool = null;

if (config.databaseUrl) {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  pool.on("error", (err) => console.error("Postgres pool error:", err.message));
  console.log("\uD83D\uDDC4\uFE0F  Database logging enabled.");
} else {
  console.log("\uD83D\uDDC4\uFE0F  No DATABASE_URL set \u2014 call logging disabled (tokens + TwiML still work).");
}

export const db = {
  enabled: Boolean(pool),
  async query(text, params) {
    if (!pool) return { rows: [] };
    return pool.query(text, params);
  },
};

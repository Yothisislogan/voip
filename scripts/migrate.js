import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../src/config.js";

/**
 * Apply db/schema.sql to the configured Postgres database.
 * Idempotent — safe to run on every deploy. `npm run migrate`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, "..", "db", "schema.sql");

async function main() {
  if (!config.databaseUrl) {
    console.error("DATABASE_URL is not set — nothing to migrate.");
    process.exit(1);
  }
  const sql = fs.readFileSync(schemaPath, "utf8");
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query(sql);
    console.log("✅ Schema applied (db/schema.sql).");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { config } from "../src/config.js";

/**
 * Backup → restore verification. A backup you have never restored is not a
 * backup. This script proves the round trip:
 *
 *   1. pg_dump the live database to a temp file
 *   2. create a throwaway scratch database
 *   3. restore the dump into it
 *   4. compare table lists and row counts (source vs restored)
 *   5. run migrations against the restore — must report "up to date" (idempotent)
 *   6. drop the scratch database (always, even on failure)
 *
 * Exits non-zero if anything fails or the row counts diverge, so it can gate a
 * deploy or run on a schedule. `npm run restore-test`.
 *
 * Requires pg_dump / psql / createdb / dropdb on PATH and DATABASE_URL set.
 */

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

if (!config.databaseUrl) fail("DATABASE_URL is not set — nothing to verify.");

// Derive a maintenance connection (same server, `postgres` db) for CREATE/DROP,
// and a scratch database name that cannot collide with anything real.
const source = new URL(config.databaseUrl);
const scratchName = `wit_restore_test_${process.pid}_${Date.now()}`;
const adminUrl = new URL(config.databaseUrl);
adminUrl.pathname = "/postgres";
const scratchUrl = new URL(config.databaseUrl);
scratchUrl.pathname = `/${scratchName}`;

const dumpFile = path.join(os.tmpdir(), `${scratchName}.sql`);

// Run a shell command, inheriting stdio for psql/pg_dump progress, throwing on
// non-zero exit. PGPASSWORD is passed through the URL, so no extra env needed.
function sh(cmd) {
  execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] });
}

async function tableCounts(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows: tables } = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );
    const counts = {};
    for (const { tablename } of tables) {
      // Identifier comes from pg_tables (our own schema), safe to interpolate.
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM "${tablename}"`);
      counts[tablename] = rows[0].n;
    }
    return counts;
  } finally {
    await client.end();
  }
}

async function dropScratch() {
  try {
    sh(`dropdb --if-exists "${scratchUrl}" 2>/dev/null || dropdb --if-exists -d "${adminUrl}" "${scratchName}"`);
  } catch {
    // Best effort; try the admin-connection form explicitly.
    try {
      const admin = new pg.Client({ connectionString: adminUrl.toString() });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS "${scratchName}"`);
      await admin.end();
    } catch (e) {
      console.warn(`⚠️  could not drop scratch db ${scratchName}: ${e.message}`);
    }
  }
  try {
    fs.rmSync(dumpFile, { force: true });
  } catch {
    /* ignore */
  }
}

async function main() {
  console.log(`Source: ${source.pathname.slice(1)} @ ${source.host}`);
  console.log(`Scratch: ${scratchName}`);

  // 1. Dump the live database.
  console.log("→ pg_dump source…");
  sh(`pg_dump "${config.databaseUrl}" --no-owner --no-privileges -f "${dumpFile}"`);
  const dumpBytes = fs.statSync(dumpFile).size;
  if (dumpBytes === 0) fail("pg_dump produced an empty file.");
  console.log(`  dump: ${(dumpBytes / 1024).toFixed(1)} KiB`);

  // 2. Create the scratch database via the admin connection.
  console.log("→ create scratch database…");
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${scratchName}"`);
  } finally {
    await admin.end();
  }

  // 3. Restore the dump into the scratch database.
  console.log("→ restore into scratch…");
  sh(`psql "${scratchUrl}" -v ON_ERROR_STOP=1 -q -f "${dumpFile}"`);

  // 4. Compare table lists and row counts.
  console.log("→ compare source vs restore…");
  const [src, dst] = await Promise.all([
    tableCounts(config.databaseUrl),
    tableCounts(scratchUrl.toString()),
  ]);

  const srcTables = Object.keys(src).sort();
  const dstTables = Object.keys(dst).sort();
  if (srcTables.join(",") !== dstTables.join(",")) {
    fail(`table set mismatch:\n  source:  ${srcTables.join(", ")}\n  restore: ${dstTables.join(", ")}`);
  }

  let mismatches = 0;
  for (const t of srcTables) {
    const ok = src[t] === dst[t];
    if (!ok) mismatches++;
    console.log(`  ${ok ? "✓" : "✗"} ${t}: source=${src[t]} restore=${dst[t]}`);
  }
  if (mismatches) fail(`${mismatches} table(s) had mismatched row counts.`);

  // 5. Migrations must be idempotent against the restore (nothing pending).
  console.log("→ migration idempotency on restore…");
  const out = execSync("node scripts/migrate.js", {
    env: { ...process.env, DATABASE_URL: scratchUrl.toString() },
    encoding: "utf8",
  });
  if (!/Up to date/.test(out)) {
    fail(`restored DB had pending migrations (schema drift):\n${out.trim()}`);
  }
  console.log("  ✓ no pending migrations on the restore");

  const totalRows = Object.values(src).reduce((a, b) => a + b, 0);
  console.log(`\n✅ restore verified — ${srcTables.length} tables, ${totalRows} rows round-tripped cleanly.`);
}

main()
  .then(dropScratch)
  .catch(async (err) => {
    await dropScratch();
    fail(err.message);
  });

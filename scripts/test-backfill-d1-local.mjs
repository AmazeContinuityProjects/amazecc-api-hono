/**
 * Local integration rehearsal for the Postgres-to-D1 backfill. Uses a tiny
 * disposable PGlite source and Wrangler's local D1; it never targets remote D1.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const BACKFILL = join(ROOT, "scripts", "backfill-d1.mjs");
const PORT = Number(process.env.PGLITE_TEST_PORT ?? 55434);
const suffix = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
const registers = [1, 2, 3].map((n) => `ZZTEST${suffix}${n}`);
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

function wranglerQuery(sql) {
  const stdout = execFileSync(process.execPath, [
    WRANGLER, "d1", "execute", "amazecc-api", "--local", "--json", "--command", sql,
  ], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] !== "[") continue;
    try {
      const result = JSON.parse(stdout.slice(i));
      if (result[0]?.success) return result[0].results ?? [];
    } catch { /* skip Wrangler's progress output */ }
  }
  throw new Error("Wrangler returned an invalid local D1 response");
}

function runBackfill(connectionString, maxWrites) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      BACKFILL,
      "--local",
      "--apply",
      "--only=student_profiles",
      `--max-writes=${maxWrites}`,
    ], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: connectionString },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Local backfill rehearsal failed: ${stderr || stdout}`));
        return;
      }
      try {
        assert.match(stdout, /target=local/);
        resolve(stdout);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function localRows() {
  return wranglerQuery(
    `SELECT reg_no, display_name FROM student_profiles WHERE reg_no IN (${registers.map(sqlLiteral).join(", ")}) ORDER BY reg_no`,
  );
}

const source = new PGlite();
const socket = new PGLiteSocketServer({ db: source, port: PORT, host: "127.0.0.1", maxConnections: 2 });
let socketStarted = false;

try {
  await source.exec(`
    CREATE TABLE student_profiles (
      reg_no TEXT PRIMARY KEY,
      display_name TEXT,
      phone_number TEXT,
      email TEXT,
      branch TEXT,
      semester_id TEXT,
      photo_url TEXT,
      amaze_sub TEXT UNIQUE,
      claim_status TEXT NOT NULL DEFAULT 'incomplete',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await source.query(
    `INSERT INTO student_profiles (reg_no, display_name, claim_status, created_at, updated_at)
     VALUES ($1, 'Student One', 'incomplete', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
            ($2, 'Student Two', 'incomplete', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
            ($3, 'Student Three', 'incomplete', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z')`,
    registers,
  );
  await socket.start();
  socketStarted = true;
  const connectionString = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`;

  await runBackfill(connectionString, 3);
  assert.equal(localRows().length, 1, "first budgeted pass should import one indexed row");
  await runBackfill(connectionString, 3);
  assert.equal(localRows().length, 2, "second budgeted pass should resume with one more row");
  await runBackfill(connectionString, 10);
  assert.deepEqual(localRows().map((row) => row.display_name), ["Student One", "Student Two", "Student Three"]);

  await source.query("UPDATE student_profiles SET display_name = 'Updated Student' WHERE reg_no = $1", [registers[1]]);
  await runBackfill(connectionString, 3);
  assert.equal(localRows()[1]?.display_name, "Updated Student", "changed source values should update the matching D1 row");

  console.log("Local backfill rehearsal passed: indexed write budget, resume, and changed-row update.");
} finally {
  try {
    wranglerQuery(`DELETE FROM student_profiles WHERE reg_no IN (${registers.map(sqlLiteral).join(", ")})`);
  } catch { /* local D1 may not have been available to start the rehearsal */ }
  if (socketStarted) await socket.stop();
  await source.close();
}

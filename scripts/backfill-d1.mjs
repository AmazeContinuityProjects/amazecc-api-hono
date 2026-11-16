/**
 * Copy public Postgres tables into D1 without writing row data to the
 * repository. Postgres is canonical for matching keys; D1-only keys are
 * preserved. Only missing or changed source rows are written.
 *
 * Dry-run: node scripts/backfill-d1.mjs
 * Apply:   node scripts/backfill-d1.mjs --apply
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");
const LOCAL_D1 = process.argv.includes("--local");
// Keep 75% of the free daily allowance available for normal application
// traffic and estimation variance. Cloudflare counts affected index rows too.
const WRITE_BUDGET = Number(process.argv.find((argument) => argument.startsWith("--max-writes="))?.split("=")[1] ?? 25_000);
const ONLY_TABLES = new Set(process.argv
  .filter((argument) => argument.startsWith("--only="))
  .flatMap((argument) => argument.slice("--only=".length).split(",").map((table) => table.trim()).filter(Boolean)));
const PAGE_SIZE = 500;
const VERIFY_PAGE_SIZE = 1000;
const SQL_FILE_CHUNK_BYTES = 8 * 1024 * 1024;
const DB_NAME = "amazecc-api";
const NO_PRIMARY_KEY_TABLES = new Set([
  "class_assessment_stats_legacy",
  "class_assessment_stats_pre_migration_backup",
  "class_overall_stats_pre_migration_backup",
  "class_user_hashes_legacy",
]);
const NON_D1_SOURCE_TABLES = new Set(["student_marks"]);
const FRESH_MARKS_TABLES = new Set([
  "class_overall_stats",
  "class_assessment_stats",
  "class_assessment_metadata",
  "class_user_marks",
  "class_assessment_stats_legacy",
  "class_assessment_stats_pre_migration_backup",
  "class_overall_stats_pre_migration_backup",
  "class_user_hashes_legacy",
]);
const USER_SKIPPED_TABLES = new Set([
  "bus_students",
  "files",
  "visitor_logs",
  "push_subscriptions",
  "gorobo_bundles",
  "gorobo_items",
  "gorobo_orders",
  "gorobo_wallet_entries",
]);

// Keep database-native JSON and dates as source text so JSON null stays
// distinct from SQL NULL and timestamps retain their original timezone.
for (const oid of [1082, 1083, 1114, 1184, 114, 3802]) {
  pg.types.setTypeParser(oid, (value) => value);
}

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = join(ROOT, ".env");
  const envText = readFileSync(envPath, "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*DATABASE_URL\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[1];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  throw new Error("DATABASE_URL must be set in the environment or .env");
}

function runWrangler(args) {
  const wranglerCli = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  const targetArgs = LOCAL_D1 ? args.map((argument) => argument === "--remote" ? "--local" : argument) : args;
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [wranglerCli, ...targetArgs], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const response = error?.stdout?.toString?.() ?? "";
    let details = "";
    for (let index = 0; index < response.length; index++) {
      if (response[index] !== "[" && response[index] !== "{") continue;
      try {
        const parsed = JSON.parse(response.slice(index));
        const errorObject = Array.isArray(parsed) ? parsed.find((item) => item?.error)?.error : parsed?.error;
        details = [errorObject?.text, ...(errorObject?.notes ?? []).map((note) => note?.text)]
          .filter(Boolean).join("; ");
        if (details) break;
      } catch { /* search for the JSON response after Wrangler's progress output */ }
    }
    throw new Error(details ? `Wrangler D1 operation failed: ${details}` : "Wrangler D1 operation failed");
  }
  try {
    return JSON.parse(stdout);
  } catch {
    // `--file` can print Wrangler's progress line before its JSON result.
    // Parse the first complete JSON value without logging the raw output.
    for (let index = 0; index < stdout.length; index++) {
      if (stdout[index] !== "[" && stdout[index] !== "{") continue;
      try { return JSON.parse(stdout.slice(index)); } catch { /* try the next candidate */ }
    }
    throw new Error("Wrangler returned a response that was not valid JSON");
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function rowKey(row, columns) {
  return JSON.stringify(columns.map((column) => row[column] == null ? null : String(row[column])));
}

function compareKeyRows(left, right, columns, sourceColumnTypes) {
  for (const column of columns) {
    const a = left[column];
    const b = right[column];
    if (a == null || b == null) {
      if (a === b) continue;
      return a == null ? -1 : 1;
    }
    const type = String(sourceColumnTypes.get(column) ?? "").toLowerCase();
    if (/int|numeric|decimal|real|double|serial/.test(type)) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) return difference < 0 ? -1 : 1;
      continue;
    }
    if (type === "boolean") {
      const boolA = a === true || a === 1 || a === "1" || a === "true";
      const boolB = b === true || b === 1 || b === "1" || b === "true";
      if (boolA !== boolB) return boolA ? 1 : -1;
      continue;
    }
    if (type === "bytea") {
      const bytesA = Buffer.isBuffer(a) ? a : Buffer.from(String(a), "hex");
      const bytesB = Buffer.isBuffer(b) ? b : Buffer.from(String(b), "hex");
      const order = Buffer.compare(bytesA, bytesB);
      if (order !== 0) return order;
      continue;
    }
    const textA = String(a);
    const textB = String(b);
    const order = Buffer.compare(Buffer.from(textA, "utf8"), Buffer.from(textB, "utf8"));
    if (order !== 0) return order;
  }
  return 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function equivalentValues(source, target) {
  if (source == null || target == null) return source == null && target == null;
  if (Buffer.isBuffer(source)) return Buffer.isBuffer(target) ? source.equals(target) : source.toString("hex") === String(target).replace(/^X'|'$/g, "");
  if (typeof source === "boolean") return target === source || Number(target) === Number(source);
  if (typeof target === "boolean") return source === target || Number(source) === Number(target);
  if (typeof source === "number" || typeof target === "number") {
    const left = Number(source);
    const right = Number(target);
    return Number.isFinite(left) && Number.isFinite(right) && left === right;
  }

  const decodeJson = (value) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
  };
  const left = decodeJson(source);
  const right = decodeJson(target);
  if ((left && typeof left === "object") || (right && typeof right === "object")) {
    return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
  }
  return String(source) === String(target);
}

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return String(value);
  if (Buffer.isBuffer(value)) return `X'${value.toString("hex")}'`;
  const text = value instanceof Date
    ? value.toISOString()
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  return `CAST(X'${Buffer.from(text, "utf8").toString("hex")}' AS TEXT)`;
}

function extractRows(payload) {
  if (!Array.isArray(payload) || !payload[0]?.success) {
    throw new Error("Wrangler returned an unsuccessful D1 response");
  }
  return payload[0].results ?? [];
}

async function* readSourcePages(client, table, selected, order, keyColumns, pageSize) {
  let lastKey = null;
  for (;;) {
    const keysetWhere = lastKey
      ? `WHERE (${order}) > (${keyColumns.map((_, index) => `$${index + 1}`).join(", ")}) `
      : "";
    const limitPosition = keyColumns.length + 1;
    const values = lastKey ? [...keyColumns.map((column) => lastKey[column]), pageSize] : [pageSize];
    const limitPlaceholder = lastKey ? `$${limitPosition}` : "$1";
    const page = await client.query(
      `SELECT ${selected} FROM public.${quoteIdentifier(table)} ${keysetWhere}ORDER BY ${order} LIMIT ${limitPlaceholder}`,
      values,
    );
    if (page.rows.length === 0) return;
    for (const row of page.rows) {
      lastKey = row;
      yield row;
    }
  }
}

function* readD1Pages(table, selected, order, keyColumns, pageSize) {
  let lastKey = null;
  for (;;) {
    const keysetWhere = lastKey
      ? `WHERE (${order}) > (${keyColumns.map((column) => sqlValue(lastKey[column])).join(", ")}) `
      : "";
    const page = extractRows(runWrangler([
      "d1", "execute", DB_NAME, "--remote", "--json",
      "--command", `SELECT ${selected} FROM ${quoteIdentifier(table)} ${keysetWhere}ORDER BY ${order} LIMIT ${pageSize}`,
    ]));
    if (page.length === 0) return;
    for (const row of page) {
      lastKey = row;
      yield row;
    }
  }
}

async function compareSourceAndD1({
  client,
  table,
  sourceSelected,
  targetSelected,
  sourceOrder,
  targetOrder,
  keyColumns,
  sourceColumnTypes,
  columns,
}) {
  const rowsToUpsert = new Set();
  const sourceIterator = readSourcePages(client, table, sourceSelected, sourceOrder, keyColumns, VERIFY_PAGE_SIZE)[Symbol.asyncIterator]();
  const targetIterator = readD1Pages(table, targetSelected, targetOrder, keyColumns, VERIFY_PAGE_SIZE);
  let sourceRows = 0;
  let targetRows = 0;
  const nextSource = async () => {
    const next = await sourceIterator.next();
    if (!next.done) sourceRows++;
    return next;
  };
  const nextTarget = () => {
    const next = targetIterator.next();
    if (!next.done) targetRows++;
    return next;
  };
  let sourceNext = await nextSource();
  let targetNext = nextTarget();
  while (!sourceNext.done) {
    if (targetNext.done) {
      rowsToUpsert.add(rowKey(sourceNext.value, keyColumns));
      sourceNext = await nextSource();
      continue;
    }
    const order = compareKeyRows(sourceNext.value, targetNext.value, keyColumns, sourceColumnTypes);
    if (order < 0) {
      rowsToUpsert.add(rowKey(sourceNext.value, keyColumns));
      sourceNext = await nextSource();
      continue;
    }
    if (order > 0) {
      targetNext = nextTarget();
      continue;
    }
    const mismatches = columns.filter((column) => !equivalentValues(sourceNext.value[column], targetNext.value[column]));
    if (mismatches.length > 0) {
      rowsToUpsert.add(rowKey(sourceNext.value, keyColumns));
    }
    sourceNext = await nextSource();
    targetNext = nextTarget();
  }
  while (!targetNext.done) targetNext = nextTarget();
  return { rowsToUpsert, sourceRows, targetRows };
}

function orderByDependencies(tables, dependencies) {
  const tableSet = new Set(tables);
  const remaining = new Map(tables.map((table) => [
    table,
    new Set((dependencies.get(table) ?? []).filter((parent) => tableSet.has(parent))),
  ]));
  const ordered = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, parents]) => parents.size === 0).map(([table]) => table);
    if (ready.length === 0) {
      throw new Error(`D1 foreign-key cycle prevents import ordering: ${[...remaining.keys()].join(", ")}`);
    }
    for (const table of ready) {
      ordered.push(table);
      remaining.delete(table);
    }
    for (const parents of remaining.values()) {
      for (const table of ready) parents.delete(table);
    }
  }
  return ordered;
}

const BACKFILL_GROUPS = [
  ["student-profiles", "all", ["student_profiles"]],
  ["service-enrollments", "all", ["service_enrollments"]],
  ["app-config", "all", ["app_config"]],
  ["class-data", "all", ["class_data"]],
  ["file-metadata", "all", ["files"]],
  ["api-route-logs", "all", ["api_route_logs"]],
  ["visitor-logs", "all", ["visitor_logs"]],
  ["legacy-admin-users", "all", ["admin_users"]],
  ["admin-audit-logs", "all", ["admin_audit_logs"]],
  ["social-data", "all", ["social_people", "social_grants", "social_timetables", "social_handle_aliases"]],
  ["qbank", "all", ["papers_archive", "qbank_questions", "qbank_topics", "qbank_question_topics"]],
  ["transport-data", "all", ["buses", "buses_v2", "transport_rules", "bus_routes", "bus_stops", "bus_placements"]],
  ["bus-students", "all", ["bus_students"]],
  ["cabshare-data", "all", [
    "cabshare_users", "cabshare_hubs", "cabshare_trips", "cabshare_match_events",
    "cabshare_waitlist", "cabshare_notifications", "cabshare_ratings", "cabshare_blocks",
  ]],
  ["club-data", "all", ["club_details", "club_representatives", "club_landing_pages", "club_feed", "post_promotions"]],
  ["faculty-directory", "all", ["faculty_directory_urls"]],
  ["fresher-resources", "all", ["fresher_resources"]],
  ["push-subscriptions", "all", ["push_subscriptions"]],
  ["gorobo-data", "all", ["gorobo_items", "gorobo_orders", "gorobo_wallet_entries", "gorobo_bundles"]],
  ["marks-statistics", "all", ["class_overall_stats", "class_assessment_stats", "class_assessment_metadata", "class_user_marks", "student_marks"]],
  ["legacy-marks-data", "all", ["class_assessment_stats_legacy", "class_assessment_stats_pre_migration_backup", "class_overall_stats_pre_migration_backup", "class_user_hashes_legacy"]],
  ["class-enrollment-data", "all", ["class_details", "class_enrollment", "class_sync_state"]],
  ["legacy-bus-data", "all", ["bus_routes", "bus_stops", "bus_placements"]],
  ["sync-state", "all", ["app_sync_state"]],
  ["admin-activity-logs", "all", ["admin_activity_logs"]],
  ["ffcs-data", "all", ["ffcs_classes", "ffcs_class_registrations", "ffcs_match_entries"]],
];

function writeBackfillMarker(feature, scopeKey) {
  const sql = `INSERT INTO d1_backfill_scopes (feature, scope_key, completed_at)
    VALUES (${sqlValue(feature)}, ${sqlValue(scopeKey)}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (feature, scope_key) DO UPDATE SET completed_at = excluded.completed_at`;
  runWrangler(["d1", "execute", DB_NAME, "--remote", "--yes", "--json", "--command", sql]);
}

async function main() {
  if (!Number.isSafeInteger(WRITE_BUDGET) || WRITE_BUDGET < 0) {
    throw new Error("--max-writes must be a non-negative safe integer");
  }
  const client = new pg.Client({
    connectionString: loadDatabaseUrl(),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  const tempDir = mkdtempSync(join(tmpdir(), "amazecc-d1-backfill-"));
  try {
    console.log(`[d1-backfill] mode=${APPLY ? "apply" : "dry-run"} target=${LOCAL_D1 ? "local" : "remote"}`);
    await client.connect();

    const d1Tables = new Set(extractRows(runWrangler([
      "d1", "execute", DB_NAME, "--remote", "--json",
      "--command", "SELECT name FROM sqlite_schema WHERE type='table'",
    ])).map((row) => row.name));
    const systemTables = new Set(["_cf_KV", "d1_migrations", "sqlite_sequence"]);
    const unsortedTables = [...d1Tables].filter((name) => !systemTables.has(name)).sort();
    const sourceTables = (await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    )).rows.map((row) => row.table_name);
    const sourceTableSet = new Set(sourceTables);
    const missingSchemas = sourceTables.filter((name) => !d1Tables.has(name) && !NON_D1_SOURCE_TABLES.has(name));
    if (APPLY && missingSchemas.length > 0) {
      throw new Error(`D1 schema is missing source tables; no data was copied: ${missingSchemas.join(", ")}`);
    }

    // Build an exact insert/update plan before the first write. Identical rows
    // are not charged again, and reruns resume from rows that still differ.
    const planTables = ONLY_TABLES.size > 0
      ? [...ONLY_TABLES]
      : unsortedTables.filter((table) => sourceTableSet.has(table));
    const comparisonsByTable = new Map();
    const writeCostByTable = new Map();
    const rowWriteCost = (table) => {
      if (!writeCostByTable.has(table)) {
        const indexes = extractRows(runWrangler([
          "d1", "execute", DB_NAME, "--remote", "--json",
          "--command", `PRAGMA index_list('${table}')`,
        ]));
        // One base-table row plus one write for each index. This deliberately
        // overestimates updates because some indexes may not change.
        writeCostByTable.set(table, 1 + indexes.length);
      }
      return writeCostByTable.get(table);
    };
    let changedDataRows = 0;
    let estimatedDataWrites = 0;
    for (const table of planTables) {
      if (USER_SKIPPED_TABLES.has(table) || FRESH_MARKS_TABLES.has(table) || !sourceTableSet.has(table) || !d1Tables.has(table)) continue;
      const primary = await client.query(
        `SELECT kcu.column_name FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
          AND tc.table_name = kcu.table_name
         WHERE tc.table_schema = 'public' AND tc.table_name = $1
           AND tc.constraint_type = 'PRIMARY KEY'
         ORDER BY kcu.ordinal_position`,
        [table],
      );
      if (primary.rows.length === 0) continue;
      const keyColumns = primary.rows.map((row) => row.column_name);
      const sourceColumns = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      );
      const d1ColumnInfo = extractRows(runWrangler([
        "d1", "execute", DB_NAME, "--remote", "--json",
        "--command", `PRAGMA table_info('${table}')`,
      ]));
      const d1ColumnNames = new Set(d1ColumnInfo.map((column) => column.name));
      const absentColumns = sourceColumns.rows.map((row) => row.column_name).filter((name) => !d1ColumnNames.has(name));
      if (absentColumns.length > 0) continue;
      const sourceColumnNames = new Set(sourceColumns.rows.map((row) => row.column_name));
      const unmappedRequired = d1ColumnInfo.filter((column) =>
        column.notnull && !column.pk && column.dflt_value === null && !sourceColumnNames.has(column.name),
      );
      if (unmappedRequired.length > 0) continue;
      const columnTypes = new Map(sourceColumns.rows.map((row) => [row.column_name, row.data_type]));
      const columns = sourceColumns.rows.map((row) => row.column_name);
      const selected = columns.map(quoteIdentifier).join(", ");
      const keyOrder = keyColumns.map((column) => {
        const identifier = quoteIdentifier(column);
        return ["text", "character varying", "character"].includes(columnTypes.get(column))
          ? `${identifier} COLLATE "C"`
          : identifier;
      }).join(", ");
      const targetOrder = keyColumns.map((column) => {
        const identifier = quoteIdentifier(column);
        return ["text", "character varying", "character"].includes(columnTypes.get(column))
          ? `${identifier} COLLATE BINARY`
          : identifier;
      }).join(", ");
      const comparison = await compareSourceAndD1({
        client,
        table,
        sourceSelected: selected,
        targetSelected: selected,
        sourceOrder: keyOrder,
        targetOrder,
        keyColumns,
        sourceColumnTypes: columnTypes,
        columns,
      });
      comparisonsByTable.set(table, comparison);
      changedDataRows += comparison.rowsToUpsert.size;
      estimatedDataWrites += comparison.rowsToUpsert.size * rowWriteCost(table);
    }

    const marksResetRequired = APPLY && ONLY_TABLES.size === 0
      ? extractRows(runWrangler([
        "d1", "execute", DB_NAME, "--remote", "--json",
        "--command", "SELECT 1 AS reset FROM d1_backfill_scopes WHERE feature = 'marks-fresh-rebuild' AND scope_key = 'all'",
      ])).length === 0
      : false;
    let marksResetWrites = 0;
    if (marksResetRequired) {
      for (const table of FRESH_MARKS_TABLES) {
        if (!d1Tables.has(table)) continue;
        const rows = Number(extractRows(runWrangler([
          "d1", "execute", DB_NAME, "--remote", "--json",
          "--command", `SELECT count(*) AS count FROM ${quoteIdentifier(table)}`,
        ]))[0]?.count ?? 0);
        marksResetWrites += rows * rowWriteCost(table);
      }
    }
    const ffcsSemesterCount = APPLY && ONLY_TABLES.size === 0
      && ["ffcs_classes", "ffcs_class_registrations", "ffcs_match_entries"].every((table) => sourceTableSet.has(table))
      ? Number((await client.query(`SELECT count(DISTINCT semester_id)::bigint AS count FROM ffcs_classes`)).rows[0].count)
      : 0;
    const excludedFeatures = BACKFILL_GROUPS
      .filter(([, , tables]) => tables.some((table) => USER_SKIPPED_TABLES.has(table)))
      .map(([feature]) => feature);
    const staleExcludedMarkers = APPLY && ONLY_TABLES.size === 0
      ? extractRows(runWrangler([
        "d1", "execute", DB_NAME, "--remote", "--json",
        "--command", `SELECT feature, scope_key FROM d1_backfill_scopes WHERE feature IN (${excludedFeatures.map(sqlValue).join(", ")})`,
      ]))
      : [];
    const markerRowsBudget = APPLY && ONLY_TABLES.size === 0
      ? BACKFILL_GROUPS.filter(([, , tables]) => !tables.some((table) => USER_SKIPPED_TABLES.has(table))).length + 1 + ffcsSemesterCount
      : 0;
    const markerRowWriteCost = markerRowsBudget > 0 || staleExcludedMarkers.length > 0
      ? rowWriteCost("d1_backfill_scopes")
      : 0;
    const markerWritesBudget = markerRowsBudget * markerRowWriteCost;
    const excludedMarkerDeleteWrites = staleExcludedMarkers.length * markerRowWriteCost;
    const estimatedWrites = estimatedDataWrites + marksResetWrites + markerWritesBudget + excludedMarkerDeleteWrites;
    console.log(`[d1-backfill] estimated D1 row writes: ${estimatedWrites} (changed data ${changedDataRows} rows/${estimatedDataWrites} writes, marks reset ${marksResetWrites}, marker reserve ${markerWritesBudget}, excluded-marker cleanup ${excludedMarkerDeleteWrites}; budget ${WRITE_BUDGET})`);
    const requiredFixedWrites = marksResetWrites + markerWritesBudget + excludedMarkerDeleteWrites;
    if (APPLY && requiredFixedWrites > WRITE_BUDGET) {
      throw new Error(`Preflight stopped before any writes: marks reset and reserved completion markers require approximately ${requiredFixedWrites} D1 row writes, above --max-writes=${WRITE_BUDGET}.`);
    }
    if (APPLY && estimatedWrites > WRITE_BUDGET) {
      console.log("[d1-backfill] this run will stop at the write budget and can be resumed safely; no already-present primary keys will be reinserted");
    }
    const dataWriteBudget = Math.max(0, WRITE_BUDGET - requiredFixedWrites);
    let remainingDataWrites = dataWriteBudget;

    if (APPLY && ONLY_TABLES.size === 0) {
      if (staleExcludedMarkers.length > 0) {
        runWrangler([
          "d1", "execute", DB_NAME, "--remote", "--yes", "--json",
          "--command", `DELETE FROM d1_backfill_scopes WHERE feature IN (${excludedFeatures.map(sqlValue).join(", ")})`,
        ]);
      }
      const marksReset = extractRows(runWrangler([
        "d1", "execute", DB_NAME, "--remote", "--json",
        "--command", "SELECT 1 AS reset FROM d1_backfill_scopes WHERE feature = 'marks-fresh-rebuild' AND scope_key = 'all'",
      ])).length > 0;
      if (!marksReset) {
        for (const table of FRESH_MARKS_TABLES) {
          if (d1Tables.has(table)) {
            runWrangler(["d1", "execute", DB_NAME, "--remote", "--yes", "--json", "--command",
              `DELETE FROM ${quoteIdentifier(table)}`]);
          }
        }
        writeBackfillMarker("marks-fresh-rebuild", "all");
      }
    }
    for (const table of ONLY_TABLES) {
      if (!d1Tables.has(table) || !sourceTableSet.has(table)) {
        throw new Error(`Requested backfill table is not present in both databases: ${table}`);
      }
    }
    const dependencyTables = ONLY_TABLES.size > 0
      ? unsortedTables.filter((table) => ONLY_TABLES.has(table))
      : unsortedTables;
    const dependencies = new Map();
    for (const table of dependencyTables) {
      const foreignKeys = extractRows(runWrangler([
        "d1", "execute", DB_NAME, "--remote", "--json",
        "--command", `PRAGMA foreign_key_list('${table}')`,
      ]));
      dependencies.set(table, foreignKeys.map((foreignKey) => foreignKey.table));
    }
    const targetTables = orderByDependencies(dependencyTables, dependencies);
    const summaries = missingSchemas.length ? [{ schemaMissing: missingSchemas }] : [];
    const verifiedTables = new Set();
    if (sourceTableSet.has("student_marks")) {
      summaries.push({ table: "student_marks", skipped: "Marks will be collected afresh from attendance sync." });
      verifiedTables.add("student_marks");
    }

    for (const table of targetTables) {
      if (FRESH_MARKS_TABLES.has(table)) {
        summaries.push({ table, skipped: "Marks and cohort statistics will be collected afresh from attendance sync." });
        verifiedTables.add(table);
        continue;
      }
      if (USER_SKIPPED_TABLES.has(table)) {
        summaries.push({ table, skipped: "Left untouched per user instruction; this table and its feature group are not marked migrated." });
        continue;
      }
      const sourceColumns = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      );
      if (sourceColumns.rows.length === 0) continue;

      const targetColumnInfo = extractRows(runWrangler([
        "d1", "execute", DB_NAME, "--remote", "--json",
        "--command", `PRAGMA table_info('${table}')`,
      ]));
      const targetColumnSet = new Set(targetColumnInfo.map((column) => column.name));
      const sourceColumnNames = sourceColumns.rows.map((row) => row.column_name);
      const sourceColumnTypes = new Map(sourceColumns.rows.map((row) => [row.column_name, row.data_type]));
      const columns = sourceColumnNames;
      const missingColumns = columns.filter((name) => !targetColumnSet.has(name));
      if (missingColumns.length > 0) {
        summaries.push({ table, skipped: `D1 schema is missing source columns: ${missingColumns.join(", ")}` });
        continue;
      }
      const requiredUnmapped = targetColumnInfo.filter((column) =>
        column.notnull && !column.pk && column.dflt_value === null && !columns.includes(column.name),
      );
      if (requiredUnmapped.length > 0) {
        summaries.push({ table, skipped: `D1 has required columns with no source: ${requiredUnmapped.map((column) => column.name).join(", ")}` });
        continue;
      }
      if (columns.length === 0) {
        summaries.push({ table, skipped: "no matching columns" });
        continue;
      }

      const primary = await client.query(
        `SELECT kcu.column_name FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
          AND tc.table_name = kcu.table_name
         WHERE tc.table_schema = 'public' AND tc.table_name = $1
           AND tc.constraint_type = 'PRIMARY KEY'
         ORDER BY kcu.ordinal_position`,
        [table],
      );
      const hasPrimaryKey = primary.rows.length > 0;
      if (!hasPrimaryKey && !NO_PRIMARY_KEY_TABLES.has(table)) {
        summaries.push({ table, skipped: "source table has no primary key" });
        continue;
      }

      const sourceSelected = sourceColumnNames.map(quoteIdentifier).join(", ");
      const selected = columns.map(quoteIdentifier).join(", ");
      const orderColumns = hasPrimaryKey ? primary.rows.map((row) => row.column_name) : columns;
      const sourceOrder = orderColumns.map((column) => {
        const identifier = quoteIdentifier(column);
        return ["text", "character varying", "character"].includes(sourceColumnTypes.get(column))
          ? `${identifier} COLLATE "C"`
          : identifier;
      }).join(", ");
      const targetOrder = orderColumns.map((column) => {
        const identifier = quoteIdentifier(column);
        return ["text", "character varying", "character"].includes(sourceColumnTypes.get(column))
          ? `${identifier} COLLATE BINARY`
          : identifier;
      }).join(", ");
      const primaryKey = orderColumns.map(quoteIdentifier).join(", ");
      const primarySet = new Set(orderColumns);
      const updates = columns.filter((column) => !primarySet.has(column));
      const conflictAction = hasPrimaryKey && updates.length
        ? `ON CONFLICT (${primaryKey}) DO UPDATE SET ${updates.map((column) =>
          `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(", ")}`
        : hasPrimaryKey ? `ON CONFLICT (${primaryKey}) DO NOTHING` : "";
      const comparison = comparisonsByTable.get(table);
      const sourceCount = comparison?.sourceRows ?? 0;
      const existingCount = comparison?.targetRows ?? 0;
      const upsertKeys = comparison?.rowsToUpsert ?? new Set();
      summaries.push({ table, sourceRows: sourceCount, d1RowsBefore: existingCount, rowsToWrite: upsertKeys.size });

      if (!APPLY) continue;
      if (!hasPrimaryKey) {
        summaries[summaries.length - 1].skipped = "source table has no primary key; refusing a destructive replace";
        continue;
      }
      const writesPerRow = rowWriteCost(table);
      const rowsThatFitBudget = Math.floor(remainingDataWrites / writesPerRow);
      const keysToImport = [...upsertKeys].slice(0, rowsThatFitBudget);
      const keyBudgetExhausted = keysToImport.length < upsertKeys.size;
      remainingDataWrites -= keysToImport.length * writesPerRow;
      const keysToImportSet = new Set(keysToImport);
      if (keysToImport.length === 0 && upsertKeys.size > 0) {
        summaries[summaries.length - 1].resumable = true;
        console.log(`[d1-backfill] ${table}: write budget reached; ${upsertKeys.size} rows remain for a later run`);
        break;
      }
      console.log(`[d1-backfill] ${table}: inserting/updating ${keysToImport.length} changed rows`);

      let sqlBuffer = "";
      let sqlBufferBytes = 0;
      let chunkIndex = 0;
      const tableFileKey = Buffer.from(table, "utf8").toString("hex");
      const flushSqlBuffer = () => {
        if (!sqlBuffer) return;
        const sqlPath = join(tempDir, `${tableFileKey}-${chunkIndex++}.sql`);
        writeFileSync(sqlPath, sqlBuffer, "utf8");
        runWrangler(["d1", "execute", DB_NAME, "--remote", "--yes", "--json", "--file", sqlPath]);
        sqlBuffer = "";
        sqlBufferBytes = 0;
      };
      for await (const sourceRow of readSourcePages(client, table, sourceSelected, sourceOrder, orderColumns, PAGE_SIZE)) {
        if (!keysToImportSet.has(rowKey(sourceRow, orderColumns))) continue;
          const values = columns.map((column) => sqlValue(sourceRow[column])).join(", ");
          const statement = `INSERT INTO ${quoteIdentifier(table)} (${selected}) VALUES (${values}) ${conflictAction};\n`;
          if (sqlBufferBytes + Buffer.byteLength(statement) > SQL_FILE_CHUNK_BYTES) flushSqlBuffer();
          sqlBuffer += statement;
          sqlBufferBytes += Buffer.byteLength(statement);
      }
      flushSqlBuffer();

      if (keyBudgetExhausted) {
        summaries[summaries.length - 1].importedRows = keysToImport.length;
        summaries[summaries.length - 1].resumable = true;
        console.log(`[d1-backfill] ${table}: stopped at the write budget; rerun to resume the remaining rows`);
        break;
      }

      // D1-only rows are preserved. Every source key and value is checked
      // after the import before the feature can be marked complete.
      const remaining = await compareSourceAndD1({
        client,
        table,
        sourceSelected,
        targetSelected: selected,
        sourceOrder,
        targetOrder,
        keyColumns: orderColumns,
        sourceColumnTypes,
        columns,
      });
      if (remaining.targetRows < sourceCount) {
        throw new Error(`${table}: D1 has ${remaining.targetRows} rows, source has ${sourceCount}`);
      }
      if (remaining.rowsToUpsert.size > 0) {
        throw new Error(`${table}: ${remaining.rowsToUpsert.size} source rows still differ after import`);
      }
      summaries[summaries.length - 1].d1RowsAfter = remaining.targetRows;
      verifiedTables.add(table);
      console.log(`[d1-backfill] ${table}: verified ${remaining.targetRows} rows`);
    }

    if (APPLY && ONLY_TABLES.size === 0) {
      for (const [feature, scopeKey, tables] of BACKFILL_GROUPS) {
        if (tables.some((table) => USER_SKIPPED_TABLES.has(table))) continue;
        if (tables.every((table) => sourceTableSet.has(table) && verifiedTables.has(table))) {
          writeBackfillMarker(feature, scopeKey);
        }
      }
      if (["ffcs_classes", "ffcs_class_registrations", "ffcs_match_entries"]
        .every((table) => sourceTableSet.has(table) && verifiedTables.has(table))) {
        const semesters = (await client.query(`SELECT DISTINCT semester_id FROM ffcs_classes ORDER BY semester_id`)).rows;
        for (const { semester_id: semesterId } of semesters) {
          writeBackfillMarker("ffcs-semester", String(semesterId).trim().toUpperCase());
        }
      }
    }

    console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", tables: summaries }, null, 2));
    if (!APPLY) console.log("No rows written. Pass --apply after all required D1 schemas are migrated.");
  } catch (error) {
    throw error;
  } finally {
    await client.end().catch(() => {});
    const tempPath = resolve(tempDir);
    if (dirname(tempPath) === resolve(tmpdir()) && basename(tempPath).startsWith("amazecc-d1-backfill-")) {
      rmSync(tempPath, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

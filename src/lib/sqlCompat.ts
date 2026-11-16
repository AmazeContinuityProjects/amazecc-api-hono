type QueryResultRow = Record<string, any>;
import { getWorkerEnv } from "../env";

const JSON_COLUMNS = new Set([
  "details", "items", "tags", "links", "image_urls", "theme", "showcase_projects",
  "popular_events", "seat_options", "stops", "placements", "register_nos", "busy_map",
  "courses", "class_ids", "options",
]);
const BOOLEAN_COLUMNS = new Set([
  "is_active", "is_read", "in_stock", "has_promoted", "discoverable", "vitol_enabled",
]);

function normalizeBinding(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normalizeD1Rows<T extends QueryResultRow>(rows: T[]): T[] {
  return rows.map((source) => {
    const row = { ...source } as Record<string, unknown>;
    for (const [column, value] of Object.entries(row)) {
      if (JSON_COLUMNS.has(column) && typeof value === "string") {
        try { row[column] = JSON.parse(value); } catch { /* keep invalid legacy JSON as text */ }
      } else if (BOOLEAN_COLUMNS.has(column) && value != null) {
        row[column] = value === true || value === 1 || value === "1";
      }
    }
    return row as T;
  });
}

/** Compatibility query interface for route code running exclusively on D1. */
export function getAppDataDb(): {
  query<T extends QueryResultRow = any>(sql: string, values?: unknown[]): Promise<{
    rows: T[];
    rowCount: number | null;
  }>;
} {
  const d1 = getWorkerEnv().APP_DB;
  if (!d1) throw new Error("APP_DB is not configured");

  return {
    async query<T extends QueryResultRow = any>(sql: string, values: unknown[] = []) {
      const orderedValues: unknown[] = [];
      const sqliteSql = sql.replace(/\$(\d+)/g, (_match, position: string) => {
        orderedValues.push(normalizeBinding(values[Number(position) - 1]));
        return "?";
      });
      const statement = d1.prepare(sqliteSql).bind(...orderedValues);
      try {
        if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
          const result = await statement.all<T>();
          return { rows: normalizeD1Rows(result.results), rowCount: result.results.length };
        }
        const result = await statement.run();
        return { rows: [], rowCount: result.meta.changes ?? 0 };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(message)) {
          Object.assign(error instanceof Error ? error : {}, { code: "23505" });
        }
        throw error;
      }
    },
  };
}

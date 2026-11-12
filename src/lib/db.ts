import pg from "pg";
import { getWorkerEnv } from "../env";

let pool: pg.Pool | undefined;

/**
 * One shared pool. On Workers, Hyperdrive terminates TCP at the edge and the
 * `pg` driver talks to the Hyperdrive origin over Workers-native sockets
 * (`nodejs_compat`). Locally, DATABASE_URL is used directly (e.g. a Supabase
 * pooler or a local Postgres).
 *
 * Pool size stays tiny (5) for the same reason as the original serverless
 * setup: don't exhaust the upstream pooler.
 */
function createPool(): pg.Pool {
  const env = getWorkerEnv();
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "No database connection configured. Bind HYPERDRIVE (production) or set DATABASE_URL (local dev)."
    );
  }

  const p = new pg.Pool({
    connectionString,
    // Hyperdrive connections are short-lived; keep the pool tiny.
    max: parseInt(env.PG_POOL_MAX || "5", 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  p.on("error", (err: unknown) => {
    console.error("[db] Unexpected pool error:", err);
  });

  return p;
}

export function getDbPool(): pg.Pool {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

/** Testing helper: drop the cached pool (e.g. after credentials rotate). */
export function resetDbPool(): void {
  pool?.end().catch(() => {});
  pool = undefined;
}

// Helper for route handlers to map low-level pg errors to user-facing HTTP status
export function isCircuitBreakerError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return (
    msg.includes("ECIRCUITBREAKER") ||
    msg.includes("too many authentication failures") ||
    msg.includes("too many connections")
  );
}

export function getDbErrorStatus(error: unknown): number {
  return isCircuitBreakerError(error) ? 503 : 500;
}

export function getDbErrorMessage(error: unknown): string {
  // Client-facing: never echo the driver's message (table names, SQL, hosts).
  if (isCircuitBreakerError(error)) {
    console.error("[db] circuit breaker: verify database credentials and wait ~60s", error);
    return "Database temporarily unavailable. Please try again in a minute.";
  }
  console.error("[db] error hidden from client:", error);
  return "Internal database error";
}

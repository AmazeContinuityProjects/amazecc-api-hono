/**
 * Hyperdrive-aware database access.
 *
 * IMPORTANT (Cloudflare Hyperdrive + node-postgres): do NOT use a global
 * `pg.Pool` here. Hyperdrive pools origin connections for you; keeping a
 * module-scope Pool lets Workers hold stale sockets across isolate reuse,
 * which stalls queries until the driver's connection timeout fires
 * (observed as ~60+ s requests that end canceled). The documented pattern is
 * a NEW `Client` per unit of work (per query / per HTTP request).
 *
 * This module keeps the call sites simple and byte-compatible:
 *   const pool = getDbPool();
 *   const { rows } = await pool.query(sql, params);
 *   const client = await pool.connect();   // pins one connection (transaction)
 *   await client.query("BEGIN");
 *   …
 *   client.release();                       // ends the client connection
 */
import pg from "pg";
import type { QueryResultRow } from "pg";
import { getWorkerEnv } from "../env";

function connectionString(): string {
  const env = getWorkerEnv();
  const value = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!value) {
    throw new Error(
      "No database connection configured. Bind HYPERDRIVE (production) or set DATABASE_URL (local dev)."
    );
  }
  return value;
}

/** One-shot client wrapper. opens lazily, ends explicitly. */
class WorkerClient {
  private client: pg.Client | null = null;

  private async ensure(): Promise<pg.Client> {
    if (!this.client) {
      const c = new pg.Client({ connectionString: connectionString() });
      await c.connect();
      this.client = c;
    }
    return this.client;
  }

  /** Open the connection eagerly (used by connect() to pin one connection). */
  async open(): Promise<void> {
    await this.ensure();
  }

  async query<T extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>> {
    const client = await this.ensure();
    return client.query<T>(text, values);
  }

  async end(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) {
      await c.end().catch(() => {});
    }
  }
}

export interface Queryable {
  query<T extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
  connect(): Promise<DbClient>;
}

export interface DbClient {
  query<T extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
  release(): Promise<void>;
}

export function getDbPool(): Queryable {
  return {
    async query(text, values) {
      const client = new WorkerClient();
      try {
        return await client.query(text, values);
      } finally {
        await client.end();
      }
    },

    async connect() {
      const client = new WorkerClient();
      // Pin one connection for the whole multi-statement transaction.
      await client.open();
      return {
        query: (text: string, values?: unknown[]) => client.query(text, values),
        release: () => client.end(),
      };
    },
  };
}

/** Testing helper kept for API compatibility (no-op now). */
export function resetDbPool(): void {
  // Each query opens and closes its own client; nothing to reset.
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

/**
 * Worker environment plumbing.
 *
 * Shared libs (db, mask, auth) are called from route handlers but cannot see
 * Hono's `c.env`. Workers populate bindings per-fetch; we stash them on a
 * module-level singleton at the entry point instead of threading them through
 * every call site. Module state is per-isolate and never shared across
 * tenants of the same deployment.
 */

export interface WorkerEnv {
  /** Hyperdrive binding (production). Falls back to DATABASE_URL when absent. */
  HYPERDRIVE?: Hyperdrive;
  /** Direct connection string - local dev only. */
  DATABASE_URL?: string;
  /**
   * Shared amazecc-auth D1 database. Amaze ID users/sessions are looked up
   * here; there is no per-service identity store.
   */
  AUTH_DB?: D1Database;
  ADMIN_SECRET?: string;
  ID_SALT?: string;
  ADMIN_VTOP_IDS?: string;
  TRUSTED_IP_HEADER?: string;
  VTOP_BASE_URL?: string;
  PG_POOL_MAX?: string;
  VAPID_PRIVATE_KEY?: string;
  NEXT_PUBLIC_VAPID_PUBLIC_KEY?: string;
  CRON_SECRET?: string;
  SYNC_QUEUE?: Queue;
  /** B2 / S3-compatible storage for qbank admin + papers (aws4fetch signed). */
  B2_REGION?: string;
  B2_ENDPOINT?: string;
  B2_ACCESS_KEY_ID?: string;
  B2_SECRET_ACCESS_KEY?: string;
  B2_BUCKET_NAME?: string;
}

let current: WorkerEnv = {};

export function setWorkerEnv(env: WorkerEnv): void {
  current = env;
}

export function getWorkerEnv(): WorkerEnv {
  return current;
}

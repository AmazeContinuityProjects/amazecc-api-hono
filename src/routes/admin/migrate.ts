import { getWorkerEnv } from "../../env";
import { requireSuperadmin } from "../../lib/auth";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../lib/rateLimit";

/** D1 schema changes are versioned and applied by Wrangler, outside requests. */
export async function POST(req: Request) {
  const auth = await requireSuperadmin(req);
  if (auth instanceof Response) return auth;

  const rl = checkRateLimit(`migrate:${getClientIp(req)}`, 3, 300_000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  return Response.json({
    success: false,
    error: "worker_migrations_disabled",
    message: "Apply versioned schema migrations with Wrangler rather than running DDL from a request.",
    command: "pnpm exec wrangler d1 migrations apply amazecc-api --remote",
  }, { status: 409 });
}

/** D1 connectivity check and inventory of the service-data schema. */
export async function GET(req: Request) {
  const auth = await requireSuperadmin(req);
  if (auth instanceof Response) return auth;

  const db = getWorkerEnv().APP_DB;
  if (!db) return Response.json({ connected: false, error: "APP_DB binding is not configured" }, { status: 503 });

  try {
    const [clock, tableResult] = await Promise.all([
      db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS time").first<{ time: string }>(),
      db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all<{ name: string }>(),
    ]);
    return Response.json({
      connected: true,
      db: "amazecc-api",
      serverTime: clock?.time ?? null,
      tables: tableResult.results.map((row) => row.name),
    });
  } catch (error: unknown) {
    console.error("D1 check failed:", error);
    return Response.json({ connected: false, error: "Internal server error" }, { status: 500 });
  }
}

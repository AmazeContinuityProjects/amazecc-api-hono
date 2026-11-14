/**
 * Native /api/notifications/* — Amaze ID-attributed push subscriptions.
 */
import { Hono } from "hono";
import { verifyAmazeSession, adminUnauthorized } from "../lib/amazeId";
import { getDbPool } from "../lib/db";

export const notificationsRouter = new Hono();

async function requireIdentity(c: { req: { raw: Request } }) {
  const identity = await verifyAmazeSession(c.req.raw);
  if (!identity) return adminUnauthorized();
  return identity;
}

notificationsRouter.post("/subscribe", async (c) => {
  const identity = await requireIdentity(c);
  if (identity instanceof Response) return identity;

  const body = await c.req.json().catch(() => null) as {
    subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    settings?: Record<string, unknown>;
    vitol_enabled?: boolean;
    vitol_reminder_day?: number | string | null;
    vitol_reminder_time?: string | null;
  } | null;

  if (!body || !body.subscription?.endpoint) {
    return Response.json({ success: false, error: "Invalid payload" }, { status: 400 });
  }

  const p256dh = body.subscription.keys?.p256dh || "";
  const auth = body.subscription.keys?.auth || "";
  const vitolEnabled = !!(body.vitol_enabled ?? (body.settings as Record<string, unknown> | undefined)?.pushNotificationsEnabled);
  const vitolDay = body.vitol_reminder_day ?? null;
  const vitolTime = typeof body.vitol_reminder_time === "string" ? body.vitol_reminder_time : null;

  const pool = getDbPool();
  await pool.query(
    `INSERT INTO push_subscriptions
      (user_id, endpoint, p256dh, auth, vitol_enabled, vitol_reminder_day, vitol_reminder_time, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (endpoint)
     DO UPDATE SET user_id = EXCLUDED.user_id,
                   p256dh = EXCLUDED.p256dh,
                   auth = EXCLUDED.auth,
                   vitol_enabled = EXCLUDED.vitol_enabled,
                   vitol_reminder_day = EXCLUDED.vitol_reminder_day,
                   vitol_reminder_time = EXCLUDED.vitol_reminder_time,
                   updated_at = now()`,
    [identity.name, body.subscription.endpoint, p256dh, auth, vitolEnabled, vitolDay, vitolTime],
  );

  return Response.json({ success: true });
});

notificationsRouter.post("/unsubscribe", async (c) => {
  const identity = await requireIdentity(c);
  if (identity instanceof Response) return identity;

  const body = await c.req.json().catch(() => null) as { endpoint?: string } | null;
  if (!body?.endpoint) {
    return Response.json({ success: false, error: "Missing endpoint" }, { status: 400 });
  }

  const pool = getDbPool();
  await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [body.endpoint]);
  return Response.json({ success: true });
});

notificationsRouter.get("/status", async (c) => {
  const endpoint = new URL(c.req.raw.url).searchParams.get("endpoint");
  if (!endpoint) {
    return Response.json({ success: false, error: "Missing endpoint" }, { status: 400 });
  }

  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT vitol_enabled, vitol_reminder_day, vitol_reminder_time FROM push_subscriptions WHERE endpoint = $1 LIMIT 1`,
    [endpoint],
  );

  if (rows.length === 0) {
    return Response.json({ vitol: false, vitol_reminder_day: 1, vitol_reminder_time: "10:00" });
  }

  return Response.json({
    vitol: !!rows[0].vitol_enabled,
    vitol_reminder_day: Number(rows[0].vitol_reminder_day ?? 1),
    vitol_reminder_time: String(rows[0].vitol_reminder_time ?? "10:00"),
  });
});

/**
 * GET /api/services/cabshare/notifications — my notifications.
 * PATCH /api/services/cabshare/notifications — mark as read.
 *
 * Auth: Amaze ID (DPoP).
 */
import { Hono } from "hono";
import { requireCabshareUser, ensureCabshareSchema, ensureCabshareUser, CABSHARE_NOTIFICATIONS_TABLE } from "../../../../src/lib/cabshare";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { getWorkerEnv } from "../../../../src/env";

export const cabshareNotificationsRouter = new Hono();

cabshareNotificationsRouter.get("/notifications", async (c) => {
  try {
    const regNo = await requireCabshareUser(c);
    if (regNo instanceof Response) return regNo;

    await ensureCabshareSchema();
    const user = await ensureCabshareUser(regNo);

    const appDb = getWorkerEnv().APP_DB;
    if (!appDb) throw new Error("APP_DB is not configured");
    const rows = (await appDb.prepare(`SELECT * FROM ${CABSHARE_NOTIFICATIONS_TABLE}
      WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).bind(user.user_id).all()).results;

    return c.json({ success: true, notifications: rows }, 200);
  } catch (err: unknown) {
    console.error("[cabshare] notifications GET error:", err);
    return c.json(
      { success: false, error: "Internal server error" },
      500,
    );
  }
});

cabshareNotificationsRouter.patch("/notifications", async (c) => {
  try {
    const regNo = await requireCabshareUser(c);
    if (regNo instanceof Response) return regNo;

    await ensureCabshareSchema();
    const user = await ensureCabshareUser(regNo);

    const body = (await c.req.json().catch(() => ({}))) as {
      notif_id?: string | number;
    };

    const appDb = getWorkerEnv().APP_DB;
    if (!appDb) throw new Error("APP_DB is not configured");
    if (body.notif_id === "all") {
      await appDb.prepare(`UPDATE ${CABSHARE_NOTIFICATIONS_TABLE} SET is_read = 1 WHERE user_id = ?`)
        .bind(user.user_id).run();
    } else if (body.notif_id) {
      await appDb.prepare(`UPDATE ${CABSHARE_NOTIFICATIONS_TABLE} SET is_read = 1 WHERE notif_id = ? AND user_id = ?`)
        .bind(body.notif_id, user.user_id).run();
    }

    return c.json({ success: true, message: "Marked as read" }, 200);
  } catch (err: unknown) {
    console.error("[cabshare] notifications PATCH error:", err);
    return c.json(
      { success: false, error: "Internal server error" },
      500,
    );
  }
});

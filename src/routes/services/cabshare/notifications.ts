/**
 * GET /api/services/cabshare/notifications — my notifications.
 * PATCH /api/services/cabshare/notifications — mark as read.
 *
 * Auth: Amaze ID (DPoP).
 */
import { Hono } from "hono";
import { requireCabshareUser, ensureCabshareSchema, ensureCabshareUser, CABSHARE_NOTIFICATIONS_TABLE, cabshareUserIdFromOwnerKey } from "../../../../src/lib/cabshare";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { getDbPool } from "../../../../src/lib/db";

export const cabshareNotificationsRouter = new Hono();

cabshareNotificationsRouter.get("/notifications", async (c) => {
  try {
    const regNo = await requireCabshareUser(c);
    if (regNo instanceof Response) return regNo;

    await ensureCabshareSchema();
    const user = await ensureCabshareUser(regNo);

    const pool = getDbPool();
    const { rows } = await pool.query(
      `SELECT * FROM ${CABSHARE_NOTIFICATIONS_TABLE}
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [user.user_id],
    );

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

    const pool = getDbPool();
    if (body.notif_id === "all") {
      await pool.query(
        `UPDATE ${CABSHARE_NOTIFICATIONS_TABLE} SET is_read = TRUE WHERE user_id = $1`,
        [user.user_id],
      );
    } else if (body.notif_id) {
      await pool.query(
        `UPDATE ${CABSHARE_NOTIFICATIONS_TABLE} SET is_read = TRUE WHERE notif_id = $1 AND user_id = $2`,
        [body.notif_id, user.user_id],
      );
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

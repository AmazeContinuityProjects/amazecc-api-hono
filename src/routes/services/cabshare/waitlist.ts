/**
 * POST /api/services/cabshare/waitlist — add to waitlist.
 *
 * Body: { hub_id, travel_date }
 *
 * Auth: Amaze ID (DPoP).
 */
import { Hono } from "hono";
import { requireCabshareUser, ensureCabshareSchema, ensureCabshareUser, CABSHARE_WAITLIST_TABLE } from "../../../../src/lib/cabshare";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { getDbPool } from "../../../../src/lib/db";

export const cabshareWaitlistRouter = new Hono();

cabshareWaitlistRouter.post("/waitlist", async (c) => {
  try {
    const regNo = await requireCabshareUser(c);
    if (regNo instanceof Response) return regNo;

    await ensureCabshareSchema();
    const user = await ensureCabshareUser(regNo);

    // Phone number is mandatory to use cab share
    if (!user.phone_number) {
      return c.json(
        {
          success: false,
          error: "phone_number_required",
          detail: { detail: "Please register your phone number via /api/profile/phone before joining the waitlist" },
        },
        403,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      hub_id?: string | number;
      travel_date?: string;
    };

    if (!body.hub_id || !body.travel_date) {
      return c.json(
        { success: false, error: "Missing hub_id or travel_date" },
        400,
      );
    }

    const pool = getDbPool();
    await pool.query(
      `INSERT INTO ${CABSHARE_WAITLIST_TABLE} (user_id, hub_id, travel_date)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [user.user_id, body.hub_id, body.travel_date],
    );

    return c.json({ success: true, message: "Added to waitlist" }, 200);
  } catch (err: unknown) {
    console.error("[cabshare] waitlist error:", err);
    return c.json(
      { success: false, error: "Internal server error" },
      500,
    );
  }
});

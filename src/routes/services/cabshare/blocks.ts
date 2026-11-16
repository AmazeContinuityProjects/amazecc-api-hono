/**
 * POST /api/services/cabshare/blocks — block a user.
 * DELETE /api/services/cabshare/blocks — unblock a user.
 *
 * Auth: Amaze ID (DPoP).
 */
import { Hono } from "hono";
import { requireCabshareUser, ensureCabshareSchema, ensureCabshareUser, CABSHARE_BLOCKS_TABLE } from "../../../../src/lib/cabshare";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { getDbPool } from "../../../../src/lib/db";

export const cabshareBlocksRouter = new Hono();

cabshareBlocksRouter.post("/blocks", async (c) => {
  try {
    const regNo = await requireCabshareUser(c);
    if (regNo instanceof Response) return regNo;

    await ensureCabshareSchema();
    const user = await ensureCabshareUser(regNo);

    const body = (await c.req.json().catch(() => ({}))) as {
      blocked_id?: string | number;
    };

    if (!body.blocked_id) {
      return c.json(
        { success: false, error: "Missing blocked_id" },
        400,
      );
    }

    const pool = getDbPool();
    await pool.query(
      `INSERT INTO ${CABSHARE_BLOCKS_TABLE} (blocker_id, blocked_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [user.user_id, Number(body.blocked_id)],
    );

    return c.json({ success: true, message: "User blocked successfully" }, 200);
  } catch (err: unknown) {
    console.error("[cabshare] blocks POST error:", err);
    return c.json(
      { success: false, error: "Internal server error" },
      500,
    );
  }
});

cabshareBlocksRouter.delete("/blocks", async (c) => {
  try {
    const regNo = await requireCabshareUser(c);
    if (regNo instanceof Response) return regNo;

    await ensureCabshareSchema();
    const user = await ensureCabshareUser(regNo);

    const blockedId = c.req.query("blocked_id");
    if (!blockedId) {
      return c.json(
        { success: false, error: "Missing blocked_id" },
        400,
      );
    }

    const pool = getDbPool();
    await pool.query(
      `DELETE FROM ${CABSHARE_BLOCKS_TABLE}
       WHERE blocker_id = $1 AND blocked_id = $2`,
      [user.user_id, Number(blockedId)],
    );

    return c.json({ success: true, message: "User unblocked successfully" }, 200);
  } catch (err: unknown) {
    console.error("[cabshare] blocks DELETE error:", err);
    return c.json(
      { success: false, error: "Internal server error" },
      500,
    );
  }
});

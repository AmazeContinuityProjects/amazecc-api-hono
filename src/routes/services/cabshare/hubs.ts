/**
 * GET /api/services/cabshare/hubs — list hubs (public).
 *
 * Auth: none.
 */
import { Hono } from "hono";
import { CABSHARE_HUBS_TABLE } from "../../../../src/lib/cabshare";
import { getDbPool } from "../../../../src/lib/db";
import { publicErrorMessage } from "../../../../src/lib/publicError";

export const cabshareHubsRouter = new Hono();

cabshareHubsRouter.get("/hubs", async (c) => {
  try {
    const pool = getDbPool();
    const { rows } = await pool.query(
      `SELECT * FROM ${CABSHARE_HUBS_TABLE} ORDER BY hub_id ASC`,
    );
    return c.json({ success: true, hubs: rows }, 200);
  } catch (err: unknown) {
    console.error("[cabshare] hubs error:", err);
    return c.json(
      { success: false, error: publicErrorMessage(err) },
      500,
    );
  }
});

/**
 * GET /api/services/cabshare/hubs — list hubs (public).
 *
 * Auth: none.
 */
import { Hono } from "hono";
import { CABSHARE_HUBS_TABLE } from "../../../../src/lib/cabshare";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { getWorkerEnv } from "../../../../src/env";

export const cabshareHubsRouter = new Hono();

cabshareHubsRouter.get("/hubs", async (c) => {
  try {
    const appDb = getWorkerEnv().APP_DB;
    if (!appDb) throw new Error("APP_DB is not configured");
    const rows = (await appDb.prepare(`SELECT * FROM ${CABSHARE_HUBS_TABLE} ORDER BY hub_id ASC`).all()).results;
    return c.json({ success: true, hubs: rows }, 200);
  } catch (err: unknown) {
    console.error("[cabshare] hubs error:", err);
    return c.json(
      { success: false, error: publicErrorMessage(err) },
      500,
    );
  }
});

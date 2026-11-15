/**
 * POST /api/services/cabshare/ratings — rate a trip participant.
 *
 * Body: { trip_id, ratee_id, score (1-5), comment? }
 *
 * Auth: Amaze ID (DPoP). Only trip owner + accepted requester can rate each other.
 */
import { Hono } from "hono";
import { requireCabshareUser, ensureCabshareSchema, ensureCabshareUser, CABSHARE_MATCH_EVENTS_TABLE, CABSHARE_RATINGS_TABLE, cabshareUserIdFromOwnerKey } from "../../../../src/lib/cabshare";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { getDbPool } from "../../../../src/lib/db";

export const cabshareRatingsRouter = new Hono();

cabshareRatingsRouter.post("/ratings", async (c) => {
  try {
    const regNo = await requireCabshareUser(c);
    if (regNo instanceof Response) return regNo;

    await ensureCabshareSchema();
    const user = await ensureCabshareUser(regNo);
    const raterId = user.user_id;

    const body = (await c.req.json().catch(() => ({}))) as {
      trip_id?: string | number;
      ratee_id?: string | number;
      score?: number;
      comment?: string;
    };

    if (!body.trip_id || !body.ratee_id || !body.score) {
      return c.json(
        { success: false, error: "Missing required fields" },
        400,
      );
    }
    if (!Number.isInteger(body.score) || body.score < 1 || body.score > 5) {
      return c.json(
        { success: false, error: "score must be 1-5" },
        400,
      );
    }

    const pool = getDbPool();

    // Verify the rater and ratee shared this trip (accepted match)
    const { rows: matchRows } = await pool.query(
      `SELECT 1 FROM ${CABSHARE_MATCH_EVENTS_TABLE}
       WHERE trip_id = $1 AND status IN ('accepted', 'accept')
         AND ((requester_id = $2 AND owner_id = $3) OR (requester_id = $3 AND owner_id = $2))
       LIMIT 1`,
      [body.trip_id, raterId, Number(body.ratee_id)],
    );
    if (!matchRows.length) {
      return c.json(
        { success: false, error: "You can only rate people you shared this trip with" },
        403,
      );
    }

    await pool.query(
      `INSERT INTO ${CABSHARE_RATINGS_TABLE} (trip_id, rater_id, ratee_id, score, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [body.trip_id, raterId, Number(body.ratee_id), body.score, body.comment ?? null],
    );

    return c.json({ success: true, message: "Rating submitted" }, 200);
  } catch (err: unknown) {
    console.error("[cabshare] ratings error:", err);
    return c.json(
      { success: false, error: "Internal server error" },
      500,
    );
  }
});

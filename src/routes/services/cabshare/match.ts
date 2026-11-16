/**
 * POST /api/services/cabshare/match — request/accept/reject/withdraw a trip match.
 *
 * Body: { trip_id, action: "request"|"accept"|"reject"|"withdraw", match_id? }
 *
 * Auth: Amaze ID (DPoP).
 */
import { Hono } from "hono";
import { requireCabshareUser, ensureCabshareSchema, ensureCabshareUser, CABSHARE_TRIPS_TABLE, CABSHARE_BLOCKS_TABLE, CABSHARE_MATCH_EVENTS_TABLE, CABSHARE_TABLE } from "../../../../src/lib/cabshare";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { getDbPool } from "../../../../src/lib/db";

export const cabshareMatchRouter = new Hono();

cabshareMatchRouter.post("/match", async (c) => {
  try {
    const regNo = await requireCabshareUser(c);
    if (regNo instanceof Response) return regNo;

    await ensureCabshareSchema();
    const user = await ensureCabshareUser(regNo);
    const userId = user.user_id;

    // Phone number is mandatory to use cab share
    if (!user.phone_number) {
      return c.json(
        {
          success: false,
          error: "phone_number_required",
          detail: { detail: "Please register your phone number via /api/profile/phone before requesting a match" },
        },
        403,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      trip_id?: string | number;
      action?: "request" | "accept" | "reject" | "withdraw";
      match_id?: string | number;
    };

    if (!body.action) {
      return c.json(
        { success: false, error: "Missing action" },
        400,
      );
    }

    const pool = getDbPool();

    if (body.action === "request") {
      if (!body.trip_id) {
        return c.json(
          { success: false, error: "Missing trip_id" },
          400,
        );
      }
      const { rows: tripRows } = await pool.query(
        `SELECT user_id FROM ${CABSHARE_TRIPS_TABLE} WHERE trip_id = $1`,
        [body.trip_id],
      );
      if (!tripRows.length) {
        return c.json(
          { success: false, error: "Trip not found" },
          404,
        );
      }
      const tripOwnerId = Number(tripRows[0].user_id);
      if (tripOwnerId === userId) {
        return c.json(
          { success: false, error: "Cannot request your own trip" },
          400,
        );
      }
      // Check mutual block
      const { rows: blockRows } = await pool.query(
        `SELECT 1 FROM ${CABSHARE_BLOCKS_TABLE}
         WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
         LIMIT 1`,
        [userId, tripOwnerId],
      );
      if (blockRows.length) {
        return c.json(
          { success: false, error: "Cannot request this trip" },
          403,
        );
      }
      await pool.query(
        `INSERT INTO ${CABSHARE_MATCH_EVENTS_TABLE} (trip_id, requester_id, owner_id, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT DO NOTHING`,
        [body.trip_id, userId, tripOwnerId],
      );
      return c.json({ success: true, message: "Request sent" }, 200);
    }

    if (!body.match_id) {
      return c.json(
        { success: false, error: "Missing match_id" },
        400,
      );
    }

    if (body.action === "accept" || body.action === "reject") {
      const { rows: matchRows } = await pool.query(
        `SELECT m.owner_id, m.requester_id, u1.phone_number as requester_phone, u2.phone_number as owner_phone
         FROM ${CABSHARE_MATCH_EVENTS_TABLE} m
         JOIN ${CABSHARE_TABLE} u1 ON m.requester_id = u1.user_id
         JOIN ${CABSHARE_TABLE} u2 ON m.owner_id = u2.user_id
         WHERE m.id = $1`,
        [body.match_id],
      );
      if (!matchRows.length) {
        return c.json(
          { success: false, error: "Match not found" },
          404,
        );
      }
      if (Number(matchRows[0].owner_id) !== userId) {
        return c.json(
          { success: false, error: "Unauthorized" },
          403,
        );
      }
      await pool.query(
        `UPDATE ${CABSHARE_MATCH_EVENTS_TABLE} SET status = $1 WHERE id = $2`,
        [body.action === "accept" ? "accepted" : "rejected", body.match_id],
      );

      if (body.action === "accept") {
        const requester = matchRows[0];
        // Both parties must have a phone number to share
        if (!requester.requester_phone || !requester.owner_phone) {
          return c.json(
            {
              success: false,
              error: "phone_number_missing",
              detail: {
                detail:
                  "Both parties must register a phone number via /api/profile/phone before accepting",
              },
            },
            403,
          );
        }
        return c.json(
          {
            success: true,
            message: "Request accepted",
            phone_sharing: {
              requester_phone: requester.requester_phone,
              owner_phone: requester.owner_phone,
            },
          },
          200,
        );
      }
      return c.json(
        { success: true, message: "Request rejected" },
        200,
      );
    }

    if (body.action === "withdraw") {
      const { rows: matchRows } = await pool.query(
        `SELECT 1 FROM ${CABSHARE_MATCH_EVENTS_TABLE}
         WHERE (trip_id = $1 AND requester_id = $2) OR (id = $2 AND requester_id = $2)`,
        [body.trip_id, userId],
      );
      // withdraw by match_id or trip_id
      const matchId = body.match_id ?? body.trip_id;
      await pool.query(
        `UPDATE ${CABSHARE_MATCH_EVENTS_TABLE} SET status = 'withdrawn'
         WHERE (id = $1 OR trip_id = $1) AND requester_id = $2`,
        [matchId, userId],
      );
      return c.json({ success: true, message: "Request withdrawn" }, 200);
    }

    return c.json(
      { success: false, error: "Invalid action" },
      400,
    );
  } catch (err: unknown) {
    console.error("[cabshare] match error:", err);
    return c.json(
      { success: false, error: "Internal server error" },
      500,
    );
  }
});

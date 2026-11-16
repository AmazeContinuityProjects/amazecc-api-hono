/**
 * GET /api/services/cabshare/trips/me — my trips + joined trips.
 *
 * Auth: Amaze ID (DPoP).
 */
import { Hono } from "hono";
import { requireCabshareUser, ensureCabshareSchema, ensureCabshareUser, CABSHARE_TRIPS_TABLE, CABSHARE_HUBS_TABLE, CABSHARE_TABLE, CABSHARE_MATCH_EVENTS_TABLE } from "../../../../src/lib/cabshare";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { getDbPool } from "../../../../src/lib/db";

export const cabshareTripsMeRouter = new Hono();

cabshareTripsMeRouter.get("/trips/me", async (c) => {
  try {
    const regNo = await requireCabshareUser(c);
    if (regNo instanceof Response) return regNo;

    await ensureCabshareSchema();
    const user = await ensureCabshareUser(regNo);
    const userId = user.user_id;
    const pool = getDbPool();

    // my_trips: trips I created
    const { rows: myTrips } = await pool.query(
      `SELECT t.*, h.hub_name, h.city
       FROM ${CABSHARE_TRIPS_TABLE} t
       JOIN ${CABSHARE_HUBS_TABLE} h ON t.hub_id = h.hub_id
       WHERE t.user_id = $1
       ORDER BY t.travel_date ASC, t.preferred_time ASC`,
      [userId],
    );

    // Add requests per trip
    for (const trip of myTrips) {
      const { rows: reqs } = await pool.query(
        `SELECT m.id as match_id, m.status, u.name, u.reg_number,
                CASE WHEN m.status = 'accepted' THEN u.phone_number ELSE NULL END as phone_number
         FROM ${CABSHARE_MATCH_EVENTS_TABLE} m
         JOIN ${CABSHARE_TABLE} u ON m.requester_id = u.user_id
         WHERE m.trip_id = $1
         ORDER BY m.created_at ASC`,
        [trip.trip_id],
      );
      (trip as any).requests = reqs;
    }

    // joined_trips: trips I've requested to join
    const { rows: joined } = await pool.query(
      `SELECT t.*, h.hub_name, h.city, m.status as match_status, u.name as owner_name,
              CASE WHEN m.status = 'accepted' THEN u.phone_number ELSE NULL END as owner_phone
       FROM ${CABSHARE_MATCH_EVENTS_TABLE} m
       JOIN ${CABSHARE_TRIPS_TABLE} t ON m.trip_id = t.trip_id
       JOIN ${CABSHARE_HUBS_TABLE} h ON t.hub_id = h.hub_id
       JOIN ${CABSHARE_TABLE} u ON t.user_id = u.user_id
       WHERE m.requester_id = $1
       ORDER BY t.travel_date ASC, t.preferred_time ASC`,
      [userId],
    );

    return c.json(
      { success: true, my_trips: myTrips, joined_trips: joined },
      200,
    );
  } catch (err: unknown) {
    console.error("[cabshare] trips/me error:", err);
    return c.json(
      { success: false, error: "Internal server error" },
      500,
    );
  }
});

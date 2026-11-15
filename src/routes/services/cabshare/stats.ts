/**
 * GET /api/services/cabshare/stats — hub/trip/user stats (public).
 */
import { Hono } from "hono";
import { CABSHARE_TRIPS_TABLE, CABSHARE_TABLE, CABSHARE_HUBS_TABLE } from "../../../../src/lib/cabshare";
import { getDbPool } from "../../../../src/lib/db";
import { publicErrorMessage } from "../../../../src/lib/publicError";

export const cabshareStatsRouter = new Hono();

cabshareStatsRouter.get("/stats", async (c) => {
  try {
    const pool = getDbPool();
    const { rows: totalTrips } = await pool.query(
      `SELECT COUNT(*) as total FROM ${CABSHARE_TRIPS_TABLE}`,
    );
    const { rows: activeTrips } = await pool.query(
      `SELECT COUNT(*) as total FROM ${CABSHARE_TRIPS_TABLE} WHERE status = 'active'`,
    );
    const { rows: totalUsers } = await pool.query(
      `SELECT COUNT(*) as total FROM ${CABSHARE_TABLE}`,
    );
    const { rows: popularHubs } = await pool.query(
      `SELECT h.hub_name, COUNT(t.trip_id) as trip_count
       FROM ${CABSHARE_HUBS_TABLE} h
       LEFT JOIN ${CABSHARE_TRIPS_TABLE} t ON h.hub_id = t.hub_id
       GROUP BY h.hub_id, h.hub_name
       ORDER BY trip_count DESC
       LIMIT 3`,
    );

    return c.json({
      success: true,
      stats: {
        totalTrips: Number(totalTrips[0].total),
        activeTrips: Number(activeTrips[0].total),
        totalUsers: Number(totalUsers[0].total),
        popularHubs: popularHubs.map((r: any) => ({
          hub_name: r.hub_name,
          trip_count: Number(r.trip_count),
        })),
      },
    }, 200);
  } catch (err: unknown) {
    console.error("[cabshare] stats error:", err);
    return c.json(
      { success: false, error: publicErrorMessage(err) },
      500,
    );
  }
});

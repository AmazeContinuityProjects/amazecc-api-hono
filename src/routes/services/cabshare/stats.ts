/**
 * GET /api/services/cabshare/stats — hub/trip/user stats (public).
 */
import { Hono } from "hono";
import { CABSHARE_TRIPS_TABLE, CABSHARE_TABLE, CABSHARE_HUBS_TABLE } from "../../../../src/lib/cabshare";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { getWorkerEnv } from "../../../../src/env";

export const cabshareStatsRouter = new Hono();

const CABSHARE_STATS_TTL_MS = 60_000;
let cachedStats: { data: unknown; expiresAt: number } | null = null;

cabshareStatsRouter.get("/stats", async (c) => {
  try {
    const now = Date.now();
    if (cachedStats && now < cachedStats.expiresAt) {
      c.header("Cache-Control", "public, max-age=60, s-maxage=300");
      return c.json(cachedStats.data, 200);
    }

    const appDb = getWorkerEnv().APP_DB;
    if (!appDb) throw new Error("APP_DB is not configured");
    let totalTrips;
    let activeTrips;
    let totalUsers;
    let popularHubs;
    {
      totalTrips = [await appDb.prepare(`SELECT COUNT(*) AS total FROM ${CABSHARE_TRIPS_TABLE}`).first<{ total: number }>() ?? { total: 0 }];
      activeTrips = [await appDb.prepare(`SELECT COUNT(*) AS total FROM ${CABSHARE_TRIPS_TABLE} WHERE status = 'active'`).first<{ total: number }>() ?? { total: 0 }];
      totalUsers = [await appDb.prepare(`SELECT COUNT(*) AS total FROM ${CABSHARE_TABLE}`).first<{ total: number }>() ?? { total: 0 }];
      popularHubs = (await appDb.prepare(`SELECT h.hub_name, COUNT(t.trip_id) AS trip_count
        FROM ${CABSHARE_HUBS_TABLE} h LEFT JOIN ${CABSHARE_TRIPS_TABLE} t ON h.hub_id = t.hub_id
        GROUP BY h.hub_id, h.hub_name ORDER BY trip_count DESC LIMIT 3`).all<any>()).results;
    }

    const responseData = {
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
    };

    cachedStats = { data: responseData, expiresAt: now + CABSHARE_STATS_TTL_MS };
    c.header("Cache-Control", "public, max-age=60, s-maxage=300");
    return c.json(responseData, 200);
  } catch (err: unknown) {
    console.error("[cabshare] stats error:", err);
    return c.json(
      { success: false, error: publicErrorMessage(err) },
      500,
    );
  }
});

/**
 * POST /api/services/cabshare/trips — create a trip.
 * GET  /api/services/cabshare/trips — list available trips (hub/date filters).
 *
 * Auth: Amaze ID (DPoP).
 */
import { Hono } from "hono";
import { requireCabshareUser, ensureCabshareSchema, ensureCabshareUser, CABSHARE_TRIPS_TABLE, CABSHARE_HUBS_TABLE, CABSHARE_TABLE } from "../../../../src/lib/cabshare";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { getWorkerEnv } from "../../../../src/env";

export const cabshareTripsRouter = new Hono();

cabshareTripsRouter.post("/trips", async (c) => {
  try {
    const regNo = await requireCabshareUser(c);
    if (regNo instanceof Response) return regNo;

    await ensureCabshareSchema();
    const user = await ensureCabshareUser(regNo);

    // Phone number is mandatory to create a cab share trip
    if (!user.phone_number) {
      return c.json(
        {
          success: false,
          error: "phone_number_required",
          detail: { detail: "Please register your phone number via /api/profile/phone before creating a trip" },
        },
        403,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      hub_id?: string | number;
      travel_date?: string;
      preferred_time?: string;
      seat_options?: unknown;
      gender_preference?: string;
      tolerance_hours?: number;
      notes?: string;
    };

    if (
      !body.hub_id ||
      !body.travel_date ||
      !body.preferred_time ||
      body.seat_options === undefined ||
      !body.gender_preference
    ) {
      return c.json(
        { success: false, error: "Missing required fields" },
        400,
      );
    }

    const appDb = getWorkerEnv().APP_DB;
    if (!appDb) throw new Error("APP_DB is not configured");
    const result = await appDb.prepare(`INSERT INTO ${CABSHARE_TRIPS_TABLE}
        (user_id, hub_id, travel_date, preferred_time, tolerance_hours, seat_options, gender_preference, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`)
        .bind(user.user_id, body.hub_id, body.travel_date, body.preferred_time,
          body.tolerance_hours ?? 0, JSON.stringify(body.seat_options), body.gender_preference,
          body.notes ?? null).run();
    return c.json({ success: true, trip_id: result.meta.last_row_id }, 200);
  } catch (err: unknown) {
    console.error("[cabshare] trips POST error:", err);
    return c.json(
      { success: false, error: "Internal server error" },
      500,
    );
  }
});

cabshareTripsRouter.get("/trips", async (c) => {
  try {
    const regNo = await requireCabshareUser(c);
    if (regNo instanceof Response) return regNo;

    const hubId = c.req.query("hub_id");
    const date = c.req.query("date");

    const appDb = getWorkerEnv().APP_DB;
    let query = `
      SELECT t.*, u.name, u.reg_number as owner_reg_number, h.hub_name, h.city
      FROM ${CABSHARE_TRIPS_TABLE} t
      JOIN ${CABSHARE_TABLE} u ON t.user_id = u.user_id
      JOIN ${CABSHARE_HUBS_TABLE} h ON t.hub_id = h.hub_id
      WHERE t.status = 'active' AND t.user_id <> ?`;
    const user = await ensureCabshareUser(regNo);
    const params: any[] = [user.user_id];

    if (hubId) {
      query += ` AND t.hub_id = ?`;
      params.push(hubId);
    }
    if (date) {
      query += ` AND t.travel_date = ?`;
      params.push(date);
    }
    query += ` ORDER BY t.travel_date ASC, t.preferred_time ASC`;

    if (!appDb) throw new Error("APP_DB is not configured");
    const rows = (await appDb.prepare(query).bind(...params).all()).results;

    return c.json({ success: true, trips: rows }, 200);
  } catch (err: unknown) {
    console.error("[cabshare] trips GET error:", err);
    return c.json(
      { success: false, error: "Internal server error" },
      500,
    );
  }
});

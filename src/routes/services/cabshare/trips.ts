/**
 * POST /api/services/cabshare/trips — create a trip.
 * GET  /api/services/cabshare/trips — list available trips (hub/date filters).
 *
 * Auth: Amaze ID (DPoP).
 */
import { Hono } from "hono";
import { requireCabshareUser, ensureCabshareSchema, ensureCabshareUser, CABSHARE_TRIPS_TABLE, CABSHARE_HUBS_TABLE, CABSHARE_TABLE } from "../../../../src/lib/cabshare";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { getDbPool } from "../../../../src/lib/db";

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

    const pool = getDbPool();
    const { rows } = await pool.query(
      `INSERT INTO ${CABSHARE_TRIPS_TABLE}
        (user_id, hub_id, travel_date, preferred_time, tolerance_hours, seat_options, gender_preference, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'active')
       RETURNING trip_id`,
      [
        user.user_id,
        body.hub_id,
        body.travel_date,
        body.preferred_time,
        body.tolerance_hours ?? 0,
        JSON.stringify(body.seat_options),
        body.gender_preference,
        body.notes ?? null,
      ],
    );

    return c.json({ success: true, trip_id: rows[0].trip_id }, 200);
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

    const pool = getDbPool();
    let query = `
      SELECT t.*, u.name, u.reg_number as owner_reg_number, h.hub_name, h.city
      FROM ${CABSHARE_TRIPS_TABLE} t
      JOIN ${CABSHARE_TABLE} u ON t.user_id = u.user_id
      JOIN ${CABSHARE_HUBS_TABLE} h ON t.hub_id = h.hub_id
      WHERE t.status = 'active' AND t.user_id <> $1`;
    const user = await ensureCabshareUser(regNo);
    const params: any[] = [user.user_id];

    let paramIdx = 2;
    if (hubId) {
      query += ` AND t.hub_id = $${paramIdx}`;
      params.push(hubId);
      paramIdx++;
    }
    if (date) {
      query += ` AND t.travel_date = $${paramIdx}`;
      params.push(date);
      paramIdx++;
    }
    query += ` ORDER BY t.travel_date ASC, t.preferred_time ASC`;

    const { rows } = await pool.query(query, params);

    return c.json({ success: true, trips: rows }, 200);
  } catch (err: unknown) {
    console.error("[cabshare] trips GET error:", err);
    return c.json(
      { success: false, error: "Internal server error" },
      500,
    );
  }
});

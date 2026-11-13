import { getDbPool } from '../../lib/db';
import { requireSection } from'../../lib/auth';
import type { BusRouteInput } from '../../types/transport';


export async function GET(req: Request) {
  const auth = await requireSection('transport')(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const pool = getDbPool();
    const { rows } = await pool.query(`
      SELECT id, route_number, route_name, type,
        driver_name, driver_phone, whatsapp_group, bus_location,
        supervisor_name, supervisor_phone,
        driver_incharge_name, driver_incharge_phone,
        stops, placements,
        jsonb_array_length(stops) AS stop_count,
        created_at, updated_at
      FROM buses_v2
      ORDER BY route_number::int, route_name
    `);
    return Response.json({ success: true, routes: rows });
  } catch (error: unknown) {
    console.error('Failed to fetch transport routes:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requireSection('transport')(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const pool = getDbPool();
    const routes: BusRouteInput[] = await (req.json() as any);

    if (!Array.isArray(routes)) {
      return Response.json({ success: false, error: 'Expected an array of routes' }, { status: 400 });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM buses_v2');

      for (const r of routes) {
        const stopsJson = JSON.stringify(r.stops || []);
        const placementsJson = JSON.stringify(r.placements || []);
        await client.query(
          `      INSERT INTO buses_v2 (route_number, route_name, type, driver_name, driver_phone, whatsapp_group, bus_location, supervisor_name, supervisor_phone, driver_incharge_name, driver_incharge_phone, stops, placements)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)`,
          [r.routeNumber, r.routeName, r.type, r.driverName || '', r.driverPhone || '', r.whatsappGroup || '', r.busLocation || '', r.supervisorName || '', r.supervisorPhone || '', r.driverInchargeName || '', r.driverInchargePhone || '', stopsJson, placementsJson]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return Response.json({ success: true, message: 'Routes updated successfully' });
  } catch (error: unknown) {
    console.error('Failed to update transport routes:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

import { requireSection } from'../../lib/auth';
import type { BusRouteInput } from '../../types/transport';
import { decodeTransportRoute, ensureTransportInD1 } from '../../lib/transportD1';


export async function GET(req: Request) {
  const auth = await requireSection('transport')(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const db = await ensureTransportInD1();
    const { results } = await db.prepare(`SELECT id, route_number, route_name, type,
        driver_name, driver_phone, whatsapp_group, bus_location, supervisor_name, supervisor_phone,
        driver_incharge_name, driver_incharge_phone, stops, placements,
        json_array_length(stops) AS stop_count, created_at, updated_at
        FROM buses_v2 ORDER BY CAST(route_number AS INTEGER), route_name`).all<Record<string, unknown>>();
    return Response.json({ success: true, routes: results.map(decodeTransportRoute) });
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
    const routes: BusRouteInput[] = await (req.json() as any);

    if (!Array.isArray(routes)) {
      return Response.json({ success: false, error: 'Expected an array of routes' }, { status: 400 });
    }
    if (routes.length > 999) return Response.json({ success: false, error: 'Too many routes in one update' }, { status: 400 });

    const db = await ensureTransportInD1();
    const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM buses_v2')];
    for (const route of routes) {
      statements.push(db.prepare(`INSERT INTO buses_v2
        (route_number, route_name, type, driver_name, driver_phone, whatsapp_group, bus_location,
         supervisor_name, supervisor_phone, driver_incharge_name, driver_incharge_phone, stops, placements)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(route.routeNumber, route.routeName, route.type, route.driverName || '', route.driverPhone || '',
          route.whatsappGroup || '', route.busLocation || '', route.supervisorName || '', route.supervisorPhone || '',
          route.driverInchargeName || '', route.driverInchargePhone || '', JSON.stringify(route.stops || []),
          JSON.stringify(route.placements || [])));
    }
    await db.batch(statements);

    return Response.json({ success: true, message: 'Routes updated successfully' });
  } catch (error: unknown) {
    console.error('Failed to update transport routes:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

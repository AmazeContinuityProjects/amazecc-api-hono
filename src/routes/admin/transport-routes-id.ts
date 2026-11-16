import { requireSection } from'../../lib/auth';
import { decodeTransportRoute, ensureTransportInD1 } from '../../lib/transportD1';


export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSection('transport')(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const db = await ensureTransportInD1();
    const { id: routeId } = await params;
    const id = parseInt(routeId, 10);
    if (isNaN(id)) {
      return Response.json({ success: false, error: 'Invalid route ID' }, { status: 400 });
    }

    const route = await db.prepare('SELECT * FROM buses_v2 WHERE id = ?').bind(id).first<Record<string, unknown>>();
    if (!route) {
      return Response.json({ success: false, error: 'Route not found' }, { status: 404 });
    }

    return Response.json({
      success: true,
      route: decodeTransportRoute(route),
    });
  } catch (error: unknown) {
    console.error('Failed to fetch route:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSection('transport')(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const db = await ensureTransportInD1();
    const { id: routeId } = await params;
    const id = parseInt(routeId, 10);
    if (isNaN(id)) {
      return Response.json({ success: false, error: 'Invalid route ID' }, { status: 400 });
    }

    const body = await (req.json() as any);
    const { routeNumber, routeName, type, driverName, driverPhone, whatsappGroup, busLocation, supervisorName, supervisorPhone, driverInchargeName, driverInchargePhone, stops, placements } = body;

    const row = await db.prepare(`UPDATE buses_v2
        SET route_number = COALESCE(?, route_number), route_name = COALESCE(?, route_name), type = COALESCE(?, type),
            driver_name = COALESCE(?, driver_name), driver_phone = COALESCE(?, driver_phone),
            whatsapp_group = COALESCE(?, whatsapp_group), bus_location = COALESCE(?, bus_location),
            supervisor_name = COALESCE(?, supervisor_name), supervisor_phone = COALESCE(?, supervisor_phone),
            driver_incharge_name = COALESCE(?, driver_incharge_name), driver_incharge_phone = COALESCE(?, driver_incharge_phone),
            stops = COALESCE(?, stops), placements = COALESCE(?, placements),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? RETURNING *`)
      .bind(routeNumber, routeName, type, driverName || '', driverPhone || '', whatsappGroup || '', busLocation || '',
        supervisorName || '', supervisorPhone || '', driverInchargeName || '', driverInchargePhone || '',
        stops ? JSON.stringify(stops) : null, placements ? JSON.stringify(placements) : null, id)
      .first<Record<string, unknown>>();

    if (!row) {
      return Response.json({ success: false, error: 'Route not found' }, { status: 404 });
    }

    return Response.json({ success: true, route: decodeTransportRoute(row) });
  } catch (error: unknown) {
    console.error('Failed to update route:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSection('transport')(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const db = await ensureTransportInD1();
    const { id: routeId } = await params;
    const id = parseInt(routeId, 10);
    if (isNaN(id)) {
      return Response.json({ success: false, error: 'Invalid route ID' }, { status: 400 });
    }

    const deleted = (await db.prepare('DELETE FROM buses_v2 WHERE id = ?').bind(id).run()).meta.changes ?? 0;
    if (deleted === 0) {
      return Response.json({ success: false, error: 'Route not found' }, { status: 404 });
    }

    return Response.json({ success: true, message: 'Route deleted successfully' });
  } catch (error: unknown) {
    console.error('Failed to delete route:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

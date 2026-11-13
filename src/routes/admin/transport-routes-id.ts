import { getDbPool } from '../../lib/db';
import { requireSection } from'../../lib/auth';


export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSection('transport')(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const pool = getDbPool();
    const { id: routeId } = await params;
    const id = parseInt(routeId, 10);
    if (isNaN(id)) {
      return Response.json({ success: false, error: 'Invalid route ID' }, { status: 400 });
    }

    const { rows: routes } = await pool.query('SELECT * FROM buses_v2 WHERE id = $1', [id]);
    if (routes.length === 0) {
      return Response.json({ success: false, error: 'Route not found' }, { status: 404 });
    }

    return Response.json({
      success: true,
      route: routes[0],
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
    const pool = getDbPool();
    const { id: routeId } = await params;
    const id = parseInt(routeId, 10);
    if (isNaN(id)) {
      return Response.json({ success: false, error: 'Invalid route ID' }, { status: 400 });
    }

    const body = await (req.json() as any);
    const { routeNumber, routeName, type, driverName, driverPhone, whatsappGroup, busLocation, supervisorName, supervisorPhone, driverInchargeName, driverInchargePhone, stops, placements } = body;

    const { rows } = await pool.query(
      `UPDATE buses_v2
       SET route_number = COALESCE($1, route_number),
           route_name = COALESCE($2, route_name),
           type = COALESCE($3, type),
           driver_name = COALESCE($4, driver_name),
           driver_phone = COALESCE($5, driver_phone),
           whatsapp_group = COALESCE($6, whatsapp_group),
           bus_location = COALESCE($7, bus_location),
            supervisor_name = COALESCE($8, supervisor_name),
            supervisor_phone = COALESCE($9, supervisor_phone),
            driver_incharge_name = COALESCE($10, driver_incharge_name),
            driver_incharge_phone = COALESCE($11, driver_incharge_phone),
            stops = COALESCE($12::jsonb, stops),
            placements = COALESCE($13::jsonb, placements),
            updated_at = now()
        WHERE id = $14
        RETURNING *`,
      [routeNumber, routeName, type, driverName || '', driverPhone || '', whatsappGroup || '', busLocation || '', supervisorName || '', supervisorPhone || '', driverInchargeName || '', driverInchargePhone || '', stops ? JSON.stringify(stops) : null, placements ? JSON.stringify(placements) : null, id]
    );

    if (rows.length === 0) {
      return Response.json({ success: false, error: 'Route not found' }, { status: 404 });
    }

    return Response.json({ success: true, route: rows[0] });
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
    const pool = getDbPool();
    const { id: routeId } = await params;
    const id = parseInt(routeId, 10);
    if (isNaN(id)) {
      return Response.json({ success: false, error: 'Invalid route ID' }, { status: 400 });
    }

    const { rowCount } = await pool.query('DELETE FROM buses_v2 WHERE id = $1', [id]);
    if (rowCount === 0) {
      return Response.json({ success: false, error: 'Route not found' }, { status: 404 });
    }

    return Response.json({ success: true, message: 'Route deleted successfully' });
  } catch (error: unknown) {
    console.error('Failed to delete route:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

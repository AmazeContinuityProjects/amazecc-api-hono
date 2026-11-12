import { getDbPool } from '../../lib/db';
import { requireAdminAuth } from '../../lib/auth';
import type { BusStop } from '../../types/transport';


export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const pool = getDbPool();
    const { id } = await params;
    const routeId = parseInt(id, 10);
    if (isNaN(routeId)) {
      return Response.json({ success: false, error: 'Invalid route ID' }, { status: 400 });
    }

    const { rows: route } = await pool.query('SELECT id FROM buses_v2 WHERE id = $1', [routeId]);
    if (route.length === 0) {
      return Response.json({ success: false, error: 'Route not found' }, { status: 404 });
    }

    const stops: BusStop[] = await (req.json() as any);
    if (!Array.isArray(stops)) {
      return Response.json({ success: false, error: 'Expected an array of stops' }, { status: 400 });
    }

    await pool.query(
      'UPDATE buses_v2 SET stops = $1::jsonb, updated_at = now() WHERE id = $2',
      [JSON.stringify(stops), routeId]
    );

    return Response.json({ success: true, message: 'Stops updated successfully' });
  } catch (error: unknown) {
    console.error('Failed to update stops:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

import { requireSection } from'../../lib/auth';
import type { BusStop } from '../../types/transport';
import { ensureTransportInD1 } from '../../lib/transportD1';


export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSection('transport')(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const db = await ensureTransportInD1();
    const { id } = await params;
    const routeId = parseInt(id, 10);
    if (isNaN(routeId)) {
      return Response.json({ success: false, error: 'Invalid route ID' }, { status: 400 });
    }

    const route = await db.prepare('SELECT id FROM buses_v2 WHERE id = ?').bind(routeId).first();
    if (!route) {
      return Response.json({ success: false, error: 'Route not found' }, { status: 404 });
    }

    const stops: BusStop[] = await (req.json() as any);
    if (!Array.isArray(stops)) {
      return Response.json({ success: false, error: 'Expected an array of stops' }, { status: 400 });
    }

    await db.prepare(`UPDATE buses_v2 SET stops = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .bind(JSON.stringify(stops), routeId).run();

    return Response.json({ success: true, message: 'Stops updated successfully' });
  } catch (error: unknown) {
    console.error('Failed to update stops:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

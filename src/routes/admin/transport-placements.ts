import { requireSection } from'../../lib/auth';
import { ensureTransportInD1 } from '../../lib/transportD1';


export async function GET(req: Request) {
  const auth = await requireSection('transport')(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const db = await ensureTransportInD1();
    const { results } = await db.prepare(`SELECT id, route_number, route_name, type, placements
      FROM buses_v2 WHERE json_array_length(placements) > 0 ORDER BY CAST(route_number AS INTEGER)`).all<Record<string, unknown>>();
    const flat: Array<Record<string, unknown>> = [];
    for (const route of results) {
      let placements: Array<Record<string, unknown>> = [];
      try { placements = typeof route.placements === 'string' ? JSON.parse(route.placements) : route.placements as Array<Record<string, unknown>>; } catch { /* malformed legacy value */ }
      for (const placement of placements || []) flat.push({
        routeId: route.id, routeNumber: route.route_number, routeName: route.route_name,
        dispersalTime: placement.dispersalTime, zone: placement.zone,
      });
    }
    flat.sort((a, b) => String(a.dispersalTime).localeCompare(String(b.dispersalTime))
      || Number(a.routeNumber) - Number(b.routeNumber));
    return Response.json({ success: true, placements: flat });
  } catch (error: unknown) {
    console.error('Failed to fetch placements:', error);
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
    const placements: { routeNumber: string; dispersalTime: string; zone: string }[] = await (req.json() as any);

    if (!Array.isArray(placements)) {
      return Response.json({ success: false, error: 'Expected an array of placements' }, { status: 400 });
    }

    const db = await ensureTransportInD1();
    const byRoute: Record<string, unknown[]> = {};
    for (const placement of placements) {
      if (!byRoute[placement.routeNumber]) byRoute[placement.routeNumber] = [];
      byRoute[placement.routeNumber].push({ dispersalTime: placement.dispersalTime, zone: placement.zone });
    }
    const statements: D1PreparedStatement[] = [db.prepare(`UPDATE buses_v2 SET placements = '[]', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)];
    for (const [routeNumber, routePlacements] of Object.entries(byRoute)) {
      statements.push(db.prepare(`UPDATE buses_v2 SET placements = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE route_number = ?`)
        .bind(JSON.stringify(routePlacements), routeNumber));
    }
    if (statements.length > 999) return Response.json({ success: false, error: 'Too many routes in one update' }, { status: 400 });
    await db.batch(statements);

    return Response.json({ success: true, message: 'Placements updated successfully' });
  } catch (error: unknown) {
    console.error('Failed to update placements:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

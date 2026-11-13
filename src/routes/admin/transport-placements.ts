import { getDbPool } from '../../lib/db';
import { requireSection } from'../../lib/auth';


export async function GET(req: Request) {
  const auth = await requireSection('transport')(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const pool = getDbPool();
    const { rows } = await pool.query(`
      SELECT id, route_number, route_name, type, placements
      FROM buses_v2
      WHERE jsonb_array_length(placements) > 0
      ORDER BY route_number::int
    `);
    const flat: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      for (const p of (r as Record<string, unknown>).placements as Array<Record<string, unknown>> || []) {
        flat.push({
          routeId: (r as Record<string, unknown>).id,
          routeNumber: (r as Record<string, unknown>).route_number,
          routeName: (r as Record<string, unknown>).route_name,
          dispersalTime: p.dispersalTime,
          zone: p.zone,
        });
      }
    }
    flat.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
      const aTime = a.dispersalTime as string;
      const bTime = b.dispersalTime as string;
      if (aTime !== bTime) return aTime < bTime ? -1 : 1;
      return parseInt(a.routeNumber as string) - parseInt(b.routeNumber as string);
    });
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
    const pool = getDbPool();
    const placements: { routeNumber: string; dispersalTime: string; zone: string }[] = await (req.json() as any);

    if (!Array.isArray(placements)) {
      return Response.json({ success: false, error: 'Expected an array of placements' }, { status: 400 });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE buses_v2 SET placements = '[]'::jsonb");

      const byRoute: Record<string, unknown[]> = {};
      for (const p of placements) {
        if (!byRoute[p.routeNumber]) byRoute[p.routeNumber] = [];
        byRoute[p.routeNumber].push({ dispersalTime: p.dispersalTime, zone: p.zone });
      }

      for (const [routeNumber, routePlacements] of Object.entries(byRoute)) {
        await client.query(
          'UPDATE buses_v2 SET placements = $1::jsonb, updated_at = now() WHERE route_number = $2',
          [JSON.stringify(routePlacements), routeNumber]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return Response.json({ success: true, message: 'Placements updated successfully' });
  } catch (error: unknown) {
    console.error('Failed to update placements:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

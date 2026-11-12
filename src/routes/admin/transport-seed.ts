import { getDbPool } from '../../lib/db';
import { requireAdminAuth } from '../../lib/auth';
import seedData from '../../data/transport/seed.json';


export async function POST(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  let data = seedData;

  const body = await (req.json() as any).catch(() => null);
  if (body && (body.routes || body.placements || body.rules)) {
    data = body;
  }

  if (!data.routes && !data.placements && !data.rules) {
    return Response.json({ success: false, error: 'Seed data must contain routes, placements, or rules' }, { status: 400 });
  }

  const pool = getDbPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Group placements by route number for merging into bus rows
    const placementsByRoute: Record<string, { dispersalTime: string; zone: string }[]> = {};
    if (data.placements) {
      for (const p of data.placements) {
        if (!placementsByRoute[p.routeNumber]) placementsByRoute[p.routeNumber] = [];
        placementsByRoute[p.routeNumber].push({ dispersalTime: p.dispersalTime, zone: p.zone });
      }
    }

    if (data.routes) {
      await client.query('DELETE FROM buses_v2');

      for (const r of data.routes) {
        const stopsJson = JSON.stringify(r.stops || []);
        const routePlacements = placementsByRoute[r.routeNumber] || [];
        const placementsJson = JSON.stringify(routePlacements);

        await client.query(
          `INSERT INTO buses_v2 (route_number, route_name, type, driver_name, driver_phone, whatsapp_group, bus_location, supervisor_name, supervisor_phone, driver_incharge_name, driver_incharge_phone, stops, placements)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)`,
          [r.routeNumber, r.routeName, r.type, r.driverName || '', r.driverPhone || '', r.whatsappGroup || '', r.busLocation || '', r.supervisorName || '', r.supervisorPhone || '', ((r as Record<string, unknown>).driverInchargeName as string) || '', ((r as Record<string, unknown>).driverInchargePhone as string) || '', stopsJson, placementsJson]
        );
      }
    }

    if (data.rules) {
      await client.query('DELETE FROM transport_rules');
      for (const r of data.rules) {
        await client.query(
          `INSERT INTO transport_rules (rule_number, content) VALUES ($1, $2)`,
          [r.ruleNumber, r.content]
        );
      }
    }

    await client.query('COMMIT');

    const routeCount = data.routes?.length || 0;
    const placementCount = data.placements?.length || 0;
    const ruleCount = data.rules?.length || 0;

    return Response.json({
      success: true,
      message: 'Transport data seeded successfully',
      stats: { routes: routeCount, placements: placementCount, rules: ruleCount },
    });
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    console.error('Failed to seed transport data:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  } finally {
    client.release();
  }
}

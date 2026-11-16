import { requireSection } from'../../lib/auth';
import seedData from '../../data/transport/seed.json';
import { ensureTransportInD1 } from '../../lib/transportD1';


export async function POST(req: Request) {
  const auth = await requireSection('transport')(req);
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

  const db = await ensureTransportInD1();
  {
    const statements: D1PreparedStatement[] = [];
    const placementsByRoute: Record<string, { dispersalTime: string; zone: string }[]> = {};
    if (data.placements) {
      for (const placement of data.placements) {
        if (!placementsByRoute[placement.routeNumber]) placementsByRoute[placement.routeNumber] = [];
        placementsByRoute[placement.routeNumber].push({ dispersalTime: placement.dispersalTime, zone: placement.zone });
      }
    }
    if (data.routes) {
      statements.push(db.prepare('DELETE FROM buses_v2'));
      for (const route of data.routes) {
        statements.push(db.prepare(`INSERT INTO buses_v2
          (route_number, route_name, type, driver_name, driver_phone, whatsapp_group, bus_location,
           supervisor_name, supervisor_phone, driver_incharge_name, driver_incharge_phone, stops, placements)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(route.routeNumber, route.routeName, route.type, route.driverName || '', route.driverPhone || '',
            route.whatsappGroup || '', route.busLocation || '', route.supervisorName || '', route.supervisorPhone || '',
            (route as Record<string, unknown>).driverInchargeName || '',
            (route as Record<string, unknown>).driverInchargePhone || '', JSON.stringify(route.stops || []),
            JSON.stringify(placementsByRoute[route.routeNumber] || [])));
      }
    } else if (data.placements) {
      statements.push(db.prepare(`UPDATE buses_v2 SET placements = '[]', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`));
      for (const [routeNumber, routePlacements] of Object.entries(placementsByRoute)) {
        statements.push(db.prepare(`UPDATE buses_v2 SET placements = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE route_number = ?`)
          .bind(JSON.stringify(routePlacements), routeNumber));
      }
    }
    if (data.rules) {
      statements.push(db.prepare('DELETE FROM transport_rules'));
      for (const rule of data.rules) {
        statements.push(db.prepare('INSERT INTO transport_rules (rule_number, content) VALUES (?, ?)')
          .bind(rule.ruleNumber, rule.content));
      }
    }
    if (statements.length > 999) return Response.json({ success: false, error: 'Seed contains too many rows for one atomic update' }, { status: 400 });
    if (statements.length) await db.batch(statements);
    return Response.json({
      success: true,
      message: 'Transport data seeded successfully',
      stats: { routes: data.routes?.length || 0, placements: data.placements?.length || 0, rules: data.rules?.length || 0 },
    });
  }
}

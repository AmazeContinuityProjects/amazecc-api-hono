import { requireSection } from'../../lib/auth';
import type { TransportRuleInput } from '../../types/transport';
import { ensureTransportInD1 } from '../../lib/transportD1';


export async function GET(req: Request) {
  const auth = await requireSection('transport')(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const db = await ensureTransportInD1();
    const { results } = await db.prepare('SELECT * FROM transport_rules ORDER BY rule_number').all();
    return Response.json({ success: true, rules: results });
  } catch (error: unknown) {
    console.error('Failed to fetch transport rules:', error);
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
    const rules: TransportRuleInput[] = await (req.json() as any);

    if (!Array.isArray(rules)) {
      return Response.json({ success: false, error: 'Expected an array of rules' }, { status: 400 });
    }
    if (rules.length > 999) return Response.json({ success: false, error: 'Too many rules in one update' }, { status: 400 });

    const db = await ensureTransportInD1();
    const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM transport_rules')];
    for (const rule of rules) {
      statements.push(db.prepare('INSERT INTO transport_rules (rule_number, content) VALUES (?, ?)')
        .bind(rule.ruleNumber, rule.content));
    }
    await db.batch(statements);

    return Response.json({ success: true, message: 'Rules updated successfully' });
  } catch (error: unknown) {
    console.error('Failed to update transport rules:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

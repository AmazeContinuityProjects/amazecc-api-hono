import { getDbPool } from '../../lib/db';
import { requireAdminAuth } from '../../lib/auth';
import type { TransportRuleInput } from '../../types/transport';


export async function GET(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const pool = getDbPool();
    const { rows } = await pool.query('SELECT * FROM transport_rules ORDER BY rule_number');
    return Response.json({ success: true, rules: rows });
  } catch (error: unknown) {
    console.error('Failed to fetch transport rules:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const pool = getDbPool();
    const rules: TransportRuleInput[] = await (req.json() as any);

    if (!Array.isArray(rules)) {
      return Response.json({ success: false, error: 'Expected an array of rules' }, { status: 400 });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('TRUNCATE TABLE transport_rules');

      for (const r of rules) {
        await client.query(
          `INSERT INTO transport_rules (rule_number, content)
           VALUES ($1, $2)`,
          [r.ruleNumber, r.content]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return Response.json({ success: true, message: 'Rules updated successfully' });
  } catch (error: unknown) {
    console.error('Failed to update transport rules:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

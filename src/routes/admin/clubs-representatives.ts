import { getDbPool } from '../../lib/db';
import { requireAdminAuth } from '../../lib/auth';


export async function GET(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const { searchParams } = new URL(req.url);
    const club_id = searchParams.get('club_id');

    const pool = getDbPool();
    let query = 'SELECT * FROM club_representatives';
    const params: unknown[] = [];

    if (club_id) {
      query += ' WHERE club_id = $1';
      params.push(club_id);
    }
    
    query += ' ORDER BY created_at DESC';

    const { rows } = await pool.query(query, params);

    return Response.json({ success: true, representatives: rows });
  } catch (error) {
    console.error('Failed to fetch club representatives:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const body = await (req.json() as any);
    const { club_id, vtop_id, role } = body;

    if (!club_id || !vtop_id) {
      return Response.json({ success: false, error: 'club_id and vtop_id are required' }, { status: 400 });
    }

    const pool = getDbPool();
    const { rows } = await pool.query(
      `INSERT INTO club_representatives (club_id, vtop_id, role, assigned_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (club_id, vtop_id) DO UPDATE SET
         role = EXCLUDED.role,
         assigned_by = EXCLUDED.assigned_by
       RETURNING *`,
      [club_id, vtop_id.toUpperCase(), role || 'representative', auth.username]
    );

    return Response.json({ success: true, representative: rows[0] });
  } catch (error) {
    console.error('Failed to assign club representative:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const body = await (req.json() as any);
    const { club_id, vtop_id } = body;

    if (!club_id || !vtop_id) {
      return Response.json({ success: false, error: 'club_id and vtop_id are required' }, { status: 400 });
    }

    const pool = getDbPool();
    await pool.query(
      'DELETE FROM club_representatives WHERE club_id = $1 AND vtop_id = $2',
      [club_id, vtop_id.toUpperCase()]
    );

    return Response.json({ success: true, message: 'Representative removed successfully' });
  } catch (error) {
    console.error('Failed to remove club representative:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

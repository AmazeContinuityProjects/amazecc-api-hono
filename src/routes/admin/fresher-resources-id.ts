import { getDbPool } from '../../lib/db';
import { requireAdminAuth, hasAdminPermission } from '../../lib/auth';
import { logAdminAction } from '../../lib/audit';
import { publicErrorMessage } from "../../lib/publicError";


export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  if (!hasAdminPermission(auth, 'fresher-resources')) {
    return Response.json(
      { success: false, error: 'Permission denied: fresher-resources permission required' },
      { status: 403 }
    );
  }

  try {
    const { id } = await context.params;
    const numericId = parseInt(id, 10);
    if (isNaN(numericId)) {
      return Response.json({ success: false, error: 'Invalid id' }, { status: 400 });
    }

    const fields = await (req.json() as any);
    const allowed = ['title', 'description', 'url', 'icon', 'sort_order', 'is_active', 'type', 'content'];
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const key of allowed) {
      if (fields[key] !== undefined) {
        setClauses.push(`${key} = $${idx++}`);
        values.push(fields[key]);
      }
    }

    if (setClauses.length === 0) {
      return Response.json({ success: false, error: 'No fields to update' }, { status: 400 });
    }

    setClauses.push(`updated_at = now()`);
    values.push(numericId);

    const pool = getDbPool();
    const { rows } = await pool.query(
      `UPDATE fresher_resources SET ${setClauses.join(', ')} WHERE id = $${idx}
       RETURNING id, title, description, url, icon, sort_order, is_active, updated_at`,
      values
    );

    if (rows.length === 0) {
      return Response.json({ success: false, error: 'Resource not found' }, { status: 404 });
    }

    await logAdminAction({
      admin_user: auth.username,
      action: 'Update Fresher Resource',
      target_resource: `/api/admin/fresher-resources/${numericId}`,
      details: { id: numericId, updatedFields: Object.keys(fields) }
    });

    return Response.json({ success: true, resource: rows[0] });
  } catch (error: unknown) {
    console.error('admin fresher-resources PATCH error:', (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: publicErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  if (!hasAdminPermission(auth, 'fresher-resources')) {
    return Response.json(
      { success: false, error: 'Permission denied: fresher-resources permission required' },
      { status: 403 }
    );
  }

  try {
    const { id } = await context.params;
    const numericId = parseInt(id, 10);
    if (isNaN(numericId)) {
      return Response.json({ success: false, error: 'Invalid id' }, { status: 400 });
    }

    const pool = getDbPool();
    const { rowCount } = await pool.query(
      'DELETE FROM fresher_resources WHERE id = $1',
      [numericId]
    );

    if (!rowCount || rowCount === 0) {
      return Response.json({ success: false, error: 'Resource not found' }, { status: 404 });
    }

    await logAdminAction({
      admin_user: auth.username,
      action: 'Delete Fresher Resource',
      target_resource: `/api/admin/fresher-resources/${numericId}`,
      details: { id: numericId }
    });

    return Response.json({ success: true });
  } catch (error: unknown) {
    console.error('admin fresher-resources DELETE error:', (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: publicErrorMessage(error) }, { status: 500 });
  }
}

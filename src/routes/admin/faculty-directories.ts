import { getDbPool } from '../../lib/db';
import { requireAdminAuth, hasAdminPermission } from '../../lib/auth';
import { logAdminAction } from '../../lib/audit';
import { publicErrorMessage } from "../../lib/publicError";


export async function GET(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const pool = getDbPool();
    const { rows } = await pool.query(
      `SELECT id, school_name, url FROM faculty_directory_urls ORDER BY school_name ASC`
    );
    return Response.json({ success: true, directories: rows });
  } catch (error: unknown) {
    console.error('admin/faculty-directories GET error:', (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: publicErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  if (!hasAdminPermission(auth, ['faculty-directory', 'faculty-directories'])) {
    return Response.json(
      { success: false, error: 'Permission denied: faculty-directory permission required' },
      { status: 403 }
    );
  }

  try {
    const { id, school_name, url } = await (req.json() as any);
    if (!id || !school_name || !url) {
      return Response.json({ success: false, error: 'id, school_name, and url are required' }, { status: 400 });
    }

    const pool = getDbPool();
    await pool.query(
      `INSERT INTO faculty_directory_urls (id, school_name, url) VALUES ($1, $2, $3)`,
      [id, school_name, url]
    );

    await logAdminAction({
      admin_user: auth.username,
      action: 'Add Faculty Directory',
      target_resource: `/api/admin/faculty-directories/${id}`,
      details: { id, school_name, url }
    });

    return Response.json({ success: true, message: 'Directory added successfully' });
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === '23505') { // Unique violation
      return Response.json({ success: false, error: 'A school with this ID already exists' }, { status: 400 });
    }
    console.error('admin/faculty-directories POST error:', (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: publicErrorMessage(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  if (!hasAdminPermission(auth, ['faculty-directory', 'faculty-directories'])) {
    return Response.json(
      { success: false, error: 'Permission denied: faculty-directory permission required' },
      { status: 403 }
    );
  }

  try {
    const { id, school_name, url } = await (req.json() as any);
    if (!id || !school_name || !url) {
      return Response.json({ success: false, error: 'id, school_name, and url are required' }, { status: 400 });
    }

    const pool = getDbPool();
    const { rowCount } = await pool.query(
      `UPDATE faculty_directory_urls SET school_name = $2, url = $3 WHERE id = $1`,
      [id, school_name, url]
    );

    if (!rowCount || rowCount === 0) {
      return Response.json({ success: false, error: 'Directory not found' }, { status: 404 });
    }

    await logAdminAction({
      admin_user: auth.username,
      action: 'Update Faculty Directory',
      target_resource: `/api/admin/faculty-directories/${id}`,
      details: { id, school_name, url }
    });

    return Response.json({ success: true, message: 'Directory updated successfully' });
  } catch (error: unknown) {
    console.error('admin/faculty-directories PUT error:', (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: publicErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  if (!hasAdminPermission(auth, ['faculty-directory', 'faculty-directories'])) {
    return Response.json(
      { success: false, error: 'Permission denied: faculty-directory permission required' },
      { status: 403 }
    );
  }

  try {
    const { id } = await (req.json() as any);
    if (!id) {
      return Response.json({ success: false, error: 'id is required' }, { status: 400 });
    }

    const pool = getDbPool();
    const { rowCount } = await pool.query(
      `DELETE FROM faculty_directory_urls WHERE id = $1`,
      [id]
    );

    if (!rowCount || rowCount === 0) {
      return Response.json({ success: false, error: 'Directory not found' }, { status: 404 });
    }

    await logAdminAction({
      admin_user: auth.username,
      action: 'Delete Faculty Directory',
      target_resource: `/api/admin/faculty-directories/${id}`,
      details: { id }
    });

    return Response.json({ success: true, message: 'Directory deleted successfully' });
  } catch (error: unknown) {
    console.error('admin/faculty-directories DELETE error:', (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: publicErrorMessage(error) }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/admin/users:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Auto-generated POST endpoint for /api/admin/users
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               cookies:
 *                 type: string
 *               authorizedID:
 *                 type: string
 *               csrf:
 *                 type: string
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               example:
 *                 success: true
 *                 users: "sample_value"
 *       400:
 *         description: Bad Request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal Server Error
 */

import { getDbPool } from '../../lib/db';
import { requireAdminAuth } from '../../lib/auth';


/**
 * GET /api/admin/users - List all admin users
 * Only superadmins can view the user list
 */
export async function GET(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const pool = getDbPool();

    // Check if requester is superadmin
    const { rows: requester } = await pool.query(
      'SELECT role FROM admin_users WHERE username = $1',
      [auth.username]
    );

    if (!requester.length || requester[0].role !== 'superadmin') {
      return Response.json(
        { success: false, error: 'Only superadmins can manage users' },
        { status: 403 }
      );
    }

    const { rows } = await pool.query(
      'SELECT username, role, permissions, added_by, is_active, created_at FROM admin_users ORDER BY created_at DESC'
    );

    return Response.json({ success: true, users: rows });
  } catch (error: unknown) {
    console.error('Failed to fetch users:', error);
    return Response.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/users - Add a new admin user
 * Body: { username: string, role?: 'admin' | 'superadmin', permissions?: string[] }
 */
export async function POST(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const pool = getDbPool();

    // Check if requester is superadmin
    const { rows: requester } = await pool.query(
      'SELECT role FROM admin_users WHERE username = $1',
      [auth.username]
    );

    if (!requester.length || requester[0].role !== 'superadmin') {
      return Response.json(
        { success: false, error: 'Only superadmins can add users' },
        { status: 403 }
      );
    }

    const body = await (req.json() as any);
    const { username, role = 'admin', permissions = ['dashboard', 'qbank', 'buses', 'push'] } = body;

    if (!username || typeof username !== 'string') {
      return Response.json(
        { success: false, error: 'Username is required' },
        { status: 400 }
      );
    }

    const normalizedUsername = username.toUpperCase().trim();

    // Check if user already exists
    const { rows: existing } = await pool.query(
      'SELECT username FROM admin_users WHERE username = $1',
      [normalizedUsername]
    );

    if (existing.length > 0) {
      return Response.json(
        { success: false, error: 'User already exists' },
        { status: 409 }
      );
    }

    // Validate role
    if (!['admin', 'superadmin'].includes(role)) {
      return Response.json(
        { success: false, error: 'Invalid role. Must be "admin" or "superadmin"' },
        { status: 400 }
      );
    }

    // Validate permissions
    const validPermissions = [
      'dashboard', 'qbank', 'buses', 'push', 'users', 'transport', 'gorobo',
      'fresher-resources', 'faculty-directory', 'faculty-directories',
      'cabshare', 'clubs', 'storage', 'audit_logs', 'settings'
    ];
    const invalidPerms = permissions.filter((p: string) => !validPermissions.includes(p));
    if (invalidPerms.length > 0) {
      return Response.json(
        { success: false, error: `Invalid permissions: ${invalidPerms.join(', ')}` },
        { status: 400 }
      );
    }

    // Insert new user
    await pool.query(
      `INSERT INTO admin_users (username, role, permissions, added_by)
       VALUES ($1, $2, $3, $4)`,
      [normalizedUsername, role, JSON.stringify(permissions), auth.username]
    );

    return Response.json({
      success: true,
      message: `User ${normalizedUsername} added successfully`,
      user: {
        username: normalizedUsername,
        role,
        permissions,
        added_by: auth.username,
        is_active: true,
      },
    });
  } catch (error: unknown) {
    console.error('Failed to add user:', error);
    return Response.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

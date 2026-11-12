/**
 * @openapi
 * /api/admin/users/[username]:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Auto-generated POST endpoint for /api/admin/users/[username]
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
 *                 user: "sample_value"
 *                 success: true
 *       400:
 *         description: Bad Request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal Server Error
 */

import { getDbPool } from '../../lib/db';
import { requireAdminAuth } from '../../lib/auth';


interface RouteContext {
  params: Promise<{ username: string }>;
}

/**
 * PATCH /api/admin/users/[username] - Update user role/permissions
 * Body: { role?: string, permissions?: string[], is_active?: boolean }
 */
export async function PATCH(req: Request, context: RouteContext) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  const { username } = await context.params;
  const targetUsername = username.toUpperCase();

  try {
    const pool = getDbPool();

    // Check if requester is superadmin
    const { rows: requester } = await pool.query(
      'SELECT role FROM admin_users WHERE username = $1',
      [auth.username]
    );

    if (!requester.length || requester[0].role !== 'superadmin') {
      return Response.json(
        { success: false, error: 'Only superadmins can update users' },
        { status: 403 }
      );
    }

    // Check if target user exists
    const { rows: existing } = await pool.query(
      'SELECT username, role FROM admin_users WHERE username = $1',
      [targetUsername]
    );

    if (!existing.length) {
      return Response.json(
        { success: false, error: 'User not found' },
        { status: 404 }
      );
    }

    const body = await (req.json() as any);

    // Prevent removing last superadmin
    if (existing[0].role === 'superadmin') {
      if (body.role && body.role !== 'superadmin') {
        const { rows: superadminCount } = await pool.query(
          'SELECT COUNT(*) as count FROM admin_users WHERE role = $1',
          ['superadmin']
        );
        if (Number(superadminCount[0].count) <= 1) {
          return Response.json(
            { success: false, error: 'Cannot demote the last superadmin' },
            { status: 400 }
          );
        }
      }
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (body.role !== undefined) {
      if (!['admin', 'superadmin'].includes(body.role)) {
        return Response.json(
          { success: false, error: 'Invalid role' },
          { status: 400 }
        );
      }
      updates.push(`role = $${paramIndex++}`);
      values.push(body.role);
    }

    if (body.permissions !== undefined) {
      const validPermissions = [
        'dashboard', 'qbank', 'buses', 'push', 'users', 'transport', 'gorobo',
        'fresher-resources', 'faculty-directory', 'faculty-directories',
        'cabshare', 'clubs', 'storage', 'audit_logs', 'settings'
      ];
      const invalidPerms = body.permissions.filter((p: string) => !validPermissions.includes(p));
      if (invalidPerms.length > 0) {
        return Response.json(
          { success: false, error: `Invalid permissions: ${invalidPerms.join(', ')}` },
          { status: 400 }
        );
      }
      updates.push(`permissions = $${paramIndex++}`);
      values.push(JSON.stringify(body.permissions));
    }

    if (body.is_active !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(body.is_active);
    }

    if (updates.length === 0) {
      return Response.json(
        { success: false, error: 'No valid fields to update' },
        { status: 400 }
      );
    }

    values.push(targetUsername);
    await pool.query(
      `UPDATE admin_users SET ${updates.join(', ')} WHERE username = $${paramIndex}`,
      values
    );

    // Fetch updated user
    const { rows: updated } = await pool.query(
      'SELECT username, role, permissions, added_by, is_active, created_at FROM admin_users WHERE username = $1',
      [targetUsername]
    );

    return Response.json({ success: true, user: updated[0] });
  } catch (error: unknown) {
    console.error('Failed to update user:', error);
    console.error('Failed to update user:', error);
    return Response.json(
      { success: false, error: (error instanceof Error ? error.message : String(error)) || "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/users/[username] - Remove an admin user
 */
export async function DELETE(req: Request, context: RouteContext) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  const { username } = await context.params;
  const targetUsername = username.toUpperCase();

  try {
    const pool = getDbPool();

    // Check if requester is superadmin
    const { rows: requester } = await pool.query(
      'SELECT role FROM admin_users WHERE username = $1',
      [auth.username]
    );

    if (!requester.length || requester[0].role !== 'superadmin') {
      return Response.json(
        { success: false, error: 'Only superadmins can delete users' },
        { status: 403 }
      );
    }

    // Check if target user exists
    const { rows: existing } = await pool.query(
      'SELECT username, role FROM admin_users WHERE username = $1',
      [targetUsername]
    );

    if (!existing.length) {
      return Response.json(
        { success: false, error: 'User not found' },
        { status: 404 }
      );
    }

    // Prevent deleting last superadmin
    if (existing[0].role === 'superadmin') {
      const { rows: superadminCount } = await pool.query(
        'SELECT COUNT(*) as count FROM admin_users WHERE role = $1',
        ['superadmin']
      );
      if (Number(superadminCount[0].count) <= 1) {
        return Response.json(
          { success: false, error: 'Cannot delete the last superadmin' },
          { status: 400 }
        );
      }
    }

    // Prevent self-deletion
    if (targetUsername === auth.username) {
      return Response.json(
        { success: false, error: 'Cannot delete yourself' },
        { status: 400 }
      );
    }

    await pool.query('DELETE FROM admin_users WHERE username = $1', [targetUsername]);

    return Response.json({
      success: true,
      message: `User ${targetUsername} deleted successfully`,
    });
  } catch (error: unknown) {
    console.error('Failed to delete user:', error);
    return Response.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

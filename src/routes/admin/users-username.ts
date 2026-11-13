/**
 * /api/admin/users/[email] - mutate an Amaze ID (superadmin-only).
 * [email] is the account email (URL-encoded). All permission changes hit the
 * shared amazecc-auth D1 — enforcement is immediate, no token re-issue needed.
 */
import { getWorkerEnv } from "../../env";
import { requireSuperadmin } from "../../lib/auth";
import { SECTION_KEYS, parsePermissions } from "../../lib/permissions";

interface RouteContext {
  params: Promise<{ username: string }>;
}

interface D1UserRow {
  id: string;
  name: string;
  email: string;
  role: string | null;
  permissions: string | null;
  banned: number | null;
  vtopRegNo: string | null;
  createdAt: string;
}

const VALID_ROLES = new Set(["user", "admin", "superadmin"]);

function toApiUser(row: D1UserRow) {
  return {
    id: row.id,
    username: row.email,
    name: row.name,
    email: row.email,
    role: row.role ?? "user",
    permissions: parsePermissions(row.permissions),
    is_active: !row.banned,
    vtopRegNo: row.vtopRegNo ?? null,
    created_at: row.createdAt,
  };
}

export async function PATCH(req: Request, context: RouteContext) {
  const auth = await requireSuperadmin(req);
  if (auth instanceof Response) return auth;

  const db = getWorkerEnv().AUTH_DB;
  if (!db) return Response.json({ success: false, error: "AUTH_DB not bound" }, { status: 500 });

  const { username } = await context.params;
  const email = decodeURIComponent(username).trim().toLowerCase();

  try {
    const target = await db
      .prepare(`SELECT id, name, email, role, permissions, banned, vtopRegNo, createdAt FROM "user" WHERE email = ?1`)
      .bind(email)
      .first<D1UserRow>();
    if (!target) return Response.json({ success: false, error: "User not found" }, { status: 404 });

    const body = (await req.json()) as { role?: string; permissions?: string[]; is_active?: boolean };

    const sets: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (body.role !== undefined) {
      if (!VALID_ROLES.has(body.role)) {
        return Response.json({ success: false, error: 'Invalid role. Must be "user", "admin" or "superadmin"' }, { status: 400 });
      }
      if (email === auth.username.toLowerCase() && body.role !== "superadmin") {
        return Response.json({ success: false, error: "You cannot demote yourself" }, { status: 400 });
      }
      // Prevent demoting the last superadmin
      if (target.role === "superadmin" && body.role !== "superadmin") {
        const { results } = await db.prepare(`SELECT COUNT(*) AS c FROM "user" WHERE role = 'superadmin'`).all<{ c: number }>();
        if (Number(results?.[0]?.c ?? 0) <= 1) {
          return Response.json({ success: false, error: "Cannot demote the last superadmin" }, { status: 400 });
        }
      }
      sets.push(`role = $${paramIndex++}`);
      values.push(body.role);
    }

    if (body.permissions !== undefined) {
      if (!Array.isArray(body.permissions)) {
        return Response.json({ success: false, error: "permissions must be an array" }, { status: 400 });
      }
      const invalid = body.permissions.filter((p) => !(SECTION_KEYS as readonly string[]).includes(p));
      if (invalid.length > 0) {
        return Response.json({ success: false, error: `Invalid permissions: ${invalid.join(", ")}` }, { status: 400 });
      }
      sets.push(`permissions = $${paramIndex++}`);
      values.push(body.permissions.length ? body.permissions.join(",") : null);
    }

    if (body.is_active !== undefined) {
      if (email === auth.username.toLowerCase() && body.is_active === false) {
        return Response.json({ success: false, error: "You cannot deactivate yourself" }, { status: 400 });
      }
      sets.push(`banned = $${paramIndex++}`);
      values.push(body.is_active ? 0 : 1);
    }

    if (sets.length === 0) {
      return Response.json({ success: false, error: "No valid fields to update" }, { status: 400 });
    }

    values.push(email);
    await db.prepare(`UPDATE "user" SET ${sets.join(", ")} WHERE email = $${paramIndex}`).bind(...values).run();

    const updated = await db
      .prepare(`SELECT id, name, email, role, permissions, banned, vtopRegNo, createdAt FROM "user" WHERE email = ?1`)
      .bind(email)
      .first<D1UserRow>();

    return Response.json({ success: true, user: updated ? toApiUser(updated) : undefined });
  } catch (error) {
    console.error("Failed to update user:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

/**
 * Superadmin-only: deactivate an Amaze ID (keeps the account; blocks admin
 * sessions instantly because ban is checked on every request).
 */
export async function DELETE(req: Request, context: RouteContext) {
  const auth = await requireSuperadmin(req);
  if (auth instanceof Response) return auth;

  const db = getWorkerEnv().AUTH_DB;
  if (!db) return Response.json({ success: false, error: "AUTH_DB not bound" }, { status: 500 });

  const { username } = await context.params;
  const email = decodeURIComponent(username).trim().toLowerCase();

  try {
    if (email === auth.username.toLowerCase()) {
      return Response.json({ success: false, error: "You cannot deactivate yourself" }, { status: 400 });
    }
    const target = await db
      .prepare(`SELECT email, role FROM "user" WHERE email = ?1`)
      .bind(email)
      .first<{ email: string; role: string | null }>();
    if (!target) return Response.json({ success: false, error: "User not found" }, { status: 404 });

    if (target.role === "superadmin") {
      const { results } = await db.prepare(`SELECT COUNT(*) AS c FROM "user" WHERE role = 'superadmin' AND banned = 0`).all<{ c: number }>();
      if (Number(results?.[0]?.c ?? 0) <= 1) {
        return Response.json({ success: false, error: "Cannot deactivate the last superadmin" }, { status: 400 });
      }
    }

    await db.prepare(`UPDATE "user" SET banned = 1 WHERE email = ?1`).bind(email).run();
    return Response.json({ success: true, message: `${email} deactivated` });
  } catch (error) {
    console.error("Failed to deactivate user:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

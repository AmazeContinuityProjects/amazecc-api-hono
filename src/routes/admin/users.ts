/**
 * /api/admin/users - manage Amaze ID admin access (superadmin-only).
 * Operates on the shared amazecc-auth D1 — the same store that issues the
 * sessions every admin route checks. No passwords ever pass through here:
 * users sign up at auth.amazecc.com; this only flips their role/permissions.
 */
import { getWorkerEnv } from "../../env";
import { requireSuperadmin } from "../../lib/auth";
import { SECTION_KEYS, parsePermissions } from "../../lib/permissions";

const VALID_ROLES = new Set(["user", "admin", "superadmin"]);

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

/** Superadmin-only: list every Amaze ID account (admins first). */
export async function GET(req: Request) {
  const auth = await requireSuperadmin(req);
  if (auth instanceof Response) return auth;

  const db = getWorkerEnv().AUTH_DB;
  if (!db) return Response.json({ success: false, error: "AUTH_DB not bound" }, { status: 500 });
  try {
    const { results } = await db
      .prepare(
        `SELECT id, name, email, role, permissions, banned, vtopRegNo, createdAt
           FROM "user"
          ORDER BY CASE role WHEN 'superadmin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, createdAt DESC`
      )
      .all<D1UserRow>();
    return Response.json({ success: true, users: (results ?? []).map(toApiUser) });
  } catch (error) {
    console.error("Failed to fetch users:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

/**
 * Superadmin-only: grant (or re-grant) admin access to an existing Amaze ID.
 * Body: { email: string, role?: "admin" | "superadmin" | "user", permissions?: string[] }
 * The user must have signed up at auth.amazecc.com first.
 */
export async function POST(req: Request) {
  const auth = await requireSuperadmin(req);
  if (auth instanceof Response) return auth;

  const db = getWorkerEnv().AUTH_DB;
  if (!db) return Response.json({ success: false, error: "AUTH_DB not bound" }, { status: 500 });

  try {
    const body = (await req.json()) as { email?: string; role?: string; permissions?: string[] };
    const email = body.email?.trim().toLowerCase();
    if (!email) return Response.json({ success: false, error: "email is required" }, { status: 400 });

    const role = body.role ?? "admin";
    if (!VALID_ROLES.has(role)) {
      return Response.json({ success: false, error: 'Invalid role. Must be "user", "admin" or "superadmin"' }, { status: 400 });
    }

    const permissions = body.permissions ?? [];
    const invalid = permissions.filter((p) => !(SECTION_KEYS as readonly string[]).includes(p));
    if (invalid.length > 0) {
      return Response.json({ success: false, error: `Invalid permissions: ${invalid.join(", ")}` }, { status: 400 });
    }

    const existing = await db.prepare(`SELECT id FROM "user" WHERE email = ?1`).bind(email).first<{ id: string }>();
    if (!existing) {
      return Response.json(
        { success: false, error: "No Amaze ID with that email. Ask them to sign up at auth.amazecc.com first." },
        { status: 404 }
      );
    }

    await db
      .prepare(`UPDATE "user" SET role = ?1, permissions = ?2 WHERE email = ?3`)
      .bind(role, permissions.length ? permissions.join(",") : null, email)
      .run();

    const updated = await db
      .prepare(`SELECT id, name, email, role, permissions, banned, vtopRegNo, createdAt FROM "user" WHERE email = ?1`)
      .bind(email)
      .first<D1UserRow>();

    return Response.json({ success: true, message: `Access granted for ${email}`, user: updated ? toApiUser(updated) : undefined });
  } catch (error) {
    console.error("Failed to add user:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

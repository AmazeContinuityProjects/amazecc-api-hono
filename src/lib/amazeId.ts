/**
 * Amaze ID verification against the shared amazecc-auth D1 database.
 *
 * auth.amazecc.com (amazecc-auth worker) owns users/sessions. This worker is
 * bound to the SAME D1 database (AUTH_DB), so it can verify a session token
 * with one indexed query — the same lookup better-auth does for its own
 * routes. Revocation is instant (delete the session row); no JWKS round-trip
 * needed for first-party clients.
 *
 * Clients authenticate with the better-auth session token as
 * `Authorization: Bearer <token>` (token straight from the sign-in response,
 * or the session cookie value for same-site callers).
 */
import { getWorkerEnv } from "../env";
import { SUPERADMIN_PERMISSIONS, parsePermissions } from "./permissions";

export interface AmazeIdIdentity {
  id: string;
  email: string;
  name: string;
  role: string; // "superadmin" | "admin" | "user"
  /** Parsed granular permission keys (empty for superadmins/users). */
  permissions: string[];
  vtopRegNo: string | null;
}

export interface AdminGrant {
  username: string;
  role: "admin" | "superadmin";
  permissions: string[];
}

export { SUPERADMIN_PERMISSIONS };

export function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const raw = authHeader.slice(7).trim();
  // better-auth session cookies are `<token>.<signature>`; accept both forms.
  const dot = raw.indexOf(".");
  return dot > 0 ? raw.slice(0, dot) : raw;
}

export function adminUnauthorized(): Response {
  return Response.json({ success: false, message: "Unauthorized" }, { status: 401 });
}

export function adminForbidden(message = "You do not have permission for this section"): Response {
  return Response.json({ success: false, message }, { status: 403 });
}

interface SessionRow {
  userId: string;
  expiresAt: string | number;
  id: string;
  email: string;
  name: string;
  role: string | null;
  banned: number | null;
  vtopRegNo: string | null;
  permissions: string | null;
}

/** Look up the session join user row for a raw token. Returns null on any failure (fail closed). */
export async function lookupSession(token: string): Promise<SessionRow | null> {
  const db = getWorkerEnv().AUTH_DB;
  if (!db) {
    console.error("[amaze-id] AUTH_DB binding is missing");
    return null;
  }
  try {
    return await db
      .prepare(
        `SELECT s.userId AS userId, s.expiresAt AS expiresAt, u.id AS id, u.email AS email,
                u.name AS name, u.role AS role, u.banned AS banned, u.vtopRegNo AS vtopRegNo,
                u.permissions AS permissions
           FROM "session" s JOIN "user" u ON u.id = s.userId
          WHERE s.token = ?1
          LIMIT 1`
      )
      .bind(token)
      .first<SessionRow>();
  } catch (err) {
    console.error("[amaze-id] session lookup failed:", err);
    return null;
  }
}

export async function verifyAmazeSession(req: Request): Promise<AmazeIdIdentity | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  const row = await lookupSession(token);
  if (!row) return null;
  if (row.banned) return null;
  const exp = new Date(row.expiresAt).getTime();
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role ?? "user",
    permissions: parsePermissions(row.permissions),
    vtopRegNo: row.vtopRegNo ?? null,
  };
}

/** True for any admin-capable Amaze ID (admin with ≥0 sections, or superadmin). */
export function isAdminRole(role: string): boolean {
  return role === "admin" || role === "superadmin";
}

/** Does this identity hold the given section permission? Superadmins hold everything. */
export function hasPermission(identity: AmazeIdIdentity, permission: string): boolean {
  if (identity.role === "superadmin") return true;
  if (identity.role !== "admin") return false;
  return identity.permissions.includes(permission);
}

/**
 * Require any admin-capable Amaze ID (superadmin or admin with section rights).
 * Use requireSection(permission) for section-gated routes.
 */
export async function requireAdminAuth(req: Request): Promise<AdminGrant | Response> {
  const identity = await verifyAmazeSession(req);
  if (!identity || !isAdminRole(identity.role)) return adminUnauthorized();
  return {
    username: identity.email,
    role: identity.role as "admin" | "superadmin",
    permissions: identity.role === "superadmin" ? SUPERADMIN_PERMISSIONS : identity.permissions,
  };
}

/**
 * Require an Amaze ID whose user holds the given section permission
 * (superadmins always pass; plain `user` never does).
 */
export function requireSection(section: string) {
  return async function requireSectionAuth(req: Request): Promise<AdminGrant | Response> {
    const identity = await verifyAmazeSession(req);
    if (!identity || !isAdminRole(identity.role)) return adminUnauthorized();
    if (!hasPermission(identity, section)) {
      return adminForbidden(`Missing permission for section: ${section}`);
    }
    return {
      username: identity.email,
      role: identity.role as "admin" | "superadmin",
      permissions: identity.role === "superadmin" ? SUPERADMIN_PERMISSIONS : identity.permissions,
    };
  };
}

/** Require a superadmin specifically. Anonymous → 401, non-superadmin → 403. */
export async function requireSuperadmin(req: Request): Promise<AdminGrant | Response> {
  const identity = await verifyAmazeSession(req);
  if (!identity) return adminUnauthorized();
  if (identity.role !== "superadmin") {
    return adminForbidden("Only superadmins can do this");
  }
  return { username: identity.email, role: "superadmin", permissions: SUPERADMIN_PERMISSIONS };
}

/** Kept for compatibility: superadmins always pass; admins check the permission list. */
export function hasAdminPermission(
  admin: { role: string; permissions: string[] },
  required: string | string[]
): boolean {
  if (admin.role === "superadmin") return true;
  const perms = Array.isArray(required) ? required : [required];
  return perms.some((p) => admin.permissions.includes(p));
}

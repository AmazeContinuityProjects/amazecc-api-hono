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

export interface AmazeIdIdentity {
  id: string;
  email: string;
  name: string;
  role: string;
  vtopRegNo: string | null;
}

export interface AdminGrant {
  username: string;
  role: "admin";
  permissions: string[];
}

export const SUPERADMIN_PERMISSIONS = [
  "dashboard",
  "qbank",
  "buses",
  "push",
  "fresher-resources",
  "faculty-directories",
  "faculty-directory",
  "users",
  "transport",
  "gorobo",
];

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

interface SessionRow {
  userId: string;
  expiresAt: string | number;
  id: string;
  email: string;
  name: string;
  role: string | null;
  banned: number | null;
  vtopRegNo: string | null;
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
                u.name AS name, u.role AS role, u.banned AS banned, u.vtopRegNo AS vtopRegNo
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
    vtopRegNo: row.vtopRegNo ?? null,
  };
}

/**
 * Require an Amaze ID session whose user has the `admin` role.
 * (There is deliberately no `superadmin` distinction yet — one admin role.)
 */
export async function requireAdminAuth(req: Request): Promise<AdminGrant | Response> {
  const identity = await verifyAmazeSession(req);
  if (!identity || identity.role !== "admin") return adminUnauthorized();
  return { username: identity.email, role: "admin", permissions: SUPERADMIN_PERMISSIONS };
}

/**
 * Kept for compatibility with the existing admin routes. Every Amaze ID admin
 * currently holds all permissions; when a granular permission model lands in
 * amazecc-auth (e.g. a `permissions` JSON column on `user`), thread it through
 * here instead of SUPERADMIN_PERMISSIONS.
 */
export function hasAdminPermission(
  admin: { role: string; permissions: string[] },
  required: string | string[]
): boolean {
  const perms = Array.isArray(required) ? required : [required];
  return perms.some((p) => admin.permissions.includes(p));
}

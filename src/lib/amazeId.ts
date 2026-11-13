/**
 * Amaze ID verification against the shared amazecc-auth D1 database.
 *
 * auth.amazecc.com (amazecc-auth worker) owns users/tokens. This worker is
 * bound to the SAME D1 database (AUTH_DB), so it can verify first-party
 * credentials locally. Two credential shapes are accepted:
 *
 *   1. better-auth session tokens - opaque strings, sent as
 *      `Authorization: Bearer <token>` (or the `<token>.<signature>` session
 *      cookie for same-site callers). Verified by exact-match D1 lookup on
 *      the `session` table (instant revocation).
 *   2. OAuth access tokens (authorization_code/refresh_token grants) -
 *      normally opaque, stored as base64url(SHA-256(token)) in
 *      `oauthAccessToken`; verified by hashing the presented token and an
 *      indexed D1 lookup (revocation + expiry enforced). If a resource
 *      audience is ever registered, the provider mints EdDSA JWTs
 *      (`typ: "at+jwt"`) instead - those are verified offline against the
 *      issuer's JWKS.
 *
 * ID tokens (typ != at+jwt) and DPoP-bound tokens are never accepted as
 * plain Bearer credentials here.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
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
  // JWT access tokens are `<header>.<payload>.<signature>` and must be passed
  // through intact - only the one-dot cookie form gets truncated.
  const dotCount = (raw.match(/\./g) ?? []).length;
  if (dotCount === 1) {
    const dot = raw.indexOf(".");
    return dot > 0 ? raw.slice(0, dot) : raw;
  }
  return raw;
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

interface OauthAccessTokenRow {
  expiresAt: string | number;
  revoked: string | null;
  id: string;
  email: string;
  name: string;
  role: string | null;
  banned: number | null;
  vtopRegNo: string | null;
  permissions: string | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string | null;
  banned: number | null;
  vtopRegNo: string | null;
  permissions: string | null;
}

const ISSUER = "https://auth.amazecc.com/api/auth";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${ISSUER}/jwks`), {
      cacheMaxAge: 10 * 60_000,
      cooldownDuration: 30_000,
    });
  }
  return jwks;
}

/** base64url(SHA-256(token)) - exactly how the provider stores opaque access tokens. */
async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

const USER_SELECT = `u.email AS email, u.name AS name, u.role AS role, u.banned AS banned,
                u.vtopRegNo AS vtopRegNo, u.permissions AS permissions`;

function identityFromUser(row: UserRow): AmazeIdIdentity {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role ?? "user",
    permissions: parsePermissions(row.permissions),
    vtopRegNo: row.vtopRegNo ?? null,
  };
}

/** Look up the user row for an id. Returns null on any failure (fail closed). */
export async function lookupUserById(id: string): Promise<UserRow | null> {
  const db = getWorkerEnv().AUTH_DB;
  if (!db) {
    console.error("[amaze-id] AUTH_DB binding is missing");
    return null;
  }
  try {
    return await db
      .prepare(`SELECT u.id AS id, ${USER_SELECT} FROM "user" u WHERE u.id = ?1 LIMIT 1`)
      .bind(id)
      .first<UserRow>();
  } catch (err) {
    console.error("[amaze-id] user lookup failed:", err);
    return null;
  }
}

/** Look up a user by hashed OAuth access token (joins oauthAccessToken). */
async function lookupOauthAccessToken(hash: string): Promise<OauthAccessTokenRow | null> {
  const db = getWorkerEnv().AUTH_DB;
  if (!db) {
    console.error("[amaze-id] AUTH_DB binding is missing");
    return null;
  }
  try {
    return await db
      .prepare(
        `SELECT t.expiresAt AS expiresAt, t.revoked AS revoked, u.id AS id,
                ${USER_SELECT}
           FROM "oauthAccessToken" t JOIN "user" u ON u.id = t.userId
          WHERE t.token = ?1
          LIMIT 1`
      )
      .bind(hash)
      .first<OauthAccessTokenRow>();
  } catch (err) {
    console.error("[amaze-id] access token lookup failed:", err);
    return null;
  }
}

export async function verifyAmazeSession(req: Request): Promise<AmazeIdIdentity | null> {
  const token = getBearerToken(req);
  if (!token) return null;

  const dotCount = (token.match(/\./g) ?? []).length;

  // JWT access tokens (only minted once a resource audience is registered):
  // verify offline against the issuer's JWKS. ID tokens never pass - typ must
  // be at+jwt - and DPoP-bound tokens (cnf) are rejected as plain Bearer.
  if (dotCount === 2) {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, getJwks(), { issuer: ISSUER });
      if (protectedHeader.typ !== "at+jwt") return null;
      if (payload.cnf) return null;
      const sub = payload.sub;
      if (!sub) return null;
      const user = await lookupUserById(sub);
      if (!user || user.banned) return null;
      return identityFromUser(user);
    } catch {
      return null; // fail closed
    }
  }

  // Opaque credentials: indistinguishable by shape. Try the OAuth access
  // token store (hashed) first, then the better-auth session table - either
  // match authenticates the caller.
  try {
    const hash = await sha256Base64Url(token);
    const oauthRow = await lookupOauthAccessToken(hash);
    if (oauthRow) {
      if (oauthRow.revoked) return null;
      const exp = new Date(oauthRow.expiresAt).getTime();
      if (!Number.isFinite(exp) || exp <= Date.now()) return null;
      if (oauthRow.banned) return null;
      return identityFromUser(oauthRow);
    }
  } catch (err) {
    console.error("[amaze-id] opaque token check failed:", err);
    return null;
  }

  const row = await lookupSession(token);
  if (!row) return null;
  if (row.banned) return null;
  const exp = new Date(row.expiresAt).getTime();
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  return identityFromUser({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    banned: row.banned,
    vtopRegNo: row.vtopRegNo,
    permissions: row.permissions,
  });
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

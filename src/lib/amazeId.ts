/**
 * Amaze ID verification against the shared amazecc-auth D1 database.
 *
 * auth.amazecc.com (amazecc-auth worker) owns users/sessions. This worker is
 * bound to the SAME D1 database (AUTH_DB), so it can verify a session token
 * with indexed queries. OAuth access tokens are stored as SHA-256 hashes in
 * the same database and are checked alongside the legacy session tokens.
 *
 * Clients authenticate with `Authorization: Bearer <token>` or, for
 * DPoP-bound OAuth tokens, `Authorization: DPoP <token>` plus a DPoP proof.
 */
import { getWorkerEnv } from "../env";
import { base64ToBytes, base64ToString, bytesToBase64 } from "./crypto";
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

type AuthorizationToken = {
  scheme: "bearer" | "dpop";
  token: string;
};

function getAuthorizationToken(req: Request): AuthorizationToken | null {
  const match = /^(Bearer|DPoP)\s+([^\s]+)$/i.exec(req.headers.get("Authorization") ?? "");
  if (!match) return null;
  return {
    scheme: match[1]!.toLowerCase() as AuthorizationToken["scheme"],
    token: match[2]!,
  };
}

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

interface OAuthAccessTokenRow extends SessionRow {
  revoked: string | null;
  confirmation: string | null;
  sessionId: string | null;
  activeSessionId: string | null;
  sessionExpiresAt: string | number | null;
  clientDisabled: number | null;
}

function hasActiveLinkedSession(row: OAuthAccessTokenRow): boolean {
  if (!row.sessionId) return true;
  if (!row.activeSessionId || row.sessionExpiresAt === null) return false;
  const expiresAt = new Date(row.sessionExpiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

// In-memory cache for validated sessions within the Worker isolate (60s TTL)
const sessionCache = new Map<string, { identity: AmazeIdIdentity; expiresAt: number }>();

function getCachedIdentity(token: string): AmazeIdIdentity | null {
  const cached = sessionCache.get(token);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    sessionCache.delete(token);
    return null;
  }
  return cached.identity;
}

function setCachedIdentity(token: string, identity: AmazeIdIdentity, ttlMs = 60_000): void {
  if (sessionCache.size > 2000) sessionCache.clear();
  sessionCache.set(token, { identity, expiresAt: Date.now() + ttlMs });
}

export function clearSessionCache(): void {
  sessionCache.clear();
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

async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return bytesToBase64(digest).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function lookupOAuthAccessToken(hashedToken: string): Promise<OAuthAccessTokenRow | null> {
  const db = getWorkerEnv().AUTH_DB;
  if (!db) {
    console.error("[amaze-id] AUTH_DB binding is missing");
    return null;
  }
  try {
    return await db
      .prepare(
        `SELECT at.expiresAt AS expiresAt, at.revoked AS revoked, at.confirmation AS confirmation,
                at.sessionId AS sessionId, s.id AS activeSessionId, s.expiresAt AS sessionExpiresAt,
                c.disabled AS clientDisabled, u.id AS id, at.userId AS userId, u.email AS email,
                u.name AS name, u.role AS role, u.banned AS banned, u.vtopRegNo AS vtopRegNo,
                u.permissions AS permissions
           FROM "oauthAccessToken" at
           JOIN "user" u ON u.id = at.userId
           JOIN "oauthClient" c ON c.clientId = at.clientId
           LEFT JOIN "session" s ON s.id = at.sessionId
          WHERE at.token = ?1
          LIMIT 1`
      )
      .bind(hashedToken)
      .first<OAuthAccessTokenRow>();
  } catch (err) {
    console.error("[amaze-id] OAuth access-token lookup failed:", err);
    return null;
  }
}

function toIdentity(row: SessionRow): AmazeIdIdentity | null {
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

function parseJwtPart(value: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = base64ToString(value);
  if (decoded === null) return null;
  try {
    const parsed: unknown = JSON.parse(decoded);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeDpopHtu(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hash) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

let lastDpopReplayCleanupAt = 0;
// The global guard and route handlers may verify the same request; consume its DPoP proof once.
const sessionVerificationByRequest = new WeakMap<Request, Promise<AmazeIdIdentity | null>>();

async function reserveDpopProof(
  replayKey: string,
  expiresAt: Date,
): Promise<boolean> {
  const db = getWorkerEnv().AUTH_DB;
  if (!db) {
    console.error("[amaze-id] AUTH_DB binding is missing");
    return false;
  }
  const now = new Date();
  try {
    if (now.getTime() - lastDpopReplayCleanupAt >= 60_000) {
      await db
        .prepare(`DELETE FROM "verification" WHERE id >= 'dpop-proof:' AND id < 'dpop-proof;' AND expiresAt <= ?1`)
        .bind(now.toISOString())
        .run();
      lastDpopReplayCleanupAt = now.getTime();
    }
    const id = `dpop-proof:${replayKey}`;
    const result = await db
      .prepare(
        `INSERT INTO "verification" (id, identifier, value, expiresAt, createdAt, updatedAt)
         VALUES (?1, ?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(id) DO NOTHING`
      )
      .bind(id, replayKey, expiresAt.toISOString(), now.toISOString())
      .run();
    return result.meta.changes === 1;
  } catch (err) {
    console.error("[amaze-id] DPoP replay reservation failed:", err);
    return false;
  }
}

async function verifyDpopAccessToken(
  req: Request,
  token: string,
  confirmationValue: string,
): Promise<boolean> {
  let confirmation: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(confirmationValue);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    confirmation = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  if (typeof confirmation.jkt !== "string") return false;

  const proof = req.headers.get("DPoP");
  if (!proof) return false;
  const parts = proof.split(".");
  if (parts.length !== 3) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2]!)) return false;
  const header = parseJwtPart(parts[0]!);
  const payload = parseJwtPart(parts[1]!);
  const signature = base64ToBytes(parts[2]!);
  if (
    !header ||
    !payload ||
    !signature ||
    signature.length !== 64 ||
    header.typ !== "dpop+jwt" ||
    header.alg !== "ES256" ||
    header.crit !== undefined
  ) {
    return false;
  }

  const jwkValue = header.jwk;
  if (jwkValue === null || typeof jwkValue !== "object" || Array.isArray(jwkValue)) return false;
  const jwk = jwkValue as Record<string, unknown>;
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string" ||
    "d" in jwk
  ) {
    return false;
  }

  const htm = payload.htm;
  const htu = payload.htu;
  const jti = payload.jti;
  const iat = payload.iat;
  if (
    typeof htm !== "string" ||
    typeof htu !== "string" ||
    typeof jti !== "string" ||
    !jti ||
    jti.length > 256 ||
    typeof iat !== "number" ||
    !Number.isFinite(iat) ||
    typeof payload.ath !== "string" ||
    htm.toUpperCase() !== req.method.toUpperCase()
  ) {
    return false;
  }

  const requestHtu = normalizeDpopHtu(req.url);
  const proofHtu = normalizeDpopHtu(htu);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    !requestHtu ||
    proofHtu !== requestHtu ||
    iat > nowSeconds + 5 ||
    nowSeconds - iat > 300
  ) {
    return false;
  }

  const publicJwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    ext: true,
    key_ops: ["verify"],
  };
  const thumbprint = await hashToken(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
  if (thumbprint !== confirmation.jkt || payload.ath !== (await hashToken(token))) return false;

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return false;
  } catch {
    return false;
  }

  const replayKey = await hashToken(`${thumbprint}\n${htm.toUpperCase()}\n${requestHtu}\n${jti}`);
  return reserveDpopProof(replayKey, new Date((iat + 300) * 1000));
}

export function verifyAmazeSession(req: Request): Promise<AmazeIdIdentity | null> {
  const cached = sessionVerificationByRequest.get(req);
  if (cached) return cached;
  const verification = verifyAmazeSessionOnce(req);
  sessionVerificationByRequest.set(req, verification);
  return verification;
}

async function verifyAmazeSessionOnce(req: Request): Promise<AmazeIdIdentity | null> {
  const authorization = getAuthorizationToken(req);
  if (!authorization) return null;

  if (authorization.scheme === "bearer" && authorization.token.includes(".")) {
    const sessionToken = authorization.token.slice(0, authorization.token.indexOf("."));
    const session = await lookupSession(sessionToken);
    if (session) {
      const identity = toIdentity(session);
      if (identity) return identity;
    }
  }

  const accessToken = await lookupOAuthAccessToken(await hashToken(authorization.token));
  if (accessToken) {
    if (
      accessToken.revoked ||
      accessToken.clientDisabled ||
      !hasActiveLinkedSession(accessToken)
    ) {
      return null;
    }
    const identity = toIdentity(accessToken);
    if (!identity) return null;
    if (accessToken.confirmation !== null) {
      if (
        authorization.scheme !== "dpop" ||
        !(await verifyDpopAccessToken(req, authorization.token, accessToken.confirmation))
      ) {
        return null;
      }
    } else if (authorization.scheme !== "bearer") {
      return null;
    }
    return identity;
  }

  if (authorization.scheme !== "bearer") return null;
  const cached = getCachedIdentity(authorization.token);
  if (cached) return cached;
  const session = await lookupSession(authorization.token);
  const identity = session ? toIdentity(session) : null;
  if (identity) setCachedIdentity(authorization.token, identity);
  return identity;
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

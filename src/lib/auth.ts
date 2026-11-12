/**
 * HMAC bearer tokens for admin and service callers.
 *
 * Token format is byte-compatible with the previous implementation so existing
 * admin sessions stay valid after the migration:
 *
 *   token   = base64(JSON payload) "." hex(HMAC-SHA256(payload, derivedKey))
 *   derivedKey = HMAC-SHA256(ADMIN_SECRET, "amazecc-token:<typ>")
 *
 * Each token type signs with its own derived key, so a club/service token is
 * never accepted as an admin token and vice versa.
 */
import { getWorkerEnv } from "../env";
import { getDbPool } from "./db";
import { hmacSha256Hex, base64ToString, stringToBase64, timingSafeEqualStr } from "./crypto";

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

const ADMIN_TYPE = "admin";
const SERVICE_TYPE = "service";
const SERVICE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h — re-minted on enroll
const ADMIN_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export interface AdminTokenPayload {
  typ: typeof ADMIN_TYPE;
  username: string;
  role: "superadmin" | "admin";
  permissions: string[];
  exp: number;
}

export interface ServiceTokenPayload {
  typ: typeof SERVICE_TYPE;
  /** Pseudonymous owner key (HMAC of the caller's REGISTER NO). */
  sub: string;
  exp: number;
}

function getSecret(): string {
  const secret = getWorkerEnv().ADMIN_SECRET;
  if (!secret) {
    throw new Error("ADMIN_SECRET environment variable is required");
  }
  return secret;
}

async function derivedKey(purpose: string): Promise<Uint8Array> {
  return new Uint8Array(await hmacRaw(getSecret(), `amazecc-token:${purpose}`));
}

async function hmacRaw(secret: string, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
}

async function signPayload(payload: Record<string, unknown>, purpose: string): Promise<string> {
  const payloadStr = stringToBase64(JSON.stringify(payload));
  const key = await derivedKey(purpose);
  const signature = await hmacSha256Hex(key, payloadStr);
  return `${payloadStr}.${signature}`;
}

async function verifyPayload<T extends { typ: string; exp: number }>(
  token: string,
  purpose: string
): Promise<T | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payloadStr, signature] = parts;

    const key = await derivedKey(purpose);
    const expected = await hmacSha256Hex(key, payloadStr!);
    if (!timingSafeEqualStr(signature!, expected)) return null;

    const raw = base64ToString(payloadStr!);
    if (!raw) return null;
    const payload = JSON.parse(raw) as T;

    if (payload.typ !== purpose) return null;
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ── admin tokens ───────────────────────────────────────────────────────── */

export function signAdminToken(
  username: string,
  role: "superadmin" | "admin" = "superadmin",
  permissions: string[] = SUPERADMIN_PERMISSIONS
): Promise<string> {
  return signPayload(
    { typ: ADMIN_TYPE, username, role, permissions, exp: Date.now() + ADMIN_TOKEN_TTL_MS },
    ADMIN_TYPE
  );
}

export function verifyAdminToken(token: string): Promise<AdminTokenPayload | null> {
  return verifyPayload<AdminTokenPayload>(token, ADMIN_TYPE);
}

/* ── service tokens (unified /api/services/* enrollment) ─────────────────── */

export function signServiceToken(ownerKey: string): Promise<string> {
  return signPayload({ typ: SERVICE_TYPE, sub: ownerKey, exp: Date.now() + SERVICE_TOKEN_TTL_MS }, SERVICE_TYPE);
}

export function verifyServiceToken(token: string): Promise<ServiceTokenPayload | null> {
  return verifyPayload<ServiceTokenPayload>(token, SERVICE_TYPE);
}

/* ── request helpers ─────────────────────────────────────────────────────── */

export function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return null;
}

export async function verifyAdminFromRequest(req: Request): Promise<AdminTokenPayload | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  return verifyAdminToken(token);
}

export async function verifyServiceFromRequest(req: Request): Promise<ServiceTokenPayload | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  return verifyServiceToken(token);
}

export interface AdminGrant {
  username: string;
  role: "superadmin" | "admin";
  permissions: string[];
}

/** 401 response for admin routes. */
export function adminUnauthorized(): Response {
  return Response.json({ success: false, message: "Unauthorized" }, { status: 401 });
}

/** 401 response for service routes. */
export function serviceUnauthorized(): Response {
  return Response.json(
    { success: false, error: "unauthorized", message: "Missing or invalid service credentials." },
    { status: 401 }
  );
}

/**
 * Verifies the admin token AND re-reads the grant from the DB on every request
 * (env superadmins stay valid without the DB; everyone else fails closed).
 */
export async function requireAdminAuth(req: Request): Promise<AdminGrant | Response> {
  const payload = await verifyAdminFromRequest(req);
  if (!payload) return adminUnauthorized();
  const current = await currentAdminGrant(payload.username);
  if (!current) return adminUnauthorized();
  return { username: payload.username, ...current };
}

/**
 * Tokens are valid for 7 days, so the signature alone can't reflect a
 * deactivation or a permission change made after login. Re-read the grant on
 * every admin request (admin traffic is tiny). Env superadmins (ADMIN_VTOP_IDS)
 * stay valid without the DB, matching /api/admin/auth; everyone else fails
 * closed if the row is missing, inactive, or the DB can't be reached.
 */
async function currentAdminGrant(
  username: string
): Promise<{ role: "superadmin" | "admin"; permissions: string[] } | null> {
  const normalized = String(username || "").toUpperCase().trim();
  const envSuperadmins = (getWorkerEnv().ADMIN_VTOP_IDS || "")
    .split(",")
    .map((id) => id.trim().toUpperCase())
    .filter(Boolean);
  if (envSuperadmins.includes(normalized)) {
    return { role: "superadmin", permissions: SUPERADMIN_PERMISSIONS };
  }
  try {
    const { rows } = await getDbPool().query(
      "SELECT role, permissions, is_active FROM admin_users WHERE username = $1",
      [normalized]
    );
    const row = rows[0];
    if (!row || !row.is_active) return null;
    const perms = Array.isArray(row.permissions)
      ? row.permissions
      : typeof row.permissions === "string"
        ? JSON.parse(row.permissions)
        : [];
    return { role: row.role === "superadmin" ? "superadmin" : "admin", permissions: perms };
  } catch (err) {
    console.error("[auth] admin grant lookup failed:", err);
    return null;
  }
}

/**
 * Helper to check if an authenticated admin user has one or more required permissions.
 * Superadmins always bypass permission checks.
 */
export function hasAdminPermission(
  admin: { role: "superadmin" | "admin"; permissions: string[] },
  required: string | string[]
): boolean {
  if (admin.role === "superadmin") return true;
  const perms = Array.isArray(required) ? required : [required];
  return perms.some((p) => admin.permissions?.includes(p));
}

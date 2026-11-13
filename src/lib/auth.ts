/**
 * Worker auth composition.
 *
 * Amaze ID (auth.amazecc.com) is the unified identity. Admin routes verify the
 * caller's better-auth session token against the SHARED amazecc-auth D1
 * database (AUTH_DB) — one indexed query, revocation is immediate. There is
 * no HMAC fallback: emergency rollback is `wrangler rollback` to the previous
 * worker version.
 *
 * Service tokens (`typ: "service"`, 24 h TTL) are unchanged — they are minted
 * after a VTOP-verified login for the /api/services/* enrollment flow and are
 * independent of Amaze ID.
 */
import { getWorkerEnv } from "../env";
import { hmacSha256Hex, base64ToString, stringToBase64, timingSafeEqualStr } from "./crypto";
import {
  SUPERADMIN_PERMISSIONS,
  adminUnauthorized,
  getBearerToken,
  hasAdminPermission,
  requireAdminAuth,
  verifyAmazeSession,
  type AdminGrant,
  type AmazeIdIdentity,
} from "./amazeId";

export {
  SUPERADMIN_PERMISSIONS,
  adminUnauthorized,
  getBearerToken,
  hasAdminPermission,
  requireAdminAuth,
  verifyAmazeSession,
};
export type { AdminGrant, AmazeIdIdentity };

const SERVICE_TYPE = "service";
const SERVICE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h - re-minted on enroll

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
  const key = new Uint8Array(await hmacRaw(getSecret(), `amazecc-token:${purpose}`));
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
    const key = new Uint8Array(await hmacRaw(getSecret(), `amazecc-token:${purpose}`));
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

/* ── service tokens (unified /api/services/* enrollment) ─────────────────── */

export function signServiceToken(ownerKey: string): Promise<string> {
  return signPayload({ typ: SERVICE_TYPE, sub: ownerKey, exp: Date.now() + SERVICE_TOKEN_TTL_MS }, SERVICE_TYPE);
}

export function verifyServiceToken(token: string): Promise<ServiceTokenPayload | null> {
  return verifyPayload<ServiceTokenPayload>(token, SERVICE_TYPE);
}

export async function verifyServiceFromRequest(req: Request): Promise<ServiceTokenPayload | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  return verifyServiceToken(token);
}

/** 401 response for service routes. */
export function serviceUnauthorized(): Response {
  return Response.json(
    { success: false, error: "unauthorized", message: "Missing or invalid service credentials." },
    { status: 401 }
  );
}

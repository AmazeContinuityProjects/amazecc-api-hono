/**
 * Club-representative bearer tokens (typ "club"). Shares ADMIN_SECRET with the
 * admin and service tokens, but each type signs with its own derived key.
 * Byte-compatible with the previous implementation.
 */
import { getWorkerEnv } from "../env";
import { hmacSha256Hex, base64ToString, stringToBase64, timingSafeEqualStr } from "./crypto";

export interface ClubRole {
  club_id: string;
  role: string;
}

export interface ClubTokenPayload {
  typ: "club";
  vtop_id: string;
  clubs: ClubRole[];
  club_id: string;
  role: string;
  exp: number;
}

const TOKEN_TYPE = "club";

function getSecret(): string {
  const secret = getWorkerEnv().ADMIN_SECRET;
  if (!secret) throw new Error("ADMIN_SECRET environment variable is required");
  return secret;
}

async function hmacRaw(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function signingKey(): Promise<Uint8Array> {
  return hmacRaw(getSecret(), `amazecc-token:${TOKEN_TYPE}`);
}

async function generateSignature(payload: string): Promise<string> {
  return hmacSha256Hex(await signingKey(), payload);
}

const TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export async function signClubToken(vtop_id: string, clubs: ClubRole[]): Promise<string> {
  const payloadObj = {
    typ: TOKEN_TYPE,
    vtop_id,
    clubs,
    club_id: clubs[0]?.club_id || "",
    role: clubs[0]?.role || "representative",
    exp: Date.now() + TTL_MS,
  };
  const payloadStr = stringToBase64(JSON.stringify(payloadObj));
  return `${payloadStr}.${await generateSignature(payloadStr)}`;
}

export async function verifyClubToken(token: string): Promise<ClubTokenPayload | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payloadStr, signature] = parts;
    const expected = await generateSignature(payloadStr!);
    if (!timingSafeEqualStr(signature!, expected)) return null;

    const raw = base64ToString(payloadStr!);
    if (!raw) return null;
    const payload = JSON.parse(raw) as ClubTokenPayload;
    if (payload.typ !== TOKEN_TYPE) return null;
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function getClubTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return null;
}

export async function verifyClubAuthFromRequest(req: Request): Promise<ClubTokenPayload | null> {
  const token = getClubTokenFromRequest(req);
  if (token) return verifyClubToken(token);
  return null;
}

/** 401 for club-gated routes (unused until the club-admin surface is ported). */
export function clubUnauthorized(): Response {
  return Response.json({ success: false, error: "Unauthorized Club Access" }, { status: 401 });
}

/**
 * Verifies a club token AND resolves the `x-club-id` context:
 * matched club → that club; super-club-rep → any club; otherwise 403.
 */
export async function requireClubAuth(req: Request): Promise<ClubTokenPayload | Response> {
  const payload = await verifyClubAuthFromRequest(req);
  if (!payload) return clubUnauthorized();

  const xClubId = req.headers.get("x-club-id") || req.headers.get("X-Club-Id");
  if (xClubId && payload.clubs) {
    const trimmedXClubId = String(xClubId).trim();
    const clubContext = payload.clubs.find((c) => String(c.club_id).trim() === trimmedXClubId);

    if (clubContext) {
      payload.club_id = clubContext.club_id;
      payload.role = clubContext.role;
    } else if (payload.clubs.some((c) => c.role === "super-club-rep")) {
      payload.club_id = trimmedXClubId;
      payload.role = "super-club-rep";
    } else {
      return Response.json({ success: false, error: "Unauthorized for this club" }, { status: 403 });
    }
  }

  return payload;
}

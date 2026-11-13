/**
 * Club-representative auth. Identity is Amaze ID (auth.amazecc.com); this worker
 * shares that D1 (AUTH_DB) to verify sessions and read the linked VTOP reg no.
 * A user is a club rep ONLY IF:
 *   1. their Amaze ID session is valid, AND
 *   2. their account is linked to a VTOP profile (`vtopRegNo` set), AND
 *   3. that VTOP reg no exists in `club_representatives`.
 *
 * No credentials, no HMAC, no separate club tokens — unlink VTOP and club
 * access is gone instantly. `club_representatives` is still fed by the daily
 * VTOP sync (lib/syncClubs) and stays the source of truth for club roles.
 */
import { getDbPool } from "./db";
import { verifyAmazeSession } from "./amazeId";

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

export function clubUnauthorized(): Response {
  return Response.json({ success: false, error: "Unauthorized Club Access" }, { status: 401 });
}

export function clubUnlinked(): Response {
  return Response.json(
    {
      success: false,
      error: "vtop_link_required",
      message: "Link your VTOP profile at auth.amazecc.com/account to use club admin.",
    },
    { status: 403 }
  );
}

export function clubForbidden(message = "You do not represent any club"): Response {
  return Response.json({ success: false, error: "not_a_club_rep", message }, { status: 403 });
}

/** Fetch + dedupe the caller's club roles (super-club-rep wins duplicates). */
export async function fetchClubRoles(vtopRegNo: string): Promise<ClubRole[]> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT DISTINCT club_id, role FROM club_representatives WHERE vtop_id = $1`,
    [vtopRegNo]
  );
  const seen = new Map<string, ClubRole>();
  for (const r of rows as ClubRole[]) {
    if (!r?.club_id) continue;
    const existing = seen.get(r.club_id);
    if (!existing || r.role === "super-club-rep") {
      seen.set(r.club_id, { club_id: r.club_id, role: r.role });
    }
  }
  return [...seen.values()];
}

/** True when the caller holds super-club-rep in ANY club (cross-club powers). */
export function isSuperClubRep(clubs: ClubRole[]): boolean {
  return clubs.some((c) => c.role === "super-club-rep");
}

/**
 * Verifies an Amaze ID session AND resolves the `x-club-id` context:
 * rep of the club → that club; super-club-rep → any club; otherwise 403.
 * Only runs against `club_representatives` for a VTOP-linked account.
 */
export async function requireClubAuth(req: Request): Promise<ClubTokenPayload | Response> {
  const identity = await verifyAmazeSession(req);
  if (!identity) return clubUnauthorized();
  if (!identity.vtopRegNo) return clubUnlinked();

  const clubs = await fetchClubRoles(identity.vtopRegNo);
  if (clubs.length === 0) return clubForbidden();

  const xClubId = req.headers.get("x-club-id") || req.headers.get("X-Club-Id");
  const isSuper = isSuperClubRep(clubs);

  let club_id: string;
  let role: string;
  if (xClubId && String(xClubId).trim()) {
    const trimmed = String(xClubId).trim();
    const clubContext = clubs.find((c) => String(c.club_id).trim() === trimmed);
    if (clubContext) {
      club_id = clubContext.club_id;
      role = clubContext.role;
    } else if (isSuper) {
      club_id = trimmed;
      role = "super-club-rep";
    } else {
      return Response.json({ success: false, error: "Unauthorized for this club" }, { status: 403 });
    }
  } else {
    club_id = clubs[0]!.club_id;
    role = clubs[0]!.role;
  }

  return {
    typ: "club",
    vtop_id: identity.vtopRegNo,
    clubs,
    club_id,
    role,
    exp: Date.now() + 60 * 60 * 1000,
  };
}

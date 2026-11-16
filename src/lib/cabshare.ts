/**
 * cabshare shared helpers — hono port.
 *
 * Auth model changed from the legacy cabshare HMAC token to Amaze ID (DPoP):
 *   - Request carries Authorization: DPoP <token>
   *   - verifyAmazeSession → D1 users.sub → student_profiles.amaze_sub → reg_no
   *   - User must have an Amaze ID linked to a VTOP reg_no to access cabshare
 *   - cabshare_users gets an owner_key column (= identityHash(reg_no))
 *
 * All cabshare operations use the shared keyed register-number identity instead of the
 * legacy cabshare user_id serial.
 */
import { Hono } from "hono";
import { verifyAmazeSession, adminUnauthorized } from "./amazeId";
import { publicErrorMessage } from "./publicError";
import {
  ensureStudentProfilesSchema,
} from "./student-profiles";
import { regKey } from "./social";
import { getWorkerEnv } from "../env";

export const CABSHARE_TABLE = "cabshare_users";
export const CABSHARE_TRIPS_TABLE = "cabshare_trips";
export const CABSHARE_HUBS_TABLE = "cabshare_hubs";
export const CABSHARE_MATCH_EVENTS_TABLE = "cabshare_match_events";
export const CABSHARE_WAITLIST_TABLE = "cabshare_waitlist";
export const CABSHARE_NOTIFICATIONS_TABLE = "cabshare_notifications";
export const CABSHARE_RATINGS_TABLE = "cabshare_ratings";
export const CABSHARE_BLOCKS_TABLE = "cabshare_blocks";

export type CabshareUser = {
  user_id: number;
  name: string;
  phone_number: string | null;
  reg_number: string;
  owner_key: string;
};

/** Establish caller identity from Amaze ID DPoP session. Returns reg_no. */
export async function requireCabshareUser(
  c: { req: { raw: Request } },
): Promise<string | Response> {
  const identity = await verifyAmazeSession(c.req.raw);
  if (!identity) return adminUnauthorized();
  if (!identity.vtopRegNo) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "profile_incomplete",
        detail: { detail: "Amaze ID is not linked to a VTOP reg number" },
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
  return identity.vtopRegNo.trim().toUpperCase();
}

/** Require the service-data D1 binding; migrations own the table schema. */
export async function ensureCabshareSchema(): Promise<void> {
  if (!getWorkerEnv().APP_DB) throw new Error("APP_DB is not configured");
}

/** Look up or create a cabshare user row for the given reg_no. */
export async function ensureCabshareUser(
  regNo: string,
): Promise<CabshareUser> {
  await ensureCabshareSchema();
  await ensureStudentProfilesSchema();
  const canonicalRegNo = regNo.trim().toUpperCase();
  const ownerKey = regKey(canonicalRegNo);
  const db = getWorkerEnv().APP_DB;
  if (!db) throw new Error("APP_DB is not configured");
  const profile = await db.prepare(`SELECT display_name, phone_number FROM student_profiles WHERE reg_no = ?`)
    .bind(canonicalRegNo).first<{ display_name: string | null; phone_number: string | null }>();
  const name = profile?.display_name || canonicalRegNo;
  const result = await db.prepare(`INSERT INTO ${CABSHARE_TABLE}
      (name, phone_number, reg_number, owner_key)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (reg_number) DO UPDATE SET
      owner_key = excluded.owner_key,
      name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE ${CABSHARE_TABLE}.name END,
      phone_number = COALESCE(excluded.phone_number, ${CABSHARE_TABLE}.phone_number)
    RETURNING *`)
    .bind(name, profile?.phone_number ?? null, canonicalRegNo, ownerKey)
    .first<CabshareUser>();
  if (!result) throw new Error(`Failed to ensure cabshare user ${canonicalRegNo}`);
  return { ...result, user_id: Number(result.user_id) };
}

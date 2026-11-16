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
import { getDbPool } from "./db";
import {
  ensureStudentProfilesSchema,
  getStudentProfileByRegNo,
  upsertStudentProfile,
} from "./student-profiles";
import { regKey } from "./social";

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

/** Ensure cabshare tables exist (inline DDL, house style). */
export async function ensureCabshareSchema(): Promise<void> {
  const pool = getDbPool();

  await ensureStudentProfilesSchema();

  // cabshare_users: add owner_key column if missing
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CABSHARE_TABLE} (
      user_id       SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      phone_number  TEXT,
      reg_number    TEXT NOT NULL UNIQUE,
      owner_key     TEXT UNIQUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Add owner_key if the table already existed without it
  try {
    await pool.query(
      `ALTER TABLE ${CABSHARE_TABLE} ADD COLUMN IF NOT EXISTS owner_key TEXT UNIQUE`,
    );
  } catch {
    // column may already exist
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CABSHARE_HUBS_TABLE} (
      hub_id   SERIAL PRIMARY KEY,
      hub_name TEXT NOT NULL,
      city     TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CABSHARE_TRIPS_TABLE} (
      trip_id            SERIAL PRIMARY KEY,
      user_id            INTEGER NOT NULL REFERENCES ${CABSHARE_TABLE}(user_id),
      hub_id             INTEGER NOT NULL REFERENCES ${CABSHARE_HUBS_TABLE}(hub_id),
      travel_date        DATE NOT NULL,
      preferred_time     TEXT NOT NULL,
      tolerance_hours    INTEGER NOT NULL DEFAULT 0,
      seat_options       JSONB NOT NULL DEFAULT '[]'::jsonb,
      gender_preference  TEXT NOT NULL,
      notes              TEXT,
      status             TEXT NOT NULL DEFAULT 'active',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CABSHARE_MATCH_EVENTS_TABLE} (
      id          SERIAL PRIMARY KEY,
      trip_id     INTEGER NOT NULL REFERENCES ${CABSHARE_TRIPS_TABLE}(trip_id),
      requester_id INTEGER NOT NULL,
      owner_id    INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CABSHARE_WAITLIST_TABLE} (
      waitlist_id SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES ${CABSHARE_TABLE}(user_id),
      hub_id      INTEGER NOT NULL REFERENCES ${CABSHARE_HUBS_TABLE}(hub_id),
      travel_date DATE NOT NULL,
      UNIQUE (user_id, hub_id, travel_date)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CABSHARE_NOTIFICATIONS_TABLE} (
      notif_id SERIAL PRIMARY KEY,
      user_id  INTEGER NOT NULL REFERENCES ${CABSHARE_TABLE}(user_id),
      title    TEXT NOT NULL,
      message  TEXT NOT NULL,
      type     TEXT NOT NULL DEFAULT 'info',
      is_read  BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CABSHARE_RATINGS_TABLE} (
      trip_id   INTEGER NOT NULL REFERENCES ${CABSHARE_TRIPS_TABLE}(trip_id),
      rater_id  INTEGER NOT NULL REFERENCES ${CABSHARE_TABLE}(user_id),
      ratee_id  INTEGER NOT NULL REFERENCES ${CABSHARE_TABLE}(user_id),
      score     INTEGER NOT NULL CHECK (score >= 1 AND score <= 5),
      comment   TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (trip_id, rater_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CABSHARE_BLOCKS_TABLE} (
      blocker_id  INTEGER NOT NULL REFERENCES ${CABSHARE_TABLE}(user_id),
      blocked_id  INTEGER NOT NULL REFERENCES ${CABSHARE_TABLE}(user_id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (blocker_id, blocked_id)
    );
  `);
}

/** Look up or create a cabshare user row for the given reg_no. */
export async function ensureCabshareUser(
  regNo: string,
): Promise<CabshareUser> {
  const pool = getDbPool();
  const canonicalRegNo = regNo.trim().toUpperCase();
  const ownerKey = regKey(canonicalRegNo);
  const profile = await getStudentProfileByRegNo(canonicalRegNo);

  const refreshExisting = async (userId: number): Promise<CabshareUser> => {
    const { rows } = await pool.query(
      `UPDATE ${CABSHARE_TABLE}
          SET owner_key = $1,
              name = COALESCE(NULLIF($2, ''), name),
              phone_number = COALESCE($3, phone_number)
        WHERE user_id = $4
        RETURNING *`,
      [ownerKey, profile?.display_name ?? null, profile?.phone_number ?? null, userId],
    );
    if (!rows.length) throw new Error(`Failed to refresh cabshare user ${userId}`);
    return rows[0] as CabshareUser;
  };

  // Try existing row by owner_key
  let result = await pool.query(
    `SELECT * FROM ${CABSHARE_TABLE} WHERE owner_key = $1 LIMIT 1`,
    [ownerKey],
  );
  if (result.rows.length) return refreshExisting(Number(result.rows[0].user_id));

  // Try existing row by reg_number (legacy migration)
  result = await pool.query(
    `SELECT * FROM ${CABSHARE_TABLE} WHERE UPPER(reg_number) = $1 LIMIT 1`,
    [canonicalRegNo],
  );
  if (result.rows.length) return refreshExisting(Number(result.rows[0].user_id));

  // Create new row — we only have reg_no; name/phone come from student_profiles
  const name = profile?.display_name || canonicalRegNo;
  const phone = profile?.phone_number || null;

  const { rows: inserted } = await pool.query(
    `INSERT INTO ${CABSHARE_TABLE} (name, phone_number, reg_number, owner_key)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [name, phone, canonicalRegNo, ownerKey],
  );
  return inserted[0] as CabshareUser;
}

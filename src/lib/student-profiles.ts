/**
 * student_profiles — the single source of truth for a person across every
 * AmazeCC service (social, cabshare, marks, …).
 *
 * Keyed by reg_no (plaintext VTOP register number, e.g. 25BLC1081) — no
 * masking. When a student first appears in any service, a row is created
 * here with claim_status = 'incomplete'. The student later claims their
 * Amaze ID account, which links D1 `users.sub` (amaze_sub) to this reg_no.
 *
 * Until claimed, Amaze-ID-authenticated routes return 403 profile_incomplete
 * with a "claim your Amaze ID" prompt.
 *
 * Inline DDL, following the house style used by socialDb.ts and marksStats.ts
 * (this repo has no migrations directory — a table only exists once a route
 * has been hit).
 */
import { getDbPool } from "./db";

export const STUDENT_PROFILES_TABLE = "student_profiles";

export type StudentProfile = {
  reg_no: string;
  display_name: string | null;
  phone_number: string | null;
  email: string | null;
  branch: string | null;
  semester_id: string | null;
  photo_url: string | null;
  amaze_sub: string | null;
  claim_status: "incomplete" | "claimed";
  created_at: string;
  updated_at: string;
};

/** Ensure the student_profiles table exists. Safe to call on every request. */
export async function ensureStudentProfilesSchema(): Promise<void> {
  const pool = getDbPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${STUDENT_PROFILES_TABLE} (
      reg_no        TEXT PRIMARY KEY,
      display_name  TEXT,
      phone_number  TEXT,
      email         TEXT,
      branch        TEXT,
      semester_id   TEXT,
      photo_url     TEXT,
      amaze_sub     TEXT UNIQUE,
      claim_status  TEXT NOT NULL DEFAULT 'incomplete',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/** Upsert a person row, minting on first sight. */
export async function upsertStudentProfile(
  regNo: string,
  fields: Partial<{
    display_name: string;
    phone_number: string;
    email: string;
    branch: string;
    semester_id: string;
    photo_url: string;
  }> = {}
): Promise<StudentProfile> {
  const pool = getDbPool();
  const cleanRegNo = regNo.trim().toUpperCase();

  await pool.query(
    `INSERT INTO ${STUDENT_PROFILES_TABLE}
       (reg_no, display_name, phone_number, email, branch, semester_id, photo_url, claim_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'incomplete')
     ON CONFLICT (reg_no) DO UPDATE SET
       display_name = CASE WHEN EXCLUDED.display_name IS NOT NULL AND EXCLUDED.display_name <> ''
                           THEN EXCLUDED.display_name ELSE ${STUDENT_PROFILES_TABLE}.display_name END,
       phone_number = CASE WHEN EXCLUDED.phone_number IS NOT NULL AND EXCLUDED.phone_number <> ''
                           THEN EXCLUDED.phone_number ELSE ${STUDENT_PROFILES_TABLE}.phone_number END,
       email        = CASE WHEN EXCLUDED.email IS NOT NULL AND EXCLUDED.email <> ''
                           THEN EXCLUDED.email ELSE ${STUDENT_PROFILES_TABLE}.email END,
       branch       = CASE WHEN EXCLUDED.branch IS NOT NULL AND EXCLUDED.branch <> ''
                           THEN EXCLUDED.branch ELSE ${STUDENT_PROFILES_TABLE}.branch END,
       semester_id  = CASE WHEN EXCLUDED.semester_id IS NOT NULL AND EXCLUDED.semester_id <> ''
                           THEN EXCLUDED.semester_id ELSE ${STUDENT_PROFILES_TABLE}.semester_id END,
       photo_url    = CASE WHEN EXCLUDED.photo_url IS NOT NULL AND EXCLUDED.photo_url <> ''
                           THEN EXCLUDED.photo_url ELSE ${STUDENT_PROFILES_TABLE}.photo_url END,
       updated_at   = NOW()`,
    [
      cleanRegNo,
      fields.display_name ?? null,
      fields.phone_number ?? null,
      fields.email ?? null,
      fields.branch ?? null,
      fields.semester_id ?? null,
      fields.photo_url ?? null,
    ],
  );

  const profile = await getStudentProfileByRegNo(cleanRegNo);
  if (!profile) {
    throw new Error(`Failed to read back student profile for reg_no ${cleanRegNo}`);
  }
  return profile;
}

/** Look up a profile by reg_no. */
export async function getStudentProfileByRegNo(
  regNo: string,
): Promise<StudentProfile | null> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT reg_no, display_name, phone_number, email, branch, semester_id,
            photo_url, amaze_sub, claim_status,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
            to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
       FROM ${STUDENT_PROFILES_TABLE}
      WHERE reg_no = $1`,
    [regNo.trim().toUpperCase()],
  );
  if (!rows.length) return null;
  return rows[0] as StudentProfile;
}

/** Look up a profile by Amaze ID sub (after the user has claimed their account). */
export async function getStudentProfileByAmazeSub(
  amazeSub: string,
): Promise<StudentProfile | null> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT reg_no, display_name, phone_number, email, branch, semester_id,
            photo_url, amaze_sub, claim_status,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
            to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
       FROM ${STUDENT_PROFILES_TABLE}
      WHERE amaze_sub = $1`,
    [amazeSub],
  );
  if (!rows.length) return null;
  return rows[0] as StudentProfile;
}

/**
 * Link an Amaze ID sub to a reg_no (the "claim" step).
 *
 * Called after the user verifies their Amaze ID email. Sets claim_status to
 * 'claimed' and stores the D1 users.sub so future Amaze-ID-authenticated
 * requests resolve to this person.
 */
export async function linkAmazeSub(
  regNo: string,
  amazeSub: string,
): Promise<StudentProfile> {
  const pool = getDbPool();
  const cleanRegNo = regNo.trim().toUpperCase();

  // Ensure the profile exists (claiming can happen before any service touch)
  await upsertStudentProfile(cleanRegNo);

  const { rows } = await pool.query(
    `UPDATE ${STUDENT_PROFILES_TABLE}
       SET amaze_sub = $2,
           claim_status = 'claimed',
           updated_at = NOW()
     WHERE reg_no = $1
     RETURNING reg_no, display_name, phone_number, email, branch, semester_id,
               photo_url, amaze_sub, claim_status,
               to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
               to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at`,
    [cleanRegNo, amazeSub],
  );
  if (!rows.length) {
    throw new Error(`No student profile for reg_no ${cleanRegNo}`);
  }
  return rows[0] as StudentProfile;
}

/** Backfill student_profiles from an existing reg_no + display_name. */
export async function backfillStudentProfile(
  regNo: string,
  displayName: string | null,
  phoneNumber: string | null,
): Promise<void> {
  await upsertStudentProfile(regNo, {
    display_name: displayName ?? undefined,
    phone_number: phoneNumber ?? undefined,
  });
}

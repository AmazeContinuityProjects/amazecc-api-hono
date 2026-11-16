/**
 * student_profiles � the service-data D1 source of truth for VTOP identities.
 * Register numbers are stored in plaintext so attendance, social, marks, and
 * CabShare records can be joined consistently.
 */
import { getWorkerEnv } from "../env";

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

async function requireStudentProfilesDb(): Promise<D1Database> {
  const db = getWorkerEnv().APP_DB;
  if (!db) throw new Error("APP_DB is not configured");
  return db;
}

/** Require the service-data D1 binding; migrations own the profile schema. */
export async function ensureStudentProfilesSchema(): Promise<void> {
  await requireStudentProfilesDb();
}

async function readD1Profile(column: "reg_no" | "amaze_sub", value: string): Promise<StudentProfile | null> {
  const db = await requireStudentProfilesDb();
  return db.prepare(`SELECT reg_no, display_name, phone_number, email, branch, semester_id,
      photo_url, amaze_sub, claim_status, created_at, updated_at
    FROM ${STUDENT_PROFILES_TABLE} WHERE ${column} = ?`)
    .bind(value).first<StudentProfile>();
}

/** Upsert a person row, minting it the first time any service sees them. */
export async function upsertStudentProfile(
  regNo: string,
  fields: Partial<{
    display_name: string;
    phone_number: string;
    email: string;
    branch: string;
    semester_id: string;
    photo_url: string;
  }> = {},
): Promise<StudentProfile> {
  const cleanRegNo = regNo.trim().toUpperCase();
  const db = await requireStudentProfilesDb();
  const previous = await db.prepare(`SELECT display_name, phone_number, email, branch, semester_id, photo_url
    FROM ${STUDENT_PROFILES_TABLE} WHERE reg_no = ?`).bind(cleanRegNo)
    .first<Pick<StudentProfile, "display_name" | "phone_number" | "email" | "branch" | "semester_id" | "photo_url">>();
  const merged = {
    display_name: fields.display_name || previous?.display_name || null,
    phone_number: fields.phone_number || previous?.phone_number || null,
    email: fields.email || previous?.email || null,
    branch: fields.branch || previous?.branch || null,
    semester_id: fields.semester_id || previous?.semester_id || null,
    photo_url: fields.photo_url || previous?.photo_url || null,
  };
  await db.prepare(`INSERT INTO ${STUDENT_PROFILES_TABLE}
      (reg_no, display_name, phone_number, email, branch, semester_id, photo_url, claim_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'incomplete')
    ON CONFLICT (reg_no) DO UPDATE SET
      display_name = CASE WHEN excluded.display_name IS NOT NULL AND excluded.display_name <> '' THEN excluded.display_name ELSE ${STUDENT_PROFILES_TABLE}.display_name END,
      phone_number = CASE WHEN excluded.phone_number IS NOT NULL AND excluded.phone_number <> '' THEN excluded.phone_number ELSE ${STUDENT_PROFILES_TABLE}.phone_number END,
      email = CASE WHEN excluded.email IS NOT NULL AND excluded.email <> '' THEN excluded.email ELSE ${STUDENT_PROFILES_TABLE}.email END,
      branch = CASE WHEN excluded.branch IS NOT NULL AND excluded.branch <> '' THEN excluded.branch ELSE ${STUDENT_PROFILES_TABLE}.branch END,
      semester_id = CASE WHEN excluded.semester_id IS NOT NULL AND excluded.semester_id <> '' THEN excluded.semester_id ELSE ${STUDENT_PROFILES_TABLE}.semester_id END,
      photo_url = CASE WHEN excluded.photo_url IS NOT NULL AND excluded.photo_url <> '' THEN excluded.photo_url ELSE ${STUDENT_PROFILES_TABLE}.photo_url END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .bind(cleanRegNo, merged.display_name, merged.phone_number, merged.email, merged.branch, merged.semester_id, merged.photo_url)
    .run();
  const profile = await readD1Profile("reg_no", cleanRegNo);
  if (!profile) throw new Error("Failed to read back student profile");
  return profile;
}

export async function getStudentProfileByRegNo(regNo: string): Promise<StudentProfile | null> {
  return readD1Profile("reg_no", regNo.trim().toUpperCase());
}

export async function getStudentProfileByAmazeSub(amazeSub: string): Promise<StudentProfile | null> {
  return readD1Profile("amaze_sub", amazeSub);
}

/** Link the verified D1 Amaze ID subject to a VTOP register number. */
export async function linkAmazeSub(regNo: string, amazeSub: string): Promise<StudentProfile> {
  const cleanRegNo = regNo.trim().toUpperCase();
  const db = await requireStudentProfilesDb();
  await upsertStudentProfile(cleanRegNo);
  await db.prepare(`UPDATE ${STUDENT_PROFILES_TABLE}
    SET amaze_sub = ?, claim_status = 'claimed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE reg_no = ?`).bind(amazeSub, cleanRegNo).run();
  const profile = await getStudentProfileByRegNo(cleanRegNo);
  if (!profile || profile.amaze_sub !== amazeSub) throw new Error(`No student profile for reg_no ${cleanRegNo}`);
  return profile;
}

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

/** Sanitize and store an optional 10-digit Indian mobile number. */
export async function updatePhoneNumber(regNo: string, phoneNumber: string | null): Promise<string | null> {
  const cleanRegNo = regNo.trim().toUpperCase();
  let sanitized: string | null = null;
  if (phoneNumber !== null && phoneNumber !== undefined && phoneNumber !== "") {
    const digits = phoneNumber.replace(/\D/g, "");
    if (!/^[6-9]\d{9}$/.test(digits)) {
      throw new Error("Invalid phone number. Provide a 10-digit mobile number.");
    }
    sanitized = digits;
  }
  const db = await requireStudentProfilesDb();
  await db.prepare(`UPDATE ${STUDENT_PROFILES_TABLE}
    SET phone_number = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE reg_no = ?`).bind(sanitized, cleanRegNo).run();
  return sanitized;
}

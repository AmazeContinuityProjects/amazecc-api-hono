/**
 * student_marks — per-student per-assessment mark hash.
 *
 * We do NOT store the mark itself. We store `mark_hash = hash(mark)` where
 * `hash` is HMAC-SHA256 keyed by the manually-set `GENERATOR_KEY` env var.
 *
 * Why a hash, not encryption:
 *   - The mark domain is tiny (0-100, just 101 integers). Any reversible
 *     scheme (AES, RSA, even unsalted SHA) is brute-forceable in
 *     microseconds. A keyed HMAC is the strongest thing we can do for a
 *     101-element domain — an attacker who doesn't know GENERATOR_KEY
 *     cannot verify a guess, and an attacker who DOES know it can already
 *     compute all 101 hashes anyway.
 *   - The hash serves two purposes:
 *       1. Client-side prevMark validation: the client tells us its previous
 *          mark; we hash it and compare to the stored hash. Match → safe to
 *          remove the old mark from the Welford accumulator.
 *       2. Recount trigger: if the client's hash doesn't match what we
 *          stored, something is wrong (key rotated, data corrupted, client
 *          tampering). We zero every student's mark for that assessment and
 *          make them re-submit fresh.
 *
 * Recount semantics (on hash mismatch for one assessment):
 *   1. DELETE all student_marks rows for (class_id, scope, assessment_key)
 *   2. Reset class_assessment_stats accumulator to count=0, mean=0, m2=0
 *   3. Every enrolled student re-submits their mark (via /attendance or /sync)
 *
 * Identity: reg_no (plaintext VTOP register number). No maskUserID — the
 * user explicitly asked for reg_no, with an incomplete Amaze ID account
 * initialized from it that the student later claims.
 */
import { getDbPool } from "./db";
import { hashMark, identityHash } from "./generator";

const STUDENT_MARKS_TABLE = "student_marks";

export type StoredMarkRef = {
  regNo: string;
  classId: string;
  scope: "overall" | "assessment";
  assessmentKey: string;
  markHash: string;
  updatedAt: number;
};

/** Ensure the student_marks table exists. */
export async function ensureStudentMarksSchema(): Promise<void> {
  const pool = getDbPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${STUDENT_MARKS_TABLE} (
      reg_no         TEXT NOT NULL,
      class_id       TEXT NOT NULL,
      scope          TEXT NOT NULL,
      assessment_key TEXT NOT NULL,
      mark_hash      TEXT NOT NULL,
      updated_at     BIGINT NOT NULL,
      PRIMARY KEY (reg_no, class_id, scope, assessment_key)
    )
  `);
}

/**
 * Upsert a student's mark hash for one (class, scope, assessment).
 * Returns the previously stored hash (if any) so callers can detect changes.
 */
export async function upsertStudentMarkHash(
  regNo: string,
  classId: string,
  scope: "overall" | "assessment",
  assessmentKey: string,
  mark: number,
): Promise<string | null> {
  await ensureStudentMarksSchema();
  const pool = getDbPool();
  const cleanRegNo = regNo.trim().toUpperCase();
  const now = Date.now();
  const markHash = hashMark(mark);

  const existing = await getStudentMarkHash(
    cleanRegNo,
    classId,
    scope,
    assessmentKey,
  );

  await pool.query(
    `INSERT INTO ${STUDENT_MARKS_TABLE}
       (reg_no, class_id, scope, assessment_key, mark_hash, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (reg_no, class_id, scope, assessment_key)
     DO UPDATE SET
       mark_hash = EXCLUDED.mark_hash,
       updated_at = EXCLUDED.updated_at`,
    [cleanRegNo, classId, scope, assessmentKey, markHash, now],
  );

  return existing?.markHash ?? null;
}

/** Read a single stored mark hash. */
export async function getStudentMarkHash(
  regNo: string,
  classId: string,
  scope: "overall" | "assessment",
  assessmentKey: string,
): Promise<StoredMarkRef | null> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT reg_no, class_id, scope, assessment_key, mark_hash, updated_at
       FROM ${STUDENT_MARKS_TABLE}
      WHERE reg_no = $1 AND class_id = $2 AND scope = $3 AND assessment_key = $4`,
    [regNo.trim().toUpperCase(), classId, scope, assessmentKey],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    regNo: r.reg_no as string,
    classId: r.class_id as string,
    scope: r.scope as "overall" | "assessment",
    assessmentKey: r.assessment_key as string,
    markHash: r.mark_hash as string,
    updatedAt: Number(r.updated_at),
  };
}

/**
 * Read all stored mark hashes for one (class, scope, assessment_key).
 * Used by recount to iterate over every enrolled student.
 */
export async function getAllMarkHashesForAssessment(
  classId: string,
  scope: "overall" | "assessment",
  assessmentKey: string,
): Promise<StoredMarkRef[]> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT reg_no, class_id, scope, assessment_key, mark_hash, updated_at
       FROM ${STUDENT_MARKS_TABLE}
      WHERE class_id = $1 AND scope = $2 AND assessment_key = $3`,
    [classId, scope, assessmentKey],
  );
  return rows.map((r) => ({
    regNo: r.reg_no as string,
    classId: r.class_id as string,
    scope: r.scope as "overall" | "assessment",
    assessmentKey: r.assessment_key as string,
    markHash: r.mark_hash as string,
    updatedAt: Number(r.updated_at),
  }));
}

/**
 * Zero out (delete) all stored mark hashes for one (class, scope,
 * assessment_key). First step of a recount — clients re-submit fresh.
 */
export async function clearMarksForAssessment(
  classId: string,
  scope: "overall" | "assessment",
  assessmentKey: string,
): Promise<number> {
  await ensureStudentMarksSchema();
  const pool = getDbPool();
  const { rowCount } = await pool.query(
    `DELETE FROM ${STUDENT_MARKS_TABLE}
      WHERE class_id = $1 AND scope = $2 AND assessment_key = $3`,
    [classId, scope, assessmentKey],
  );
  return Number(rowCount ?? 0);
}

/** The student key used in class_user_marks (reg_no hash via generator). */
export function studentKey(regNo: string): string {
  return identityHash(regNo);
}

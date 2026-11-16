/**
 * One-time migration from the redundant plaintext-identity mark-hash table.
 *
 * `class_user_marks` is the sole contribution ledger: it stores only the
 * keyed student id and keyed mark hash, and supports both Welford updates and
 * the marks/tokens continuity endpoint. Older deployments also wrote the same
 * hashes to `student_marks` keyed by plaintext register number. Copy any rows
 * that are not already present, then remove that duplicate table.
 */
import { getDbPool } from "./db";
import { identityHash } from "./generator";

export function studentKey(regNo: string): string {
  return identityHash(regNo);
}

export async function migrateStudentMarksTable(): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", ["student_marks_to_class_user_marks"]);
    const exists = await client.query<{ table_name: string | null }>(
      "SELECT to_regclass('student_marks')::text AS table_name",
    );
    if (!exists.rows[0]?.table_name) {
      await client.query("COMMIT");
      return;
    }

    const { rows } = await client.query<{
      reg_no: string;
      class_id: string;
      scope: string;
      assessment_key: string;
      mark_hash: string;
      updated_at: number;
    }>(
      `SELECT reg_no, class_id, scope, assessment_key, mark_hash, updated_at
         FROM student_marks`,
    );

    // Preserve prior hashes in the non-plaintext ledger. Existing ledger
    // entries remain authoritative when the two historical copies disagree.
    for (const row of rows) {
      const userKey = studentKey(row.reg_no);
      await client.query(
        `INSERT INTO class_user_marks
           (class_id, user_key, scope, assessment_key, value_token, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (class_id, user_key, scope, assessment_key) DO NOTHING`,
        [row.class_id, userKey, row.scope, row.assessment_key, row.mark_hash, row.updated_at],
      );
    }

    await client.query("DROP TABLE student_marks");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.release();
  }
}

/**
 * Class-cohort marks statistics — mark-hash design.
 *
 * ========================================================================
 * THE MATH (exact lines, no hand-waving)
 * ========================================================================
 *
 * We store per-student per-assessment marks as KEYED HASHES, not plaintext.
 * The mark domain is 0-100 (101 integers). A plain hash of one mark would be
 * brute-forceable in microseconds. So we use HMAC-SHA256 keyed by the
 * manually-set GENERATOR_KEY env var:
 *
 *   mark_hash = HMAC_SHA256(GENERATOR_KEY, "mk::" + mark.toFixed(6))
 *
 * GENERATOR_KEY is set by you, never derived, never per-server. If you rotate
 * it, every stored hash becomes invalid — which is by design: it forces a
 * recount.
 *
 * -----------------------------------------------------------------------
 * Welford's online algorithm (per class per assessment)
 * -----------------------------------------------------------------------
 *
 * The accumulator holds {count, mean, m2} where m2 = sum of squared
 * deviations from the mean. Adding one observation x:
 *
 *   count_n      = count_{n-1} + 1
 *   delta        = x - mean_{n-1}
 *   mean_n       = mean_{n-1} + delta / count_n
 *   delta2       = x - mean_n
 *   m2_n         = m2_{n-1} + delta * delta2
 *
 * Removing one observation x (reverse Welford):
 *
 *   count_n      = count_{n-1} - 1
 *   delta        = x - mean_{n-1}
 *   mean_n       = mean_{n-1} - delta / count_n
 *   delta2       = x - mean_n
 *   m2_n         = m2_{n-1} - delta * delta2
 *
 *   (If count goes to 0 or 1, reset to {0, 0, 0}.)
 *
 * Derived statistics:
 *
 *   population_variance = m2 / count
 *   sample_variance     = m2 / (count - 1)     (count > 1)
 *   sd                  = sqrt(variance)
 *
 * -----------------------------------------------------------------------
 * Scaling
 * -----------------------------------------------------------------------
 *
 * VTOP returns marks already as percentages (0-100). We store them as-is.
 * If VTOP ever returns a weighted mark out of a different max, normalize
 * before storing:
 *
 *   scaled = (scoredMark / maxMark) * 100
 *
 * No additional scaling is applied. mean/sd are in the same 0-100 unit as
 * the marks themselves.
 *
 * -----------------------------------------------------------------------
 * Data ingestion
 * -----------------------------------------------------------------------
 *
 * Marks enter through POST /api/remote/attendance. When any user fetches
 * attendance, we also fetch their marks and record each assessment.
 *
 * The attendance handler calls recordContribution for every assessment the
 * student has, keyed by reg_no (from VTOP profile → student_profiles).
 *
 * -----------------------------------------------------------------------
 * What's wrong with both methods
 * -----------------------------------------------------------------------
 *
 * UniCC (AddClassData / MongoDB):
 *   • includesUsers[] prevents re-submission but CANNOT handle mark updates
 *     — if a student's mark changes, it is silently ignored (no remove step).
 *   • Grade ranges = mean ± k·SD assuming a normal distribution. Fails for
 *     small classes (n < 30) and bimodal/multimodal distributions.
 *    * No per-student storage → no recount possible.
 *   • Marks scraped on every attendance fetch — no caching, no change
 *     detection, no deduplication beyond the includesUsers check.
 *
 * Our current design (before this rewrite):
 *   • value_token = HMAC of a 0-100 mark — brute-forceable (101 elements)
 *     if GENERATOR_KEY leaks.
 *   • prevMark is client-supplied and unverifiable without storing the mark.
 *   • No automatic collection — requires explicit /sync call.
 *   • Used maskUserID (masked reg_no) instead of plaintext reg_no.
 *
 * This rewrite fixes: hash-based identity (GENERATOR_KEY), per-assessment
 * mark-hash storage, recount on mismatch, /attendance ingestion, reg_no
 * identity (no masking), client-side final calculation.
 * ========================================================================
 */

import type { DbClient } from "./db";
import { getDbPool } from "./db";
import { assessmentKey as genAssessmentKey, hashMark, identityHash } from "./generator";
import {
  clearMarksForAssessment,
  getAllMarkHashesForAssessment,
  getStudentMarkHash,
  ensureStudentMarksSchema,
  studentKey,
} from "./student-marks";

export type Scope = "overall" | "assessment";

/** The `assessment_key` reserved for the blended course total. */
export const OVERALL_KEY = "overall";

/** Bounds the per-assessment percentage the client may report. */
const MARK_MIN = 0;
const MARK_MAX = 100;

/* ── identity and key derivation ──────────────────────────────────────────── */

/**
 * The student's stable key, from VTOP's REGISTER NO.
 *
 * Plaintext reg_no (no masking). Stored in student_profiles; the student's
 * Amaze ID account starts incomplete and is claimed later. Uses identityHash
 * from the shared generator.
 */
export async function ownerKeyFor(regNumber: string): Promise<string> {
  return identityHash(regNumber);
}

/**
 * A cohort's assessment key. Deterministic via the shared generator.
 *
 * `component` is `theory` or `lab` and is part of the key because an embedded
 * course publishes two halves under one code, and they frequently carry
 * identically-named assessments. Without it both halves collapse into one
 * bucket and the reported mean is an average of two different populations.
 *
 * Normalised title keeps "CAT 1" and "CAT   1" identical.
 *
 * The opaque key is HMAC-derived with GENERATOR_KEY. Assessment metadata is
 * returned alongside the key so clients can join by component and title.
 */
export async function assessmentKeyFor(
  classId: string,
  component: string,
  title: string
): Promise<string> {
  return genAssessmentKey(classId, component, title);
}

/**
 * A keyed hash of a mark, standing in for the mark itself in class_user_marks.
 *
 * mark_hash = HMAC_SHA256(GENERATOR_KEY, "mk::" + mark.toFixed(6))
 *
 * toFixed(6) first, so 80, 80.0 and 8e1 all hash identically.
 */
export async function valueToken(mark: number): Promise<string> {
  return hashMark(mark);
}

/* ── schema ───────────────────────────────────────────────────────────────── */

let schemaEnsured: Promise<void> | null = null;

/**
 * Inline DDL (house style — no migrations directory).
 *
 * class_user_marks holds value_token (mark hash) per student per assessment.
 * student_marks holds the same hash (single source of truth for recount).
 */
export function ensureSchema(): Promise<void> {
  if (!schemaEnsured) {
    schemaEnsured = (async () => {
      const pool = getDbPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS class_overall_stats (
          class_id TEXT PRIMARY KEY,
          count    BIGINT NOT NULL,
          mean     DOUBLE PRECISION NOT NULL,
          m2       DOUBLE PRECISION NOT NULL
        );
        CREATE TABLE IF NOT EXISTS class_assessment_stats (
          class_id       TEXT NOT NULL,
          assessment_key TEXT NOT NULL,
          count          BIGINT NOT NULL,
          mean           DOUBLE PRECISION NOT NULL,
          m2             DOUBLE PRECISION NOT NULL,
          PRIMARY KEY (class_id, assessment_key)
        );
        CREATE TABLE IF NOT EXISTS class_assessment_metadata (
          class_id       TEXT NOT NULL,
          assessment_key TEXT NOT NULL,
          component      TEXT NOT NULL,
          title          TEXT NOT NULL,
          PRIMARY KEY (class_id, assessment_key)
        );
        CREATE TABLE IF NOT EXISTS class_user_marks (
          class_id       TEXT NOT NULL,
          user_key       TEXT NOT NULL,
          scope          TEXT NOT NULL,
          assessment_key TEXT NOT NULL,
          value_token    TEXT NOT NULL,
          updated_at     BIGINT NOT NULL,
          PRIMARY KEY (class_id, user_key, scope, assessment_key)
        );
      `);
      await ensureStudentMarksSchema();
    })().catch((err: unknown) => {
      schemaEnsured = null;
      throw err;
    });
  }
  return schemaEnsured;
}

/* ── Welford, with the negative-variance guard ────────────────────────────── */

type Acc = { count: number; mean: number; m2: number };

const ZERO: Acc = { count: 0, mean: 0, m2: 0 };

/**
 * Add one observation x to the accumulator.
 *
 * Exact lines:
 *
 *   count   = count + 1
 *   delta   = x - mean
 *   mean    = mean + delta / count
 *   delta2  = x - mean        (uses the NEW mean)
 *   m2      = m2 + delta * delta2
 */
function addTo(acc: Acc, x: number): Acc {
  const count = acc.count + 1;
  const delta = x - acc.mean;
  const mean = acc.mean + delta / count;
  const delta2 = x - mean;
  const m2 = Math.max(0, acc.m2 + delta * delta2);
  return { count, mean, m2 };
}

/**
 * Remove one observation x from the accumulator (reverse Welford).
 *
 * Exact lines:
 *
 *   count   = count - 1
 *   delta   = x - mean        (uses the OLD mean)
 *   mean    = mean - delta / count   (count is the NEW count after decrement)
 *   delta2  = x - mean        (uses the NEW mean)
 *   m2      = m2 - delta * delta2
 *
 * m2 is clamped at 0 because accumulated floating-point error can drive it
 * slightly negative over many add/remove cycles. An unclamped
 * sqrt(m2 / count) would then be NaN.
 */
function removeFrom(acc: Acc, x: number): Acc {
  if (acc.count <= 0) return ZERO;
  if (acc.count === 1) return ZERO; // removing the last observation → empty
  const count = acc.count - 1;
  const delta = x - acc.mean;
  const mean = acc.mean - delta / count;
  const delta2 = x - mean;
  const m2 = Math.max(0, acc.m2 - delta * delta2);
  return { count, mean, m2 };
}

/** Population standard deviation, guarded; the current published math divides by n. */
export function standardDeviation(acc: Acc): number {
  if (acc.count <= 1) return 0;
  return Math.sqrt(Math.max(0, acc.m2) / acc.count);
}

/* ── write path ───────────────────────────────────────────────────────────── */

export type ContributionOutcome =
  | "added"
  | "replaced"
  | "skipped"
  | "recounted"
  | "rejected";

export type Contribution = {
  classId: string;
  scope: Scope;
  title?: string;
  component?: string;
  mark: number;
  prevMark?: number | null;
  /** Current VTOP snapshot; unchanged values are skipped and changed values reset only their own scope before re-adding this snapshot. */
  serverObserved?: boolean;
};

export type ContributionResult = {
  outcome: ContributionOutcome;
  recountTriggered: boolean;
};

/**
 * Record one contribution, deciding add vs replace vs skip vs recount.
 *
 * Decision table (server's stored hash is the source of truth):
 *
 * | Stored hash | Client's prevMark hash matches? | Outcome |
 * |-------------|-----------------------------------|---------|
 * | none        | n/a                               | added   |
 * | present     | yes                               | replaced|
 * | present     | no (or no prevMark)               | recounted|
 *
 * For an authoritative VTOP snapshot, a changed hash resets only that scope
 * (one assessment or the course overall), then immediately adds the current
 * student's newly observed value. Other students repopulate it as they fetch
 * attendance again.
 *
 * Exact Welford lines used (see addTo / removeFrom above).
 */
export async function recordContribution(
  client: DbClient,
  regNo: string,
  ownerKey: string,
  c: Contribution,
  now: number,
): Promise<ContributionResult> {
  if (
    !c.classId ||
    typeof c.classId !== "string" ||
    !Number.isFinite(c.mark) ||
    c.mark < MARK_MIN ||
    c.mark > MARK_MAX
  ) {
    return { outcome: "rejected", recountTriggered: false };
  }

  const isOverall = c.scope === "overall";
  const component = c.component?.trim().toLowerCase() ?? "";
  const title = c.title?.trim().replace(/\s+/g, " ") ?? "";
  if (!isOverall && (!component || !title)) {
    return { outcome: "rejected", recountTriggered: false };
  }
  const assessmentKey = isOverall
    ? OVERALL_KEY
    : await genAssessmentKey(c.classId, component, title);

  if (c.serverObserved) {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
      [`${c.classId}::${c.scope}::${assessmentKey}`],
    );
  }

  if (!isOverall) {
    await client.query(
      `INSERT INTO class_assessment_metadata (class_id, assessment_key, component, title)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (class_id, assessment_key)
       DO UPDATE SET component = EXCLUDED.component, title = EXCLUDED.title`,
      [c.classId, assessmentKey, component, title],
    );
  }

  // ── STEP 1: Look up the stored hash for this student/assessment ──
  const { rows } = await client.query(
    `SELECT value_token FROM class_user_marks
      WHERE class_id = $1 AND user_key = $2 AND scope = $3 AND assessment_key = $4`,
    [c.classId, ownerKey, c.scope, assessmentKey],
  );
  const storedToken = rows[0]?.value_token as string | undefined;

  // ── STEP 2: Decide outcome ──
  let recountTriggered = false;
  if (storedToken) {
    if (c.serverObserved) {
      const currentHash = await valueToken(c.mark);
      if (currentHash === storedToken) {
        return { outcome: "skipped", recountTriggered: false };
      }
      await triggerRecount(client, c.classId, c.scope, assessmentKey);
      recountTriggered = true;
    } else {
      // We have a prior contribution. The client must prove they know the
      // previous mark by hashing it and matching our stored token.
      const prev = c.prevMark;
      if (prev == null || !Number.isFinite(prev)) {
        // No prevMark, or invalid — we can't safely remove the old mark.
        // Hash mismatch → recount.
        await triggerRecount(client, c.classId, c.scope, assessmentKey);
        return { outcome: "recounted", recountTriggered: true };
      }
      const prevHash = await valueToken(prev);
      if (prevHash !== storedToken) {
        // The client's claimed prevMark doesn't match what we stored.
        // Either the key rotated, the data is corrupt, or the client is
        // submitting a forged prevMark. Recount to be safe.
        await triggerRecount(client, c.classId, c.scope, assessmentKey);
        return { outcome: "recounted", recountTriggered: true };
      }
      // Hash matches → safe to remove the old mark, then add the new one.
      await removeFromAccumulator(client, c.classId, c.scope, assessmentKey, prev);
    }
  }
  // No stored token, or an authoritative snapshot after recount → add.

  // ── STEP 3: Update the Welford accumulator ──
  const table = isOverall ? "class_overall_stats" : "class_assessment_stats";
  const keyCols = isOverall ? "class_id" : "class_id, assessment_key";
  const whereClause = isOverall ? "class_id = $1" : "class_id = $1 AND assessment_key = $2";
  const insertCols = isOverall ? "$1" : "$1, $2";
  const keyValues = isOverall ? [c.classId] : [c.classId, assessmentKey];

  const cur = await client.query(
    `SELECT count, mean, m2 FROM ${table} WHERE ${whereClause}`,
    keyValues,
  );
  let acc: Acc = cur.rows.length
    ? {
        count: Number(cur.rows[0].count),
        mean: Number(cur.rows[0].mean),
        m2: Number(cur.rows[0].m2),
      }
    : ZERO;

  // If we removed a prevMark above, acc already reflects the removal.
  // Otherwise acc is the raw current state. Add the new mark:
  acc = addTo(acc, c.mark);

  await client.query(
    `INSERT INTO ${table} (${keyCols}, count, mean, m2)
     VALUES (${insertCols}, $${keyValues.length + 1}, $${keyValues.length + 2}, $${keyValues.length + 3})
     ON CONFLICT (${keyCols})
     DO UPDATE SET count = EXCLUDED.count, mean = EXCLUDED.mean, m2 = EXCLUDED.m2`,
    [...keyValues, acc.count, acc.mean, acc.m2],
  );

  // ── STEP 4: Store the new hash ──
  const newToken = await valueToken(c.mark);
  await client.query(
    `INSERT INTO class_user_marks (class_id, user_key, scope, assessment_key, value_token, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (class_id, user_key, scope, assessment_key)
     DO UPDATE SET value_token = EXCLUDED.value_token, updated_at = EXCLUDED.updated_at`,
    [c.classId, ownerKey, c.scope, assessmentKey, newToken, now],
  );

  // ── STEP 5: Store the hash in student_marks (single source of truth) ──
  await client.query(
    `INSERT INTO student_marks (reg_no, class_id, scope, assessment_key, mark_hash, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (reg_no, class_id, scope, assessment_key)
     DO UPDATE SET mark_hash = EXCLUDED.mark_hash, updated_at = EXCLUDED.updated_at`,
    [regNo.trim().toUpperCase(), c.classId, c.scope, assessmentKey, newToken, now],
  );

  return {
    outcome: recountTriggered ? "recounted" : storedToken ? "replaced" : "added",
    recountTriggered,
  };
}

/**
 * Remove a mark from the Welford accumulator. Used when replacing a
 * student's contribution (prevMark verified by hash match).
 */
async function removeFromAccumulator(
  client: DbClient,
  classId: string,
  scope: Scope,
  assessmentKey: string,
  prevMark: number,
): Promise<void> {
  const table = scope === "overall" ? "class_overall_stats" : "class_assessment_stats";
  const keyCols = scope === "overall" ? "class_id" : "class_id, assessment_key";
  const whereClause = scope === "overall" ? "class_id = $1" : "class_id = $1 AND assessment_key = $2";
  const keyValues = scope === "overall" ? [classId] : [classId, assessmentKey];

  const cur = await client.query(
    `SELECT count, mean, m2 FROM ${table} WHERE ${whereClause}`,
    keyValues,
  );
  if (!cur.rows.length) return; // nothing to remove

  let acc: Acc = {
    count: Number(cur.rows[0].count),
    mean: Number(cur.rows[0].mean),
    m2: Number(cur.rows[0].m2),
  };
  acc = removeFrom(acc, prevMark);

  await client.query(
    `INSERT INTO ${table} (${keyCols}, count, mean, m2)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (${keyCols})
     DO UPDATE SET count = EXCLUDED.count, mean = EXCLUDED.mean, m2 = EXCLUDED.m2`,
    [...keyValues, acc.count, acc.mean, acc.m2],
  );
}

/**
 * Recount trigger: clear every stored contribution for this scope and reset
 * its accumulator. The current VTOP snapshot is then added by the caller;
 * other students repopulate the cohort as they fetch attendance again.
 *
 * Called when a stored hash differs from the newly observed mark.
 */
async function triggerRecount(
  client: DbClient,
  classId: string,
  scope: Scope,
  assessmentKey: string,
): Promise<void> {
  // 1. Delete all student hashes for this assessment
  await clearMarksForAssessment(classId, scope, assessmentKey, client);

  // 2. Delete all class_user_marks rows for this assessment
  await client.query(
    `DELETE FROM class_user_marks
      WHERE class_id = $1 AND scope = $2 AND assessment_key = $3`,
    [classId, scope, assessmentKey],
  );

  // 3. Reset the accumulator
  const table = scope === "overall" ? "class_overall_stats" : "class_assessment_stats";
  const keyCols = scope === "overall" ? "class_id" : "class_id, assessment_key";
  const keyValues = scope === "overall" ? [classId] : [classId, assessmentKey];

  await client.query(
    `INSERT INTO ${table} (${keyCols}, count, mean, m2)
     VALUES ($1, 0, 0, 0)
     ON CONFLICT (${keyCols})
     DO UPDATE SET count = 0, mean = 0, m2 = 0`,
    keyValues,
  );
}

/**
 * Full recount endpoint helper. Deletes all marks for an assessment and
 * resets the accumulator. Returns the number of student rows zeroed.
 */
export async function recountAssessment(
  classId: string,
  scope: Scope,
  assessmentKey: string,
): Promise<{ zeroed: number }> {
  await ensureSchema();
  const pool = getDbPool();

  // Zero student_marks
  const zeroed = await clearMarksForAssessment(classId, scope, assessmentKey);

  // Zero class_user_marks
  await pool.query(
    `DELETE FROM class_user_marks
      WHERE class_id = $1 AND scope = $2 AND assessment_key = $3`,
    [classId, scope, assessmentKey],
  );

  // Reset accumulator
  const table = scope === "overall" ? "class_overall_stats" : "class_assessment_stats";
  const keyCols = scope === "overall" ? "class_id" : "class_id, assessment_key";
  const keyValues = scope === "overall" ? [classId] : [classId, assessmentKey];

  await pool.query(
    `INSERT INTO ${table} (${keyCols}, count, mean, m2)
     VALUES ($1, 0, 0, 0)
     ON CONFLICT (${keyCols})
     DO UPDATE SET count = 0, mean = 0, m2 = 0`,
    keyValues,
  );

  return { zeroed };
}

/* ── read path ────────────────────────────────────────────────────────────── */

export type AssessmentStats = {
  count: number;
  mean: number;
  sd: number;
  component?: string;
  title?: string;
};

export type ClassStats = {
  count: number;
  mean: number;
  sd: number;
  assessments: Record<string, AssessmentStats>;
};

export async function statsForClasses(
  classIds: string[]
): Promise<Record<string, ClassStats>> {
  if (classIds.length === 0) return {};

  const pool = getDbPool();
  const unique = Array.from(new Set(classIds));

  const [overallRes, assessmentRes] = await Promise.all([
    pool.query(
      `SELECT class_id, count, mean, m2 FROM class_overall_stats WHERE class_id = ANY($1)`,
      [unique],
    ),
    pool.query(
      `SELECT stats.class_id, stats.assessment_key, stats.count, stats.mean, stats.m2,
              metadata.component, metadata.title
         FROM class_assessment_stats AS stats
         LEFT JOIN class_assessment_metadata AS metadata
           USING (class_id, assessment_key)
        WHERE stats.class_id = ANY($1)`,
      [unique],
    ),
  ]);

  const out: Record<string, ClassStats> = {};
  for (const id of unique) {
    out[id] = { count: 0, mean: 0, sd: 0, assessments: {} };
  }

  for (const row of overallRes.rows as Array<Record<string, unknown>>) {
    const acc = toAcc(row);
    const id = row.class_id as string;
    out[id] = {
      count: acc.count,
      mean: acc.mean,
      sd: standardDeviation(acc),
      assessments: out[id].assessments,
    };
  }

  for (const row of assessmentRes.rows as Array<Record<string, unknown>>) {
    const entry = out[row.class_id as string];
    if (!entry) continue;
    const acc = toAcc(row);
    entry.assessments[row.assessment_key as string] = {
      count: acc.count,
      mean: acc.mean,
      sd: standardDeviation(acc),
      ...(typeof row.component === "string" ? { component: row.component } : {}),
      ...(typeof row.title === "string" ? { title: row.title } : {}),
    };
  }

  return out;
}

function toAcc(row: Record<string, unknown>): Acc {
  return {
    count: Number(row.count),
    mean: Number(row.mean),
    m2: Number(row.m2),
  };
}

/**
 * Every mark hash the server currently holds for this student.
 * Presence and continuity only — never values. Used by the client to
 * verify its local prevMark cache matches server state.
 */
export type TokenRecord = {
  classId: string;
  scope: Scope;
  assessmentKey: string;
  token: string;
  updatedAt: number;
};

export async function tokensForOwner(
  ownerKey: string,
): Promise<TokenRecord[]> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT class_id, scope, assessment_key, value_token, updated_at
       FROM class_user_marks
      WHERE user_key = $1
      ORDER BY class_id, scope, assessment_key`,
    [ownerKey],
  );
  return rows.map(
    (r: {
      class_id: string;
      scope: Scope;
      assessment_key: string;
      value_token: string;
      updated_at: number;
    }) => ({
      classId: r.class_id,
      scope: r.scope,
      assessmentKey: r.assessment_key,
      token: r.value_token,
      updatedAt: Number(r.updated_at),
    }),
  );
}

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
 *   • No automatic collection — requires explicit client contribution sync.
 *   • Used maskUserID (masked reg_no) instead of plaintext reg_no.
 *
 * This rewrite fixes: hash-based identity (GENERATOR_KEY), per-assessment
 * mark-hash storage, recount on mismatch, /attendance ingestion, reg_no
 * identity (no masking), client-side final calculation.
 * ========================================================================
 */

import { getWorkerEnv } from "../env";
import { assessmentKey as genAssessmentKey, hashMark, identityHash } from "./generator";

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

/** Store the authenticated register number beside any existing keyed mark rows. */
export async function setStudentRegisterNumberD1(ownerKey: string, regNo: string): Promise<void> {
  const db = getWorkerEnv().APP_DB;
  if (!db) throw new Error("APP_DB is not configured");
  const normalized = regNo.trim().toUpperCase();
  if (!normalized) return;
  await db.prepare(`UPDATE class_user_marks SET reg_no = ?
    WHERE user_key = ? AND (reg_no IS NULL OR reg_no = ?)`)
    .bind(normalized, ownerKey, normalized).run();
}

/* ── schema ───────────────────────────────────────────────────────────────── */

let schemaEnsured: Promise<void> | null = null;

async function requireMarksDb(): Promise<D1Database> {
  const db = getWorkerEnv().APP_DB;
  if (!db) throw new Error("APP_DB is not configured");
  return db;
}

/** Require the service-data D1 binding; migrations own the marks schema. */
export function ensureSchema(): Promise<void> {
  if (!schemaEnsured) {
    schemaEnsured = requireMarksDb().then(() => undefined).catch((error) => {
      schemaEnsured = null;
      throw error;
    });
  }
  return schemaEnsured;
}

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
  /** Plain register number observed from the authenticated VTOP session. */
  regNo?: string;
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
/** Atomic, idempotent VTOP snapshot ingestion using a single D1 batch. */
export async function recordObservedContributionD1(
  ownerKey: string,
  regNo: string,
  c: Contribution,
  now: number,
): Promise<ContributionResult> {
  const db = getWorkerEnv().APP_DB;
  if (!db) throw new Error("APP_DB is not configured");
  if (!c.classId || typeof c.classId !== "string" || !Number.isFinite(c.mark)
      || c.mark < MARK_MIN || c.mark > MARK_MAX) {
    return { outcome: "rejected", recountTriggered: false };
  }
  const isOverall = c.scope === "overall";
  const component = c.component?.trim().toLowerCase() ?? "";
  const title = c.title?.trim().replace(/\s+/g, " ") ?? "";
  if (!isOverall && (!component || !title)) return { outcome: "rejected", recountTriggered: false };
  const assessmentKey = isOverall ? OVERALL_KEY : await genAssessmentKey(c.classId, component, title);
  const table = isOverall ? "class_overall_stats" : "class_assessment_stats";
  const keys = isOverall ? [c.classId] : [c.classId, assessmentKey];
  const where = isOverall ? "class_id = ?" : "class_id = ? AND assessment_key = ?";
  const token = await valueToken(c.mark);
  const statements: D1PreparedStatement[] = [];
  if (!isOverall) {
    statements.push(db.prepare(`INSERT INTO class_assessment_metadata (class_id, assessment_key, component, title)
      VALUES (?, ?, ?, ?) ON CONFLICT (class_id, assessment_key)
      DO UPDATE SET component = excluded.component, title = excluded.title`)
      .bind(c.classId, assessmentKey, component, title));
  }
  statements.push(db.prepare(`DELETE FROM class_user_marks
    WHERE class_id = ? AND scope = ? AND assessment_key = ?
      AND EXISTS (SELECT 1 FROM class_user_marks mine
        WHERE mine.class_id = ? AND mine.user_key = ? AND mine.scope = ?
          AND mine.assessment_key = ? AND mine.value_token <> ?)`)
    .bind(c.classId, c.scope, assessmentKey, c.classId, ownerKey, c.scope, assessmentKey, token));
  statements.push(db.prepare(`UPDATE ${table} SET count = 0, mean = 0, m2 = 0 WHERE ${where} AND changes() = 1`)
    .bind(...keys));
  statements.push(db.prepare(`INSERT OR IGNORE INTO class_user_marks
    (class_id, user_key, scope, assessment_key, value_token, updated_at, reg_no) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(c.classId, ownerKey, c.scope, assessmentKey, token, now, regNo.trim().toUpperCase()));
  const statColumns = isOverall ? "class_id, count, mean, m2" : "class_id, assessment_key, count, mean, m2";
  const statValues = isOverall ? "?, 1, ?, 0" : "?, ?, 1, ?, 0";
  const conflictKeys = isOverall ? "class_id" : "class_id, assessment_key";
  statements.push(db.prepare(`INSERT INTO ${table} (${statColumns})
      SELECT ${statValues} WHERE changes() = 1
    ON CONFLICT (${conflictKeys}) DO UPDATE SET
      count = ${table}.count + 1,
      mean = ${table}.mean + (? - ${table}.mean) / (${table}.count + 1),
      m2 = ${table}.m2 + (? - ${table}.mean) * (? - (${table}.mean + (? - ${table}.mean) / (${table}.count + 1)))`)
    .bind(...(isOverall ? [c.classId, c.mark] : [c.classId, assessmentKey, c.mark]),
      c.mark, c.mark, c.mark, c.mark));

  const results = await db.batch(statements);
  const deleteIndex = isOverall ? 0 : 1;
  const insertIndex = deleteIndex + 2;
  const deleted = Number(results[deleteIndex]?.meta.changes ?? 0) > 0;
  const inserted = Number(results[insertIndex]?.meta.changes ?? 0) > 0;
  return {
    outcome: deleted ? "recounted" : inserted ? "added" : "skipped",
    recountTriggered: deleted,
  };
}

/**
 * Remove a mark from the Welford accumulator. Used when replacing a
 * student's contribution (prevMark verified by hash match).
 */
/** Clear contribution hashes and reset one Welford accumulator in one D1 batch. */
export async function recountAssessment(
  classId: string,
  scope: Scope,
  assessmentKey: string,
): Promise<{ zeroed: number }> {
  await ensureSchema();
  const db = await requireMarksDb();
  const table = scope === "overall" ? "class_overall_stats" : "class_assessment_stats";
  const columns = scope === "overall" ? "class_id, count, mean, m2" : "class_id, assessment_key, count, mean, m2";
  const values = scope === "overall" ? "?, 0, 0, 0" : "?, ?, 0, 0, 0";
  const keys = scope === "overall" ? [classId] : [classId, assessmentKey];
  const results = await db.batch([
    db.prepare(`DELETE FROM class_user_marks WHERE class_id = ? AND scope = ? AND assessment_key = ?`)
      .bind(classId, scope, assessmentKey),
    db.prepare(`INSERT INTO ${table} (${columns}) VALUES (${values})
      ON CONFLICT (${scope === "overall" ? "class_id" : "class_id, assessment_key"})
      DO UPDATE SET count = 0, mean = 0, m2 = 0`).bind(...keys),
  ]);
  return { zeroed: Number(results[0]?.meta.changes ?? 0) };
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

export async function statsForClasses(classIds: string[]): Promise<Record<string, ClassStats>> {
  if (classIds.length === 0) return {};
  await ensureSchema();
  const db = await requireMarksDb();
  const unique = Array.from(new Set(classIds));
  const placeholders = unique.map(() => "?").join(", ");
  const [overall, assessments] = await Promise.all([
    db.prepare(`SELECT class_id, count, mean, m2 FROM class_overall_stats
      WHERE class_id IN (${placeholders})`).bind(...unique).all<Record<string, unknown>>(),
    db.prepare(`SELECT stats.class_id, stats.assessment_key, stats.count, stats.mean, stats.m2,
          metadata.component, metadata.title FROM class_assessment_stats AS stats
        LEFT JOIN class_assessment_metadata AS metadata USING (class_id, assessment_key)
        WHERE stats.class_id IN (${placeholders})`).bind(...unique).all<Record<string, unknown>>(),
  ]);
  const out: Record<string, ClassStats> = {};
  for (const id of unique) out[id] = { count: 0, mean: 0, sd: 0, assessments: {} };
  for (const row of overall.results) {
    const acc = toAcc(row);
    const id = row.class_id as string;
    out[id] = { count: acc.count, mean: acc.mean, sd: standardDeviation(acc), assessments: out[id].assessments };
  }
  for (const row of assessments.results) {
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

export async function tokensForOwner(ownerKey: string): Promise<TokenRecord[]> {
  const db = await requireMarksDb();
  const { results } = await db.prepare(`SELECT class_id, scope, assessment_key, value_token, updated_at
    FROM class_user_marks WHERE user_key = ? ORDER BY class_id, scope, assessment_key`)
    .bind(ownerKey).all<{ class_id: string; scope: Scope; assessment_key: string; value_token: string; updated_at: number }>();
  return results.map((row) => ({
    classId: row.class_id,
    scope: row.scope,
    assessmentKey: row.assessment_key,
    token: row.value_token,
    updatedAt: Number(row.updated_at),
  }));
}

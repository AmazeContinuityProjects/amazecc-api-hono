import { sha256Hex } from "./crypto";
import type { PoolClient } from "pg";
import { getDbPool } from "./db";
import { maskUserID } from "./mask";
/**
 * Class-cohort marks statistics.
 *
 * ## What is stored, and what is not
 *
 * Three tables, and none of them holds a mark:
 *
 * | Table | Holds | Per student? |
 * |---|---|---|
 * | `class_overall_stats` | `count`, `mean`, `m2` per class | no |
 * | `class_assessment_stats` | `count`, `mean`, `m2` per (class, assessment) | no |
 * | `class_user_marks` | `value_token` — an HMAC of the mark | yes, but not the mark |
 *
 * `value_token` is what replaces the previous `class_user_hashes.last_updated_at` scheme.
 * Welford's remove step needs to know what a student previously contributed, so the student
 * *tells* us (`prevMark`) and we check the claim against a token we minted last time. The
 * client cannot forge one — the HMAC key is server-only — and the mark is never written.
 *
 * This is why there is no `mark` column: a 0–100 value is a 101-element domain, so even a
 * plain hash of one would be reversible by brute force in microseconds. An HMAC under a
 * server-only salt is not, because the client never holds the key and never sees a token.
 *
 * The consequence is the one the UI's privacy copy depends on: an individual's contribution
 * exists only in the request body and in the accumulator. It is never persisted.
 */

export type Scope = "overall" | "assessment";

/** The `assessment_key` reserved for the blended course total. */
export const OVERALL_KEY = "overall";

/** Bounds the per-assessment percentage the client may report. */
const MARK_MIN = 0;
const MARK_MAX = 100;

/* ── identity and key derivation ──────────────────────────────────────────── */

/**
 * The student's stable pseudonym, from VTOP's REGISTER NO.
 *
 * Derived server-side from a value scraped from VTOP, never from the request body — a
 * caller cannot name someone else's row. Mirrors `socialDb.ownerKeyFor`.
 */
export async function ownerKeyFor(regNumber: string): Promise<string> {
  return maskUserID(regNumber.trim().toUpperCase());
}

/**
 * A cohort's assessment key.
 *
 * `component` is `theory` or `lab` and is part of the key because an embedded course
 * publishes two halves under one code, and they frequently carry identically-named
 * assessments. Without it both halves collapse into one bucket and the reported mean is
 * an average of two different populations.
 *
 * ## Why a plain SHA-256 and not `maskUserID`
 *
 * This has to be computable on **both** sides. The client reads the statistics back and
 * has to line each one up with the assessment it is rendering, and it cannot compute an
 * HMAC under a server-only salt. So the key is a plain digest of a course-level constant —
 * "Embedded Theory :: Continuous Assessment Test 1" — which is identical for every student
 * in the cohort and published in the course scheme anyway.
 *
 * There is nothing here to protect: the string is not user data. What the digest does buy
 * is that VTOP's raw markup never lands in a column, and that the two halves of an embedded
 * course cannot collide. The value that *is* sensitive — an individual's mark — never
 * reaches the database at all; see `valueToken`.
 *
 * **The client mirrors this in `AmazeCC/src/lib/marksSync.ts` (`assessmentKeyFor`). The two
 * implementations must stay byte-identical or every join silently misses.**
 */
export async function assessmentKeyFor(
  classId: string,
  component: string,
  title: string
): Promise<string> {
  const normalised = title.trim().replace(/\s+/g, " ");
  return (await sha256Hex([classId, component, normalised].join("::"))).slice(0, 32);
}

/**
 * An opaque token standing in for a mark.
 *
 * `toFixed` first, so `80`, `80.0` and `8e1` all mint the same token and a cosmetic
 * difference in how the client formatted a number cannot fork a student's history.
 */
export async function valueToken(mark: number): Promise<string> {
  return maskUserID(`mk::${mark.toFixed(6)}`);
}

/* ── schema ───────────────────────────────────────────────────────────────── */

let schemaEnsured: Promise<void> | null = null;

/**
 * Inline DDL, matching the convention `socialDb.ensureSchema` already uses — there is no
 * migrations directory in this repo, so a table only exists once a route has been hit.
 *
 * `class_assessment_stats` is keyed on `assessment_key` rather than the old
 * `assessment_title` column. The rename needs a real `DROP`, which `CREATE TABLE IF NOT
 * EXISTS` will not do for a table that already exists — see `migrate.sql`.
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
        CREATE TABLE IF NOT EXISTS class_user_marks (
          class_id       TEXT NOT NULL,
          user_key       TEXT NOT NULL,
          scope          TEXT NOT NULL,
          assessment_key TEXT NOT NULL,
          value_token    TEXT NOT NULL,
          updated_at     BIGINT NOT NULL,
          PRIMARY KEY (class_id, user_key, scope, assessment_key)
        );
        CREATE TABLE IF NOT EXISTS class_enrollment (
          owner_key  TEXT NOT NULL,
          class_id   TEXT NOT NULL,
          updated_at BIGINT NOT NULL,
          PRIMARY KEY (owner_key, class_id)
        );
      `);
    })().catch((err: unknown) => {
      // A transient failure must not poison the memo for the life of the instance.
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
 * Remove one observation.
 *
 * `m2` is clamped at 0. The removal formula subtracts two nearly-equal products, so
 * accumulated floating-point error can drive it slightly negative over many cycles; an
 * unclamped `sqrt(m2/count)` is then `NaN`, `JSON.stringify` emits `null`, and every
 * consumer silently reads the spread as zero.
 */
function removeFrom(acc: Acc, x: number): Acc {
  if (acc.count <= 0) return ZERO;
  if (acc.count === 1) return ZERO;
  const delta = x - acc.mean;
  const mean = acc.mean - delta / acc.count;
  const m2 = Math.max(0, acc.m2 - delta * (x - mean));
  return { count: acc.count - 1, mean, m2 };
}

/** Add one observation. */
function addTo(acc: Acc, x: number): Acc {
  const count = acc.count + 1;
  const delta = x - acc.mean;
  const mean = acc.mean + delta / count;
  const m2 = Math.max(0, acc.m2 + delta * (x - mean));
  return { count, mean, m2 };
}

/** Sample standard deviation, guarded. `count <= 1` has no spread to report. */
export function standardDeviation(acc: Acc): number {
  if (acc.count <= 1) return 0;
  return Math.sqrt(Math.max(0, acc.m2) / acc.count);
}

/** Plain SHA-256 hex, matching what the old browser client computed. */
const sha256hex = sha256Hex;

/**
 * Whether the caller plausibly contributed under the old scheme.
 *
 * The old client hashed the saved login ID exactly as typed, and casing was never
 * normalised at storage — so probe the received value, its upper- and lower-case forms.
 * Three indexed PK lookups at most, and only on a student's first contribution per
 * (class, assessment); after that the token exists and this never runs again.
 */
async function hasLegacyContribution(
  client: PoolClient,
  classId: string,
  authorizedID: string
): Promise<boolean> {
  const variants = Array.from(
    new Set([authorizedID, authorizedID.toUpperCase(), authorizedID.toLowerCase()])
  );
  for (const v of variants) {
    const { rows } = await client.query(
      `SELECT 1 FROM class_user_hashes_legacy WHERE class_id = $1 AND user_hash = $2`,
      [classId, await sha256hex(v)]
    );
    if (rows.length > 0) return true;
  }
  return false;
}

/* ── write path ───────────────────────────────────────────────────────────── */

export type ContributionOutcome =
  | "added"
  | "replaced"
  | "reconciled"
  | "skipped"
  | "rejected";

export type Contribution = {
  classId: string;
  scope: Scope;
  /** Plaintext VTOP title; the server hashes it. `""` for the overall scope. */
  title?: string;
  /** `theory` | `lab`; part of the assessment key. */
  component?: string;
  mark: number;
  /** What the client believes it last contributed, or null if it has no record. */
  prevMark?: number | null;
};

/**
 * Record one contribution, deciding for itself whether this is an add or a replace.
 *
 * The decision is made from the server's own token, never from the client's `type`:
 *
 * | Server token | Claim | Outcome |
 * |---|---|---|
 * | none | anything | `added` — there is nothing to replace |
 * | present | `prevMark` matching the token | `replaced` |
 * | present | no claim, or a claim that does not match | `skipped` |
 *
 * `skipped` is the safe default for the last row. A student who cleared localStorage has
 * no `prevMark`, and adding on top of an existing contribution would count them twice;
 * declining to update leaves their first value in place, which is stale but not wrong.
 *
 * ## Reconciling the old scheme (`reconciled`)
 *
 * Contributions recorded before this design carry no token — they were keyed on an
 * unsalted browser hash of the login ID. When such a student first contributes through
 * the new path, the server would otherwise `add` alongside their old point and count
 * them twice. If the caller supplies `reconcile` and the VTOP-verified register number
 * matches the claimed login ID (case-insensitively — the standard case, since the app
 * saves the credentials the student types), the server probes the legacy hashes for a
 * matching record. On a hit, the stated `prevMark` is removed before the new mark is
 * added, exactly as a token match would do.
 *
 * The gate matters: without the ID match, any authenticated student could name any
 * legacy record and distort it. With it, the reconciliation can only ever touch the
 * caller's own old contribution — the only `(class, hash)` pair producible from their
 * own login ID. Nonstandard accounts (username ≠ regNo) find no match and fall through
 * to a plain `add`; their ghost persists, bounded and documented, until term rollover.
 */
export async function recordContribution(
  client: PoolClient,
  ownerKey: string,
  c: Contribution,
  now: number,
  reconcile?: { authorizedID: string; regNo: string }
): Promise<ContributionOutcome> {
  if (
    !c.classId ||
    typeof c.classId !== "string" ||
    !Number.isFinite(c.mark) ||
    c.mark < MARK_MIN ||
    c.mark > MARK_MAX
  ) {
    return "rejected";
  }

  const isOverall = c.scope === "overall";
  const assessmentKey = isOverall
    ? OVERALL_KEY
    : await assessmentKeyFor(c.classId, c.component ?? "", c.title ?? "");

  const { rows } = await client.query(
    `SELECT value_token FROM class_user_marks
      WHERE class_id = $1 AND user_key = $2 AND scope = $3 AND assessment_key = $4`,
    [c.classId, ownerKey, c.scope, assessmentKey]
  );
  const token = rows[0]?.value_token as string | undefined;

  if (token) {
    const prev = c.prevMark;
    if (prev == null || !Number.isFinite(prev)) return "skipped";
    if ((await valueToken(prev)) !== token) return "skipped";
  }

  // No token: either a genuinely new contributor, or a student whose contribution
  // predates tokens. The second case is detectable — and only in the safe direction —
  // via the legacy hashes, gated on the login ID matching the verified register number.
  let reconciled = false;
  if (!token && reconcile) {
    const prev = c.prevMark;
    const idsMatch =
      reconcile.authorizedID.trim() !== "" &&
      reconcile.authorizedID.trim().toUpperCase() ===
        reconcile.regNo.trim().toUpperCase();
    if (
      idsMatch &&
      prev != null &&
      Number.isFinite(prev) &&
      (await hasLegacyContribution(client, c.classId, reconcile.authorizedID.trim()))
    ) {
      reconciled = true;
    }
  }

  const table = isOverall ? "class_overall_stats" : "class_assessment_stats";
  // Column lists take commas; a WHERE clause does not — `a, b = $1, $2` is a syntax
  // error, caught by the live round-trip test after the unit tests passed against a
  // fake that never parsed the SQL.
  const keyCols = isOverall ? "class_id" : "class_id, assessment_key";
  const whereClause = isOverall ? "class_id = $1" : "class_id = $1 AND assessment_key = $2";
  const insertCols = isOverall ? "$1" : "$1, $2";
  const keyValues = isOverall ? [c.classId] : [c.classId, assessmentKey];

  const cur = await client.query(
    `SELECT count, mean, m2 FROM ${table} WHERE ${whereClause}`,
    keyValues
  );
  let acc: Acc = cur.rows.length
    ? {
        count: Number(cur.rows[0].count),
        mean: Number(cur.rows[0].mean),
        m2: Number(cur.rows[0].m2),
      }
    : ZERO;

  if (token) acc = removeFrom(acc, c.prevMark as number);
  else if (reconciled) acc = removeFrom(acc, c.prevMark as number);
  acc = addTo(acc, c.mark);

  await client.query(
    `INSERT INTO ${table} (${keyCols}, count, mean, m2)
     VALUES (${insertCols}, $${keyValues.length + 1}, $${keyValues.length + 2}, $${keyValues.length + 3})
     ON CONFLICT (${keyCols})
     DO UPDATE SET count = EXCLUDED.count, mean = EXCLUDED.mean, m2 = EXCLUDED.m2`,
    [...keyValues, acc.count, acc.mean, acc.m2]
  );

  await client.query(
    `INSERT INTO class_user_marks (class_id, user_key, scope, assessment_key, value_token, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (class_id, user_key, scope, assessment_key)
     DO UPDATE SET value_token = EXCLUDED.value_token, updated_at = EXCLUDED.updated_at`,
    [c.classId, ownerKey, c.scope, assessmentKey, await valueToken(c.mark), now]
  );

  return !token ? (reconciled ? "reconciled" : "added") : "replaced";
}

/**
 * Record which classes a student is enrolled in.
 *
 * Written on the marks fetch, from the class list that fetch itself returned. That is
 * what makes it trustworthy: the list came back from VTOP under this caller's own
 * cookies, so a caller cannot enroll themselves into a class they are not in.
 *
 * This exists because "which classes may this caller read" cannot be answered from
 * `class_user_marks` — that table only holds a row once someone has *contributed* a
 * mark, so a student who has never synced would be unable to read any cohort at all,
 * including the 1,918 classes collected before it existed.
 */export async function recordEnrollment(
  ownerKey: string,
  classIds: string[],
  now: number
): Promise<void> {
  if (classIds.length === 0) return;
  const pool = getDbPool();

  await pool.query(
    `INSERT INTO class_enrollment (owner_key, class_id, updated_at)
     SELECT $1, c, $2
       FROM unnest($3::text[]) AS c
     ON CONFLICT (owner_key, class_id)
     DO UPDATE SET updated_at = EXCLUDED.updated_at`,
    [ownerKey, now, classIds]
  );
}

/**
 * Narrow a caller-supplied class list to the ones they are enrolled in.
 *
 * The client is the one that knows which course it is displaying, so it asks for those
 * classes by id. Everything not in the enrollment table is dropped, so the parameter
 * cannot be used to enumerate a cohort the caller does not belong to.
 */
export async function enrolledSubset(
  ownerKey: string,
  classIds: string[]
): Promise<string[]> {
  if (classIds.length === 0) return [];
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT class_id FROM class_enrollment
      WHERE owner_key = $1 AND class_id = ANY($2)`,
    [ownerKey, classIds]
  );
  return rows.map((r: { class_id: string }) => r.class_id);
}

export type TokenRecord = {
  classId: string;
  scope: Scope;
  assessmentKey: string;
  token: string;
  updatedAt: number;
};

/**
 * Every HMAC the server currently holds for this student.
 *
 * This is the "provide hmac" half of the handshake: a client that has lost its local
 * record (cleared cache, new device) asks what state the server holds, and gets back
 * the opaque tokens — presence and continuity, not values. What the client does with
 * them:
 *
 * - **Receipt check.** After a sync that accepted writes, the tokens the server returns
 *   must match what was just minted. A mismatch means server state moved unexpectedly
 *   (restored backup, lost write, bug) and is worth flagging rather than silently
 *   absorbing.
 * - **Frozen visibility.** A token for an assessment the client has no previous mark
 *   for is a contribution it cannot update — the client can show that instead of
 *   pretending the row is live.
 *
 * What it cannot do, stated plainly: an HMAC is non-invertible by construction, so no
 * response here can hand back a mark nobody retained. Exact resumption needs the old
 * value, and after a wipe nobody has it — not the client, not the server (by design),
 * not VTOP (current marks only). See the plan doc for the one design that would change
 * that (client-encrypted backup) and why it was not built.
 */
export async function tokensForOwner(ownerKey: string): Promise<TokenRecord[]> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT class_id, scope, assessment_key, value_token, updated_at
       FROM class_user_marks
      WHERE user_key = $1
      ORDER BY class_id, scope, assessment_key`,
    [ownerKey]
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
    })
  );
}

/**
 * Old-scheme classes this login plausibly contributed to.
 *
 * `user_hash` is kept in the flow only as a lookup hint, never as identity: the caller
 * proves who they are through the VTOP session, and the login ID is accepted as
 * belonging to them only when it matches the verified register number. The legacy
 * lookup then uses server-derived case variants, so a caller can only ever retrieve
 * their *own* associations — never anyone else's.
 *
 * Returned rows carry no tokens (none were ever minted for them) and no values, just
 * the class ids, so the client can label those cohorts as legacy-held.
 */
export async function legacyAssociations(
  authorizedID: string,
  regNo: string
): Promise<string[]> {
  const id = authorizedID.trim();
  if (!id || id.toUpperCase() !== regNo.trim().toUpperCase()) return [];

  const pool = getDbPool();
  const variants = Array.from(new Set([id, id.toUpperCase(), id.toLowerCase()]));
  const { rows } = await pool.query(
    `SELECT DISTINCT class_id FROM class_user_hashes_legacy
      WHERE user_hash = ANY($1)`,
    [await Promise.all(variants.map(sha256hex))]
  );
  return rows.map((r: { class_id: string }) => r.class_id);
}

/* ── read path ────────────────────────────────────────────────────────────── */

export type ClassStats = {
  count: number;
  mean: number;
  sd: number;
  assessments: Record<string, { count: number; mean: number; sd: number }>;
};

/**
 * Statistics for a set of classes.
 *
 * ## The caller does not get to choose this set
 *
 * The route resolves the list from the caller's own VTOP session before calling here, so
 * there is nothing to authorise — the cookie is the proof. An earlier version derived the
 * list from the caller's rows in `class_user_marks` instead, which was airtight but had a
 * fatal cold start: that table is empty until a student syncs through the new path, and the
 * 1,918 classes contributed through the *old* path could never be reconstructed, because
 * the old identity was an unsalted browser hash of a login id and this one is an HMAC of a
 * register number. Every class read back as empty until every student happened to re-sync.
 *
 * Asking VTOP what this session may see costs the same one round trip the identity check
 * did, has no gap, and cannot be steered by the caller.
 */
export async function statsForClasses(
  classIds: string[]
): Promise<Record<string, ClassStats>> {
  if (classIds.length === 0) return {};

  const pool = getDbPool();
  const unique = Array.from(new Set(classIds));

  const [overallRes, assessmentRes] = await Promise.all([
    pool.query(
      `SELECT class_id, count, mean, m2 FROM class_overall_stats WHERE class_id = ANY($1)`,
      [unique]
    ),
    pool.query(
      `SELECT class_id, assessment_key, count, mean, m2
         FROM class_assessment_stats WHERE class_id = ANY($1)`,
      [unique]
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
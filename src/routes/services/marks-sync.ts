/**
 * POST /api/services/marks/sync — contribute the caller's marks to the cohort
 * statistics (class_user_marks + Welford accumulators). Identity always comes
 * from the VTOP response, never the body.
 */
import { Hono } from "hono";
import { vtopPostForm, readText, cookieHeader, formParams } from "../../lib/vtop";
import { parseStudentProfile } from "../../lib/parsers/student-profile";
import { getClientIp, checkRateLimit, rateLimitResponse } from "../../lib/rateLimit";
import { getDbPool, getDbErrorStatus, getDbErrorMessage } from "../../lib/db";
import { publicErrorMessage } from "../../lib/publicError";
import {
  assessmentKeyFor,
  ensureSchema,
  ownerKeyFor,
  recordContribution,
  valueToken,
  OVERALL_KEY,
  type Contribution,
  type ContributionOutcome,
} from "../../lib/marksStats";
import type { DbClient } from "../../lib/db";

export const marksSyncRoute = new Hono();

const MAX_CONTRIBUTIONS = 400;

function fail(status: number, error: string, extra?: Record<string, unknown>) {
  return Response.json({ success: false, error, ...extra }, { status });
}

type WireContribution = {
  classId?: unknown;
  scope?: unknown;
  title?: unknown;
  component?: unknown;
  mark?: unknown;
  prevMark?: unknown;
};

function sanitise(raw: WireContribution): Contribution | null {
  if (!raw || typeof raw !== "object") return null;

  const classId = typeof raw.classId === "string" ? raw.classId.trim() : "";
  if (!classId) return null;

  const mark = Number(raw.mark);
  if (!Number.isFinite(mark)) return null;

  const scope = raw.scope === "overall" ? "overall" : "assessment";
  const title = typeof raw.title === "string" ? raw.title : "";
  const component = typeof raw.component === "string" ? raw.component : "";

  const prevMark = raw.prevMark == null ? null : Number(raw.prevMark);

  return {
    classId,
    scope,
    title,
    component,
    mark,
    prevMark: prevMark != null && Number.isFinite(prevMark) ? prevMark : null,
  };
}

marksSyncRoute.post("/marks/sync", async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = checkRateLimit(`marks-sync:${ip}`, 20, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const body = (await c.req.json().catch(() => ({}))) as {
    cookies?: string | string[];
    authorizedID?: string;
    csrf?: string;
    contributions?: WireContribution[];
  };

  const cookieHeaderValue = cookieHeader({ cookies: body.cookies });
  if (!cookieHeaderValue || !body.authorizedID || !body.csrf) {
    return fail(400, "missing_credentials", {
      detail: "Missing cookies, csrf or authorizedID",
    });
  }

  const raw = body.contributions;
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail(400, "no_contributions", {
      detail: "contributions must be a non-empty array",
    });
  }
  if (raw.length > MAX_CONTRIBUTIONS) {
    return fail(400, "too_many_contributions", {
      detail: `At most ${MAX_CONTRIBUTIONS} contributions per request`,
      received: raw.length,
    });
  }

  const contributions = raw.map(sanitise).filter((c): c is Contribution => c !== null);
  if (contributions.length === 0) {
    return fail(400, "no_valid_contributions", {
      detail: "Every contribution was missing a classId or a numeric mark",
    });
  }

  try {
    const profileRes = await vtopPostForm(
      "/vtop/studentsRecord/StudentProfileAllView",
      formParams({
        verifyMenu: "true",
        authorizedID: String(body.authorizedID),
        _csrf: String(body.csrf),
        nocache: Date.now().toString(),
      }),
      { cookies: cookieHeaderValue, timeoutMs: 20_000 }
    );

    const profile = parseStudentProfile(await readText(profileRes));
    const regNumber = profile.registerNo || profile.applicationNumber;
    if (!regNumber) {
      return fail(401, "vtop_identity_unresolved", {
        detail:
          "VTOP returned no REGISTER NO for these cookies. The session is not this student's, or has expired.",
      });
    }

    const ownerKey = await ownerKeyFor(regNumber);

    await ensureSchema();

    const pool = getDbPool();
    const db: DbClient = await pool.connect();
    const tally: Record<ContributionOutcome, number> = {
      added: 0,
      replaced: 0,
      reconciled: 0,
      skipped: 0,
      rejected: 0,
    };
    const tokens: Record<string, string> = {};

    try {
      await db.query("BEGIN");
      const now = Date.now();
      const reconcile = { authorizedID: String(body.authorizedID), regNo: regNumber };
      for (const contribution of contributions) {
        const outcome = await recordContribution(db, ownerKey, contribution, now, reconcile);
        tally[outcome] += 1;
        if (outcome === "added" || outcome === "replaced" || outcome === "reconciled") {
          const key =
            contribution.scope === "overall"
              ? OVERALL_KEY
              : await assessmentKeyFor(
                  contribution.classId,
                  contribution.component ?? "",
                  contribution.title ?? ""
                );
          tokens[`${contribution.classId}::${contribution.scope}::${key}`] = await valueToken(
            contribution.mark
          );
        }
      }
      await db.query("COMMIT");
    } catch (err: unknown) {
      await db.query("ROLLBACK").catch(() => {});
      console.error("marks/sync transaction failed:", err);
      return fail(getDbErrorStatus(err), "stats_write_failed", {
        detail: getDbErrorMessage(err),
      });
    } finally {
      db.release();
    }

    return c.json({ success: true, tally, tokens });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\b401\b|unauthor|\bsession\b|invalid\s*csrf/i.test(message)) {
      return fail(401, "vtop_session_expired", { detail: message });
    }
    console.error("marks/sync error:", message);
    return fail(502, "vtop_unavailable", { detail: publicErrorMessage(err, "VTOP request failed") });
  }
});

/**
 * POST /api/services/marks/stats — cohort statistics for the classes the
 * caller is actually enrolled in (enrollment is checked server-side, never
 * trusted from the body).
 */
import { Hono } from "hono";
import { vtopPostForm, readText, cookieHeader, formParams } from "../../lib/vtop";
import { parseStudentProfile } from "../../lib/parsers/student-profile";
import { getClientIp, checkRateLimit, rateLimitResponse } from "../../lib/rateLimit";
import { getDbErrorStatus, getDbErrorMessage } from "../../lib/db";
import {
  ensureSchema,
  enrolledSubset,
  ownerKeyFor,
  statsForClasses,
} from "../../lib/marksStats";

export const marksStatsRoute = new Hono();

function fail(status: number, error: string, extra?: Record<string, unknown>) {
  return Response.json({ success: false, error, ...extra }, { status });
}

marksStatsRoute.post("/marks/stats", async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = checkRateLimit(`marks-stats:${ip}`, 60, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const { cookies, authorizedID, csrf, classIds } = (await c.req.json().catch(() => ({}))) as {
    cookies?: string | string[];
    authorizedID?: string;
    csrf?: string;
    classIds?: string[];
  };

  const cookieHeaderValue = cookieHeader({ cookies });
  if (!cookieHeaderValue || !authorizedID || !csrf) {
    return fail(400, "missing_credentials", {
      detail: "Missing cookies, csrf or authorizedID",
    });
  }

  try {
    if (!Array.isArray(classIds) || classIds.length === 0) {
      return fail(400, "no_classes", { detail: "classIds must be a non-empty array" });
    }
    if (classIds.length > 100) {
      return fail(400, "too_many_classes", { detail: "At most 100 classes per request" });
    }
    const requested = classIds.filter(
      (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64
    );
    if (requested.length === 0) {
      return fail(400, "no_valid_classes", { detail: "No usable class ids" });
    }

    const identityRes = await vtopPostForm(
      "/vtop/studentsRecord/StudentProfileAllView",
      formParams({
        verifyMenu: "true",
        authorizedID: String(authorizedID),
        _csrf: String(csrf),
        nocache: Date.now().toString(),
      }),
      { cookies: cookieHeaderValue, timeoutMs: 20_000 }
    );

    const profile = parseStudentProfile(await readText(identityRes));
    const regNumber = profile.registerNo || profile.applicationNumber;
    if (!regNumber) {
      return fail(401, "vtop_identity_unresolved", {
        detail:
          "VTOP returned no REGISTER NO for these cookies. The session is not this student's, or has expired.",
      });
    }

    await ensureSchema();

    const ownerKey = await ownerKeyFor(regNumber);
    const allowed = await enrolledSubset(ownerKey, requested);
    const stats = await statsForClasses(allowed);

    const withData = Object.values(stats).filter((s) => s && (s.count ?? 0) > 0).length;
    console.log(`marks/stats: requested ${requested.length}, enrolled ${allowed.length}, ${withData} with data`);

    return c.json({ success: true, stats });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\b401\b|unauthor|\bsession\b|invalid\s*csrf/i.test(message)) {
      return fail(401, "vtop_session_expired", { detail: message });
    }
    if (/relation "[^"]+" does not exist/i.test(message)) {
      return c.json({ success: true, stats: {} });
    }
    console.error("marks/stats error:", message);
    return fail(getDbErrorStatus(err), "stats_read_failed", {
      detail: getDbErrorMessage(err),
    });
  }
});

/** Kept so a stale client that still GETs gets a pointed error rather than a 405. */
marksStatsRoute.get("/marks/stats", (c) => {
  return Response.json(
    {
      success: false,
      error: "method_not_allowed",
      detail:
        "This endpoint requires POST with the caller's VTOP session so that credentials are attached and the class set cannot be chosen by the caller.",
    },
    { status: 405, headers: { Allow: "POST" } }
  );
});

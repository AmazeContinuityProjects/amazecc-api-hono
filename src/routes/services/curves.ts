/**
 * POST /api/services/curves — class-cohort statistics (the "curve") + classmates.
 *
 * Auth (either one):
 *   1. VTOP Auth: body { cookies, authorizedID, csrf } → call VTOP profile → reg_no
 *   2. AmazeID: header Authorization: DPoP <token> → verifyAmazeSession → vtopRegNo → reg_no
 *
 * Body: { classIds[]?, classId?, scope?, assessmentKey?, semesterId? }
 *   - scope: "overall" | "assessment" (default "overall")
 *   - assessmentKey: required when scope === "assessment"
 *   - classIds: batch mode for the app's cohort-statistics view; enrollment is
 *     checked against FFCS registrations and both overall/assessment stats return.
 *
 * Returns (single class):
 *   { success, classId, stats, classmates }
 *
 * Returns (batch):
 *   { success, stats: { [classId]: { count, mean, sd, assessments } } }
 *
 * Classmates = every other student enrolled in the same class_id
 * (from ffcs_class_registrations), joined with student_profiles for names.
 */
import { Hono } from "hono";
import { getClientIp, checkRateLimit, rateLimitResponse } from "../../lib/rateLimit";
import { publicErrorMessage } from "../../lib/publicError";
import { getWorkerEnv } from "../../env";
import {
  verifyAmazeSession,
  adminUnauthorized,
} from "../../lib/amazeId";
import {
  vtopPostForm,
  readText,
  cookieHeader,
  formParams,
} from "../../lib/vtop";
import { parseStudentProfile } from "../../lib/parsers/student-profile";
import { ensureSchema, statsForClasses } from "../../lib/marksStats";
import { ensureFfcsSemesterInD1, readD1Registrations } from "../../lib/socialD1";
import { getStudentProfileByRegNo } from "../../lib/student-profiles";

export const curvesRouter = new Hono();

const ROSTER_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const classRosterCache = new Map<string, { roster: Array<{ reg_no: string; display_name: string | null }>; expiresAt: number }>();

function fail(status: number, error: string, extra?: Record<string, unknown>) {
  return Response.json({ success: false, error, ...extra }, { status });
}

type RequestBody = {
  cookies?: string | string[];
  authorizedID?: string;
  csrf?: string;
  semesterId?: string;
  classIds?: string[];
  classId?: string;
  scope?: "overall" | "assessment";
  assessmentKey?: string;
};

/** Resolve the caller's reg_no from either VTOP session or Amaze ID session. */
async function resolveRegNo(
  authHeader: string,
  body: RequestBody,
): Promise<string | null> {
  // 1. AmazeID auth via DPoP
  if (authHeader.toLowerCase().startsWith("dpop ")) {
    // verifyAmazeSession needs the raw Request; we pass it via closure below.
    return null; // handled in route handler to access c.req.raw
  }

  // 2. VTOP Auth via body credentials
  const cookieHeaderValue = cookieHeader({ cookies: body.cookies });
  if (!cookieHeaderValue || !body.authorizedID || !body.csrf) return null;

  try {
    const profileRes = await vtopPostForm(
      "/vtop/studentsRecord/StudentProfileAllView",
      formParams({
        verifyMenu: "true",
        authorizedID: String(body.authorizedID),
        _csrf: String(body.csrf),
        nocache: Date.now().toString(),
      }),
      { cookies: cookieHeaderValue, timeoutMs: 20_000 },
    );
    const profile = parseStudentProfile(await readText(profileRes));
    const regNo = profile.registerNo || profile.applicationNumber;
    return regNo ? regNo.trim().toUpperCase() : null;
  } catch {
    return null;
  }
}

curvesRouter.post("/curves", async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = checkRateLimit(`curves:${ip}`, 60, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const authHeader = c.req.raw.headers.get("authorization") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as RequestBody;

  // ── Resolve identity ──
  let regNo: string | null = null;

  if (authHeader.toLowerCase().startsWith("dpop ")) {
    // AmazeID auth via DPoP
    const identity = await verifyAmazeSession(c.req.raw);
    if (!identity) return adminUnauthorized();
    if (identity.vtopRegNo) {
      regNo = identity.vtopRegNo.trim().toUpperCase();
    }
    // If Amaze ID linked but no VTOP reg_no yet, we cannot proceed
    if (!regNo) {
      return fail(403, "profile_incomplete", {
        detail: "Amaze ID is not linked to a VTOP account yet",
      });
    }
  } else {
    // VTOP Auth via body credentials
    regNo = await resolveRegNo(authHeader, body);
    if (!regNo) return adminUnauthorized();
  }

  try {
    await ensureSchema();

    if (body.classIds !== undefined) {
      if (!Array.isArray(body.classIds) || body.classIds.length > 100) {
        return fail(400, "invalid_classIds", {
          detail: "classIds must be an array containing at most 100 class ids",
        });
      }

      const requested = Array.from(
        new Set(
          body.classIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64,
          ),
        ),
      );
      if (requested.length === 0) {
        return fail(400, "no_valid_classIds", { detail: "No usable class ids were provided" });
      }

      const semester = body.semesterId?.trim() || null;
      const db = getWorkerEnv().APP_DB;
      if (!db) throw new Error("APP_DB is not configured");
      if (semester) await ensureFfcsSemesterInD1(semester);

      // Query only the requested classes for this student using indexed lookup
      const placeholders = requested.map(() => "?").join(", ");
      const query = semester
        ? `SELECT class_id FROM ffcs_class_registrations WHERE semester_id = ? AND register_no = ? AND class_id IN (${placeholders})`
        : `SELECT class_id FROM ffcs_class_registrations WHERE register_no = ? AND class_id IN (${placeholders})`;
      const params = semester ? [semester, regNo, ...requested] : [regNo, ...requested];
      const { results } = await db.prepare(query).bind(...params).all<{ class_id: string }>();
      const allowed = [...new Set(results.map((row) => row.class_id))];
      const stats = await statsForClasses(allowed);
      return c.json({ success: true, stats }, { status: 200 });
    }

    const { classId, scope = "overall", assessmentKey, semesterId } = body;
    if (!classId || typeof classId !== "string") {
      return fail(400, "missing_classId", { detail: "classId is required" });
    }

    // ── Verify enrollment: caller must be registered for this class ──
    const semester = semesterId?.trim() || "";
    const db = getWorkerEnv().APP_DB;
    if (!db) throw new Error("APP_DB is not configured");
    if (semester) await ensureFfcsSemesterInD1(semester);

    const enrollmentQuery = semester
      ? `SELECT 1 FROM ffcs_class_registrations WHERE semester_id = ? AND class_id = ? AND register_no = ? LIMIT 1`
      : `SELECT 1 FROM ffcs_class_registrations WHERE class_id = ? AND register_no = ? LIMIT 1`;
    const enrollmentParams = semester ? [semester, classId, regNo] : [classId, regNo];
    const enrolledRow = await db.prepare(enrollmentQuery).bind(...enrollmentParams).first();
    if (!enrolledRow) {
      return fail(403, "not_enrolled", {
        detail: "You are not enrolled in this class for the given semester",
      });
    }

    // ── Curve stats ──
    const cohort = (await statsForClasses([classId]))[classId]!;
    let stats: { count: number; mean: number; sd: number; component?: string; title?: string };
    if (scope === "assessment") {
      if (!assessmentKey) {
        return fail(400, "missing_assessmentKey", {
          detail: "assessmentKey is required when scope is 'assessment'",
        });
      }
      stats = cohort.assessments[assessmentKey] ?? { count: 0, mean: 0, sd: 0 };
    } else {
      stats = { count: cohort.count, mean: cohort.mean, sd: cohort.sd };
    }

    // ── Classmates: every other student in the same class (joined with profiles in 1 query) ──
    const rosterKey = `${semester}::${classId}`;
    const now = Date.now();
    let allClassmates: Array<{ reg_no: string; display_name: string | null }>;

    const cachedRoster = classRosterCache.get(rosterKey);
    if (cachedRoster && now < cachedRoster.expiresAt) {
      allClassmates = cachedRoster.roster;
    } else {
      const classmatesQuery = semester
        ? `SELECT r.register_no, COALESCE(p.display_name, r.display_name, '') as display_name
           FROM ffcs_class_registrations r
           LEFT JOIN student_profiles p ON p.reg_no = r.register_no
           WHERE r.semester_id = ? AND r.class_id = ?`
        : `SELECT r.register_no, COALESCE(p.display_name, r.display_name, '') as display_name
           FROM ffcs_class_registrations r
           LEFT JOIN student_profiles p ON p.reg_no = r.register_no
           WHERE r.class_id = ?`;
      const classmatesParams = semester ? [semester, classId] : [classId];
      const { results: classmateRows } = await db.prepare(classmatesQuery).bind(...classmatesParams)
        .all<{ register_no: string; display_name: string | null }>();
      allClassmates = classmateRows.map((r) => ({
        reg_no: r.register_no,
        display_name: r.display_name || null,
      }));
      if (classRosterCache.size >= 5000) classRosterCache.clear();
      classRosterCache.set(rosterKey, { roster: allClassmates, expiresAt: now + ROSTER_CACHE_TTL_MS });
    }

    const classmates = allClassmates.filter((c) => c.reg_no !== regNo);
    classmates.sort((a, b) => (a.display_name || "").localeCompare(b.display_name || "") || a.reg_no.localeCompare(b.reg_no));

    return c.json(
      {
        success: true,
        classId,
        semesterId: semester || null,
        stats,
        classmates,
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    console.error("[curves] error:", err instanceof Error ? err.message : String(err));
    return fail(500, "curves_read_failed", {
      detail: publicErrorMessage(err, "Internal database error"),
    });
  }
});

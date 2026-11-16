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
import { getDbPool } from "../../lib/db";
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

export const curvesRouter = new Hono();

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

  const pool = getDbPool();

  try {
    // Ensure a partial Amaze ID account exists for this reg number.
    await pool.query(
      `INSERT INTO student_profiles (reg_no, claim_status)
       VALUES ($1, 'incomplete')
       ON CONFLICT (reg_no) DO NOTHING`,
      [regNo],
    );
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
      const enrollment = await pool.query(
        `SELECT DISTINCT class_id FROM ffcs_class_registrations
          WHERE register_no = $1 AND class_id = ANY($2::text[])
            AND ($3::text IS NULL OR semester_id = $3)`,
        [regNo, requested, semester],
      );
      const allowed = enrollment.rows.map((row: { class_id: string }) => row.class_id);
      const stats = await statsForClasses(allowed);
      return c.json({ success: true, stats }, { status: 200 });
    }

    const { classId, scope = "overall", assessmentKey, semesterId } = body;
    if (!classId || typeof classId !== "string") {
      return fail(400, "missing_classId", { detail: "classId is required" });
    }

    // ── Verify enrollment: caller must be registered for this class ──
    const semester = semesterId || "";
    const enrollment = await pool.query(
      `SELECT 1 FROM ffcs_class_registrations
        WHERE semester_id = $1 AND class_id = $2 AND register_no = $3
        LIMIT 1`,
      [semester, classId, regNo],
    );
    if (enrollment.rows.length === 0) {
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

    // ── Classmates: every other student in the same class ──
    const { rows: classmateRows } = await pool.query(
      `SELECT r.register_no, p.display_name, p.handle
         FROM ffcs_class_registrations r
         LEFT JOIN student_profiles p ON p.reg_no = r.register_no
        WHERE r.semester_id = $1 AND r.class_id = $2 AND r.register_no <> $3
        ORDER BY p.display_name, r.register_no`,
      [semester, classId, regNo],
    );

    const classmates = classmateRows.map((r: any) => ({
      reg_no: r.register_no,
      display_name: r.display_name || null,
    }));

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

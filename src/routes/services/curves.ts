/**
 * POST /api/services/curves — class-cohort statistics (the "curve") + classmates.
 *
 * Auth (either one):
 *   1. VTOP Auth: body { cookies, authorizedID, csrf } → call VTOP profile → reg_no
 *   2. AmazeID: header Authorization: DPoP <token> → verifyAmazeSession → vtopRegNo → reg_no
 *
 * Body: { classId?, scope?, assessmentKey?, semesterId? }
 *   - scope: "overall" | "assessment" (default "overall")
 *   - assessmentKey: required when scope === "assessment"
 *
 * Returns:
 *   { success, classId, stats: { count, mean, sd }, classmates: [{ reg_no, display_name, handle }] }
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
  upsertStudentProfile,
  getStudentProfileByRegNo,
} from "../../lib/student-profiles";
import {
  vtopPostForm,
  readText,
  cookieHeader,
  formParams,
} from "../../lib/vtop";
import { parseStudentProfile } from "../../lib/parsers/student-profile";

export const curvesRouter = new Hono();

function fail(status: number, error: string, extra?: Record<string, unknown>) {
  return Response.json({ success: false, error, ...extra }, { status });
}

type Acc = { count: number; mean: number; m2: number };

function sd(acc: Acc): number {
  if (acc.count <= 1) return 0;
  return Math.sqrt(Math.max(0, acc.m2) / acc.count);
}

type RequestBody = {
  cookies?: string | string[];
  authorizedID?: string;
  csrf?: string;
  semesterId?: string;
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
  if (authHeader.toLowerCase().startsWith("dopop ")) {
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

curvesRouter.post("/", async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = checkRateLimit("curves:${ip}", 60, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const authHeader = c.req.raw.headers.get("authorization") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as RequestBody;

  // ── Resolve identity ──
  let regNo: string | null = null;

  if (authHeader.toLowerCase().startsWith("dopop ")) {
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

  const { classId, scope = "overall", assessmentKey, semesterId } = body;

  if (!classId || typeof classId !== "string") {
    return fail(400, "missing_classId", { detail: "classId is required" });
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
    let stats: { count: number; mean: number; sd: number };
    if (scope === "assessment") {
      if (!assessmentKey) {
        return fail(400, "missing_assessmentKey", {
          detail: "assessmentKey is required when scope is 'assessment'",
        });
      }
      const { rows } = await pool.query(
        `SELECT count, mean, m2 FROM class_assessment_stats
          WHERE class_id = $1 AND assessment_key = $2`,
        [classId, assessmentKey],
      );
      if (rows.length === 0) {
        stats = { count: 0, mean: 0, sd: 0 };
      } else {
        const acc: Acc = {
          count: Number(rows[0].count),
          mean: Number(rows[0].mean),
          m2: Number(rows[0].m2),
        };
        stats = { count: acc.count, mean: acc.mean, sd: sd(acc) };
      }
    } else {
      // scope === "overall"
      const { rows } = await pool.query(
        `SELECT count, mean, m2 FROM class_overall_stats WHERE class_id = $1`,
        [classId],
      );
      if (rows.length === 0) {
        stats = { count: 0, mean: 0, sd: 0 };
      } else {
        const acc: Acc = {
          count: Number(rows[0].count),
          mean: Number(rows[0].mean),
          m2: Number(rows[0].m2),
        };
        stats = { count: acc.count, mean: acc.mean, sd: sd(acc) };
      }
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
      handle: r.handle || null,
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

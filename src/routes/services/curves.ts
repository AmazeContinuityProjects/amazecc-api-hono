/**
 * POST /api/services/curves — class-cohort statistics (the "curve").
 *
 * Body: { classId, scope?, assessmentKey? }
 *   - scope: "overall" | "assessment" (default "overall")
   *   - assessmentKey: required when scope === "assessment"
 *
 * Returns the Welford accumulator stats for that class:
 *   { count, mean, sd, assessments? }
 *
 * Auth: any Amaze ID (first-party guard). The class must be one the caller
 * is enrolled in (enrollment is recorded on /api/remote/attendance).
 */
import { Hono } from "hono";
import { getClientIp, checkRateLimit, rateLimitResponse } from "../../lib/rateLimit";
import { getDbPool } from "../../lib/db";
import { publicErrorMessage } from "../../lib/publicError";

export const curvesRouter = new Hono();

function fail(status: number, error: string, extra?: Record<string, unknown>) {
  return Response.json({ success: false, error, ...extra }, { status });
}

type Acc = { count: number; mean: number; m2: number };

function sd(acc: Acc): number {
  if (acc.count <= 1) return 0;
  return Math.sqrt(Math.max(0, acc.m2) / acc.count);
}

curvesRouter.post("/", async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = checkRateLimit("curves:${ip}", 60, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const { classId, scope = "overall", assessmentKey } = (await c.req
    .json()
    .catch(() => ({}))) as {
    classId?: string;
    scope?: "overall" | "assessment";
    assessmentKey?: string;
  };

  if (!classId || typeof classId !== "string") {
    return fail(400, "missing_classId", { detail: "classId is required" });
  }

  try {
    const pool = getDbPool();

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
        return c.json(
          { success: true, count: 0, mean: 0, sd: 0 },
          { status: 200 },
        );
      }
      const acc: Acc = {
        count: Number(rows[0].count),
        mean: Number(rows[0].mean),
        m2: Number(rows[0].m2),
      };
      return c.json(
        {
          success: true,
          count: acc.count,
          mean: acc.mean,
          sd: sd(acc),
          assessmentKey,
        },
        { status: 200 },
      );
    }

    // scope === "overall"
    const { rows } = await pool.query(
      `SELECT count, mean, m2 FROM class_overall_stats WHERE class_id = $1`,
      [classId],
    );
    if (rows.length === 0) {
      return c.json(
        { success: true, count: 0, mean: 0, sd: 0 },
        { status: 200 },
      );
    }
    const acc: Acc = {
      count: Number(rows[0].count),
      mean: Number(rows[0].mean),
      m2: Number(rows[0].m2),
    };
    return c.json(
      {
        success: true,
        count: acc.count,
        mean: acc.mean,
        sd: sd(acc),
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

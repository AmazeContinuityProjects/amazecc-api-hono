/**
 * GET /api/services/social/semester — get the current social semester.
 *
 * No auth required. Returns { success, semesterId, semesterLabel, resolvedAt }
 */
import { Hono } from "hono";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { getDbPool } from "../../../../src/lib/db";

export const socialSemesterRouter = new Hono();

socialSemesterRouter.get("/semester", async (c) => {
  try {
    const pool = getDbPool();
    const { rows } = await pool.query(
      "SELECT value FROM app_config WHERE key = 'social_current_semester'",
    );
    if (!rows.length) {
      return c.json(
        { success: false, error: "no_current_semester", detail: { detail: "No derivation has run yet" } }, 404);
    }
    const v = (rows[0] as any).value || {};
    return c.json({
      success: true,
      semesterId: v.semesterId || null,
      semesterLabel: v.label || "",
      resolvedAt: v.resolvedAt || null,
    });
  } catch (err: unknown) {
    console.error("[social] semester error:", err);
    return c.json({ success: false, error: "database_unavailable" }, 503);
  }
});




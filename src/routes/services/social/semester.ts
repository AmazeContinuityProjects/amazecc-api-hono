/**
 * GET /api/services/social/semester — get the current social semester.
 *
 * No auth required. Returns { success, semesterId, semesterLabel, resolvedAt }
 */
import { Hono } from "hono";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { readAppConfig } from "../../../../src/lib/appConfig";

export const socialSemesterRouter = new Hono();

socialSemesterRouter.get("/semester", async (c) => {
  try {
    const value = await readAppConfig<{ semesterId?: string; label?: string; resolvedAt?: string }>(
      "social_current_semester",
    );
    if (!value) {
      return c.json(
        { success: false, error: "no_current_semester", detail: { detail: "No derivation has run yet" } }, 404);
    }
    c.header("Cache-Control", "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400");
    return c.json({
      success: true,
      semesterId: value.semesterId || null,
      semesterLabel: value.label || "",
      resolvedAt: value.resolvedAt || null,
    });
  } catch (err: unknown) {
    console.error("[social] semester error:", err);
    return c.json({ success: false, error: "database_unavailable" }, 503);
  }
});




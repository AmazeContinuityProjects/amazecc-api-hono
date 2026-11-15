/**
 * POST /api/services/social/grant/visibility — change grant visibility.
 *
 * Body: { cookies, authorizedID, csrf, grantId, visibility: "coarse"|"full" }
 * Returns { success, grantId, visibility }
 */
import { Hono } from "hono";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { identifyCaller, ensureSocialSchema, SOCIAL_TABLE } from "../../../../src/lib/social";
import { getDbPool } from "../../../../src/lib/db";

export const socialGrantVisibilityRouter = new Hono();

socialGrantVisibilityRouter.post("/grant/visibility", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      cookies?: string | string[];
      authorizedID?: string;
      csrf?: string;
      grantId?: string;
      visibility?: "coarse" | "full";
    };

    const result = await identifyCaller(body);
    if (!result.ok) {
      return c.json(
        { success: false, error: result.error, detail: result.detail }, result.status as any,
      );
    }

    if (!body.grantId) {
      return c.json(
        { success: false, error: "missing_grant_reference", detail: { detail: "grantId is required" } }, 400);
    }
    if (!body.visibility || !["coarse", "full"].includes(body.visibility)) {
      return c.json(
        { success: false, error: "invalid_visibility", detail: { detail: "Expected coarse or full" } }, 400);
    }

    await ensureSocialSchema();
    const pool = getDbPool();

    const { rows } = await pool.query(
      `SELECT * FROM ${SOCIAL_TABLE} WHERE grant_id = $1`,
      [body.grantId],
    );
    if (!rows.length) {
      return c.json(
        { success: false, error: "grant_not_found", detail: { detail: "Grant not found" } }, 404);
    }
    const grant = rows[0] as any;

    const callerKey = result.caller.ownerKey;
    const isParticipant = grant.owner_a === callerKey || grant.owner_b === callerKey;
    if (!isParticipant) {
      return c.json(
        { success: false, error: "not_a_participant", detail: { detail: "Caller is not a grant participant" } }, 403);
    }

    await pool.query(
      `UPDATE ${SOCIAL_TABLE} SET visibility = $1 WHERE grant_id = $2`,
      [body.visibility, body.grantId],
    );

    return c.json({ success: true, grantId: body.grantId, visibility: body.visibility });
  } catch (err: unknown) {
    console.error("[social] grant/visibility error:", err);
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});




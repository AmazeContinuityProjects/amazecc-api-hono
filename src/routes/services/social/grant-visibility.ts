/**
 * POST /api/services/social/grant/visibility — change grant visibility.
 *
 * Body: { cookies, authorizedID, csrf, grantId, visibility: "coarse"|"full" }
 * Returns { success, grantId, visibility }
 */
import { Hono } from "hono";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { identifyCaller, SOCIAL_TABLE } from "../../../../src/lib/social";
import { ensureSocialInD1 } from "../../../../src/lib/socialD1";

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

    const db = await ensureSocialInD1();
    const grant = await db.prepare(`SELECT * FROM ${SOCIAL_TABLE} WHERE grant_id = ?`).bind(body.grantId).first<any>();
    if (!grant) {
      return c.json(
        { success: false, error: "grant_not_found", detail: { detail: "Grant not found" } }, 404);
    }
    const callerKey = result.caller.ownerKey;
    const isParticipant = grant.owner_a === callerKey || grant.owner_b === callerKey;
    if (!isParticipant) {
      return c.json(
        { success: false, error: "not_a_participant", detail: { detail: "Caller is not a grant participant" } }, 403);
    }

    await db.prepare(`UPDATE ${SOCIAL_TABLE} SET visibility = ? WHERE grant_id = ?`)
      .bind(body.visibility, body.grantId).run();

    return c.json({ success: true, grantId: body.grantId, visibility: body.visibility });
  } catch (err: unknown) {
    console.error("[social] grant/visibility error:", err);
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});




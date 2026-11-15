/**
 * POST /api/services/social/people — look up a person by handle.
 *
 * Body: { cookies, authorizedID, csrf, handle }
 * Returns { success, person: { handle, displayName, alreadyPaired } }
 */
import { Hono } from "hono";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { identifyCaller, ensureSocialSchema, regKey } from "../../../../src/lib/social";
import { getDbPool } from "../../../../src/lib/db";

export const socialPeopleRouter = new Hono();

const HANDLE_RE = /^AMZ-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

socialPeopleRouter.post("/people", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      cookies?: string | string[];
      authorizedID?: string;
      csrf?: string;
      handle?: string;
    };

    const result = await identifyCaller(body);
    if (!result.ok) {
      return c.json(
        { success: false, error: result.error, detail: result.detail }, result.status as any,
      );
    }

    if (!body.handle || !HANDLE_RE.test(body.handle.trim())) {
      return c.json(
        { success: false, error: "invalid_handle_format", detail: { detail: "Handle must match AMZ-XXXX-XXXX" } }, 400);
    }

    await ensureSocialSchema();
    const pool = getDbPool();

    const { rows } = await pool.query(
      `SELECT p.handle, p.display_name,
              (SELECT COUNT(*) FROM social_grants g
               WHERE (g.owner_a = p.owner_key OR g.owner_b = p.owner_key)
                 AND g.revoked_at IS NULL) AS grant_count
         FROM social_people p
         WHERE p.handle = $1`,
      [body.handle.trim().toUpperCase()],
    );

    if (!rows.length) {
      return c.json({ success: false, error: "handle_not_found" }, 404);
    }

    return c.json({
      success: true,
      person: {
        handle: rows[0].handle,
        displayName: rows[0].display_name || null,
        alreadyPaired: Number(rows[0].grant_count) > 0,
      },
    });
  } catch (err: unknown) {
    console.error("[social] people error:", err);
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});




/**
 * POST /api/services/social/pair/claim — claim a pairing grant with a peer.
 *
 * Body: { cookies, authorizedID, csrf, handle, visibility?, expiresInMinutes? }
 * Returns { success, grantId, secret, created, visibility, peer }
 * (secret is the plaintext grant secret, handed out only on creation)
 */
import { Hono } from "hono";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { identifyCaller, ensureSocialSchema, SOCIAL_TABLE, generateHandle } from "../../../../src/lib/social";
import { getDbPool } from "../../../../src/lib/db";
import { createHash } from "node:crypto";

const MAX_GRANTS = 200;
const HANDLE_RE = /^AMZ-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export const socialPairClaimRouter = new Hono();

socialPairClaimRouter.post("/pair/claim", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      cookies?: string | string[];
      authorizedID?: string;
      csrf?: string;
      handle?: string;
      visibility?: "full" | "coarse";
      expiresInMinutes?: number;
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

    // Find peer by handle
    const { rows: peerRows } = await pool.query(
      "SELECT owner_key, display_name FROM social_people WHERE handle = $1",
      [body.handle.trim().toUpperCase()],
    );
    if (!peerRows.length) {
      return c.json(
        { success: false, error: "handle_not_found", detail: { detail: "Handle not found" } }, 404);
    }
    const peerKey = peerRows[0].owner_key;

    const callerKey = result.caller.ownerKey;
    if (peerKey === callerKey) {
      return c.json(
        { success: false, error: "already_self", detail: { detail: "Cannot pair with yourself" } }, 409);
    }

    // Check grant limit
    const { rows: grantCount } = await pool.query(
      `SELECT COUNT(*) AS n FROM ${SOCIAL_TABLE}
       WHERE (owner_a = $1 OR owner_b = $1) AND revoked_at IS NULL`,
      [callerKey],
    );
    if (Number(grantCount[0].n) >= MAX_GRANTS) {
      return c.json(
        { success: false, error: "grant_limit_reached", detail: { detail: "Grant limit reached" } }, 409);
    }

    // Check existing grant
    const { rows: existing } = await pool.query(
      `SELECT * FROM ${SOCIAL_TABLE}
       WHERE (owner_a = $1 AND owner_b = $2) OR (owner_a = $2 AND owner_b = $1)`,
      [callerKey, peerKey],
    );
    let grantId: string;
    let created = false;
    let visibility = body.visibility || "coarse";
    let secret: string | null = null;

    if (existing.length) {
      grantId = existing[0].grant_id;
      visibility = existing[0].visibility;
    } else {
      grantId = `grant_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      secret = `sec_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const secretHash = createHash("sha256").update(secret).digest("hex");
      await pool.query(
        `INSERT INTO ${SOCIAL_TABLE} (grant_id, owner_a, owner_b, secret_hash, visibility)
         VALUES ($1, $2, $3, $4, $5)`,
        [grantId, callerKey, peerKey, secretHash, visibility],
      );
      created = true;
    }

    // Get peer semesters
    const { rows: peerSemesters } = await pool.query(
      `SELECT DISTINCT semester_id FROM social_timetables WHERE owner_key = $1`,
      [peerKey],
    );

    return c.json({
      success: true,
      grantId,
      secret,
      created,
      visibility,
      peer: {
        handle: body.handle.trim().toUpperCase(),
        name: peerRows[0].display_name || null,
        lastPublishedAt: null,
        semesters: peerSemesters.map((r: any) => r.semester_id),
      },
    });
  } catch (err: unknown) {
    console.error("[social] pair/claim error:", err);
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});




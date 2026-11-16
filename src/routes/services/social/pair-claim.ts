/**
 * POST /api/services/social/pair/claim — claim a pairing grant with a peer.
 *
 * Body: { cookies, authorizedID, csrf, handle, visibility?, expiresInMinutes? }
 * Returns { success, grantId, secret, created, visibility, peer }
 * (secret is the plaintext grant secret, handed out only on creation)
 */
import { Hono } from "hono";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { identifyCaller, SOCIAL_TABLE } from "../../../../src/lib/social";
import { randomUUID } from "node:crypto";
import { hash } from "../../../../src/lib/generator";
import { ensureSocialInD1 } from "../../../../src/lib/socialD1";

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

    const db = await ensureSocialInD1();

    // Find peer by handle
    const peerRows = (await db.prepare(`SELECT p.owner_key, p.display_name FROM social_people p
          WHERE p.handle = ? OR EXISTS (
            SELECT 1 FROM social_handle_aliases a
             WHERE a.handle = ? AND a.register_no = UPPER(TRIM(p.register_no))) LIMIT 1`)
      .bind(body.handle.trim().toUpperCase(), body.handle.trim().toUpperCase())
      .all<{ owner_key: string; display_name: string | null }>()).results;
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
    const grantCount = await db.prepare(`SELECT COUNT(*) AS n FROM ${SOCIAL_TABLE}
      WHERE (owner_a = ? OR owner_b = ?) AND revoked_at IS NULL`).bind(callerKey, callerKey).first<{ n: number }>();
    if (Number(grantCount?.n ?? 0) >= MAX_GRANTS) {
      return c.json(
        { success: false, error: "grant_limit_reached", detail: { detail: "Grant limit reached" } }, 409);
    }

    // Check existing grant
    const existing = (await db.prepare(`SELECT * FROM ${SOCIAL_TABLE}
          WHERE (owner_a = ? AND owner_b = ?) OR (owner_a = ? AND owner_b = ?)`)
      .bind(callerKey, peerKey, peerKey, callerKey).all<any>()).results;
    let grantId: string;
    let created = false;
    let visibility = body.visibility || "coarse";
    let secret: string | null = null;

    if (existing.length) {
      grantId = existing[0].grant_id;
      visibility = existing[0].visibility;
    } else {
      grantId = `grant_${randomUUID()}`;
      secret = `sec_${randomUUID()}`;
      const secretHash = hash(`social-grant-secret:${secret}`);
      await db.prepare(`INSERT INTO ${SOCIAL_TABLE} (grant_id, owner_a, owner_b, secret_hash, visibility)
        VALUES (?, ?, ?, ?, ?)`).bind(grantId, callerKey, peerKey, secretHash, visibility).run();
      created = true;
    }

    // Get peer semesters
    const semesters = (await db.prepare(`SELECT DISTINCT semester_id FROM social_timetables WHERE owner_key = ?`)
      .bind(peerKey).all<{ semester_id: string }>()).results;

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
        semesters: semesters.map((r: any) => r.semester_id),
      },
    });
  } catch (err: unknown) {
    console.error("[social] pair/claim error:", err);
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});




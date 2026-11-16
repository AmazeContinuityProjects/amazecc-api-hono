/**
 * POST /api/services/social/timetable — fetch a peer's timetable via grant.
 *
 * Body: { cookies, authorizedID, csrf, secret, handle, semester?, semesterLabel? }
 * Both caller and peer must be participants of the same grant.
 */
import { Hono } from "hono";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { identifyCaller, SOCIAL_TABLE, TIMETABLE_TABLE } from "../../../../src/lib/social";
import { readAppConfig } from "../../../../src/lib/appConfig";
import { createHash } from "node:crypto";
import { hash } from "../../../../src/lib/generator";
import { ensureSocialInD1 } from "../../../../src/lib/socialD1";

export const socialTimetableRouter = new Hono();

socialTimetableRouter.post("/timetable", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      cookies?: string | string[];
      authorizedID?: string;
      csrf?: string;
      secret?: string;
      handle?: string;
      semester?: string;
      semesterLabel?: string;
    };

    const result = await identifyCaller(body);
    if (!result.ok) {
      return c.json(
        { success: false, error: result.error, detail: result.detail }, result.status as any,
      );
    }

    if (!body.secret) {
      return c.json(
        { success: false, error: "missing_grant", detail: { detail: "secret is required" } }, 400);
    }
    if (!body.handle) {
      return c.json(
        { success: false, error: "missing_grant", detail: { detail: "handle is required" } }, 400);
    }

    const db = await ensureSocialInD1();

    // Find grant by secret
    const secretHash = hash(`social-grant-secret:${body.secret}`);
    // Accept old SHA-256 grant hashes once, then upgrade them in-place. New
    // hashes always use the shared keyed generator.
    const legacySecretHash = createHash("sha256").update(body.secret).digest("hex");
    const grantRows = (await db.prepare(`SELECT * FROM ${SOCIAL_TABLE}
          WHERE secret_hash IN (?, ?) AND revoked_at IS NULL`)
      .bind(secretHash, legacySecretHash).all<any>()).results;
    if (!grantRows.length) {
      return c.json(
        { success: false, error: "grant_invalid", detail: { detail: "Grant secret not found or revoked" } }, 403);
    }
    const grant = grantRows[0] as any;
    if (grant.secret_hash === legacySecretHash) {
      await db.prepare(`UPDATE ${SOCIAL_TABLE} SET secret_hash = ? WHERE grant_id = ?`)
        .bind(secretHash, grant.grant_id).run();
    }

    const callerKey = result.caller.ownerKey;
    const isParticipant =
      grant.owner_a === callerKey || grant.owner_b === callerKey;
    if (!isParticipant) {
      return c.json(
        { success: false, error: "not_a_participant", detail: { detail: "Caller is not a grant participant" } }, 403);
    }

    // Resolve peer handle to owner_key
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

    const isPeerParticipant = grant.owner_a === peerKey || grant.owner_b === peerKey;
    if (!isPeerParticipant) {
      return c.json(
        { success: false, error: "not_a_participant", detail: { detail: "Peer is not a grant participant" } }, 403);
    }

    // Determine semester
    let semesterId = body.semester || "";
    let semesterLabel = body.semesterLabel || "";
    if (!semesterId) {
      const cached = await readAppConfig<{ semesterId?: string; label?: string }>(
        "social_current_semester",
      );
      if (cached?.semesterId) {
        semesterId = cached.semesterId;
        semesterLabel = cached.label || "";
      }
    }

    // Fetch peer timetable
    const ttRows = (await db.prepare(`SELECT * FROM ${TIMETABLE_TABLE} WHERE owner_key = ? AND semester_id = ?`)
      .bind(peerKey, semesterId).all<any>()).results;
    if (!ttRows.length) {
      return c.json(
        { success: false, error: "no_timetable_for_semester", detail: { detail: "No timetable for this peer/semester" } }, 404);
    }

    const stored = ttRows[0] as any;
    if (typeof stored.busy_map === "string") stored.busy_map = JSON.parse(stored.busy_map || "{}");
    if (typeof stored.courses === "string") stored.courses = JSON.parse(stored.courses || "[]");
    const visibility = grant.visibility;
    const now = Date.now();
    const STALE_AFTER_DAYS = 14;
    const stale = now - new Date(stored.published_at).getTime() > STALE_AFTER_DAYS * 86400000;

    return c.json({
      success: true,
      identity: {
        handle: body.handle.trim().toUpperCase(),
        displayName: stored.display_name || null,
        semesterId: stored.semester_id,
        semesterLabel: stored.slotmap_version || semesterLabel,
        publishedAt: stored.published_at,
        slotmapVersion: stored.slotmap_version,
      },
      visibility,
      stale,
      version: stored.version,
      busyMap: visibility === "coarse" ? Object.keys(stored.busy_map || {}) : (stored.busy_map || {}),
      courses: visibility === "full" ? (stored.courses || []) : [],
    });
  } catch (err: unknown) {
    console.error("[social] timetable error:", err);
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});




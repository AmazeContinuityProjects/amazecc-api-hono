/**
 * POST /api/services/social/timetable — fetch a peer's timetable via grant.
 *
 * Body: { cookies, authorizedID, csrf, secret, handle, semester?, semesterLabel? }
 * Both caller and peer must be participants of the same grant.
 */
import { Hono } from "hono";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { identifyCaller, ensureSocialSchema, SOCIAL_TABLE, TIMETABLE_TABLE } from "../../../../src/lib/social";
import { getDbPool } from "../../../../src/lib/db";

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

    await ensureSocialSchema();
    const pool = getDbPool();

    // Find grant by secret
    const { rows: grantRows } = await pool.query(
      `SELECT * FROM ${SOCIAL_TABLE} WHERE secret_hash = $1 AND revoked_at IS NULL`,
      [body.secret],
    );
    if (!grantRows.length) {
      return c.json(
        { success: false, error: "grant_invalid", detail: { detail: "Grant secret not found or revoked" } }, 403);
    }
    const grant = grantRows[0] as any;

    const callerKey = result.caller.ownerKey;
    const isParticipant =
      grant.owner_a === callerKey || grant.owner_b === callerKey;
    if (!isParticipant) {
      return c.json(
        { success: false, error: "not_a_participant", detail: { detail: "Caller is not a grant participant" } }, 403);
    }

    // Resolve peer handle to owner_key
    const { rows: peerRows } = await pool.query(
      "SELECT owner_key, display_name FROM social_people WHERE handle = $1",
      [body.handle.trim().toUpperCase()],
    );
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
      const { rows: cached } = await pool.query(
        "SELECT value FROM app_config WHERE key = 'social_current_semester'",
      );
      if (cached.length && (cached[0] as any).value?.semesterId) {
        semesterId = (cached[0] as any).value.semesterId;
        semesterLabel = (cached[0] as any).value.label || "";
      }
    }

    // Fetch peer timetable
    const { rows: ttRows } = await pool.query(
      `SELECT * FROM ${TIMETABLE_TABLE} WHERE owner_key = $1 AND semester_id = $2`,
      [peerKey, semesterId],
    );
    if (!ttRows.length) {
      return c.json(
        { success: false, error: "no_timetable_for_semester", detail: { detail: "No timetable for this peer/semester" } }, 404);
    }

    const stored = ttRows[0] as any;
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




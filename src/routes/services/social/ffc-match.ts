/**
 * GET/POST /api/services/social/ffcs-match — FFCS friend finder.
 *
 * GET ?semesterId=&classIds= — public class rosters
 * POST { cookies, authorizedID, csrf, semesterId, op, source?, classIds?, discoverable? }
 *   op: get | publish | visibility | leave | classes
 */
import { Hono } from "hono";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { identifyCaller, ensureSocialSchema, FFCS_MATCH_TABLE, FFCS_CLASSES_TABLE, FFCS_CLASS_REGISTRATIONS_TABLE, generateHandle } from "../../../../src/lib/social";
import { getDbPool } from "../../../../src/lib/db";

const MAX_CHANGES_PER_DAY = 3;

export const socialFfcsMatchRouter = new Hono();

// GET: public class rosters
socialFfcsMatchRouter.get("/ffcs-match", async (c) => {
  try {
    const params = new URL(c.req.raw.url).searchParams;
    const semesterId = params.get("semesterId");
    const classIdsParam = params.get("classIds");

    if (!semesterId) {
      return c.json({ success: false, error: "semester_not_supported", detail: { detail: "semesterId is required" } }, 400);
    }

    const pool = getDbPool();
    await ensureSocialSchema();

    let query = `
      SELECT c.class_id, c.course_code, c.course_title, c.course_type, c.slot, c.faculty, c.credits, c.room, c.register_nos,
             COALESCE(
               json_agg(json_build_object('regNo', r.register_no, 'name', r.display_name, 'handle', r.handle))
               FILTER (WHERE r.register_no IS NOT NULL AND r.discoverable),
               '[]'::json) AS students
      FROM ${FFCS_CLASSES_TABLE} c
      LEFT JOIN ${FFCS_CLASS_REGISTRATIONS_TABLE} r
        ON r.semester_id = c.semester_id AND r.class_id = c.class_id
      WHERE c.semester_id = $1`;
    const paramsArr: any[] = [semesterId];

    if (classIdsParam) {
      const classIds = classIdsParam.split(",").filter(Boolean);
      query += ` AND c.class_id = ANY($2)`;
      paramsArr.push(classIds);
    }
    query += ` GROUP BY c.class_id, c.course_code, c.course_title, c.course_type, c.slot, c.faculty, c.credits, c.room, c.register_nos
               ORDER BY c.course_code, c.class_id`;

    const { rows } = await pool.query(query, paramsArr);

    return c.json({
      success: true,
      semesterId,
      classes: rows.map((r: any) => ({
        classId: r.class_id,
        courseCode: r.course_code || "",
        courseTitle: r.course_title || "",
        courseType: r.course_type || "",
        slot: r.slot || "",
        faculty: r.faculty || "",
        credits: r.credits || "",
        room: r.room || "",
        registerNos: r.register_nos || [],
        students: r.students || [],
      })),
    });
  } catch (err: unknown) {
    console.error("[social] ffc-match GET error:", err);
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});

// POST: authenticated operations
socialFfcsMatchRouter.post("/ffcs-match", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      cookies?: string | string[];
      authorizedID?: string;
      csrf?: string;
      semesterId?: string;
      op?: "get" | "publish" | "visibility" | "leave" | "classes";
      source?: "registered";
      classIds?: string[];
      discoverable?: boolean;
    };

    const result = await identifyCaller(body);
    if (!result.ok) {
      return c.json(
        { success: false, error: result.error, detail: result.detail }, result.status as any,
      );
    }

    if (!body.semesterId) {
      return c.json(
        { success: false, error: "semester_not_supported", detail: { detail: "semesterId is required" } }, 400);
    }

    const op = body.op || "get";
    const callerKey = result.caller.ownerKey;
    const pool = getDbPool();
    await ensureSocialSchema();

    if (op === "classes" || op === "get") {
      // Public-ish: return classes for semester
      const { rows } = await pool.query(
        `SELECT class_id, course_code, course_title, course_type, slot, faculty, credits, room, register_nos
           FROM ${FFCS_CLASSES_TABLE}
          WHERE semester_id = $1
          ORDER BY course_code, class_id`,
        [body.semesterId],
      );
      return c.json({
        success: true,
        semesterId: body.semesterId,
        classes: rows.map((r: any) => ({
          classId: r.class_id,
          courseCode: r.course_code || "",
          courseTitle: r.course_title || "",
          courseType: r.course_type || "",
          slot: r.slot || "",
          faculty: r.faculty || "",
          credits: r.credits || "",
          room: r.room || "",
          registerNos: r.register_nos || [],
          students: [],
        })),
      });
    }

    // Authenticated ops: publish, visibility, leave
    if (op === "publish") {
      if (body.source !== "registered") {
        return c.json(
          { success: false, error: "planned_sharing_disabled", detail: { detail: "Only 'registered' source is supported" } }, 400);
      }
      if (!body.classIds || !Array.isArray(body.classIds) || body.classIds.length === 0) {
        return c.json(
          { success: false, error: "no_registered_classes", detail: { detail: "No class IDs provided" } }, 422);
      }

      const discoverable = body.discoverable !== false;
      const now = Date.now();

      // Check change cap
      const { rows: existing } = await pool.query(
        `SELECT changes_in_window, window_started_at FROM ${FFCS_MATCH_TABLE} WHERE owner_key = $1 AND semester_id = $2`,
        [callerKey, body.semesterId],
      );

      let changesInWindow = 0;
      let windowStartedAt = now;
      if (existing.length) {
        const row = existing[0] as any;
        const windowStart = new Date(row.window_started_at).getTime();
        if (now - windowStart > 86400000) {
          changesInWindow = 1;
          windowStartedAt = now;
        } else {
          changesInWindow = Number(row.changes_in_window) + 1;
          windowStartedAt = windowStart;
        }
        if (changesInWindow > MAX_CHANGES_PER_DAY) {
          return c.json(
            { success: false, error: "change_limit", detail: { detail: "Daily change limit reached" } }, 429);
        }
      }

      await pool.query(
        `INSERT INTO ${FFCS_MATCH_TABLE}
           (owner_key, semester_id, class_ids, source, discoverable, register_no, display_name, changes_in_window, window_started_at)
         VALUES ($1, $2, $3::text[], $4, $5, $6, $7, $8, $9)
         ON CONFLICT (owner_key, semester_id) DO UPDATE SET
           class_ids = EXCLUDED.class_ids,
           source = EXCLUDED.source,
           discoverable = EXCLUDED.discoverable,
           register_no = CASE WHEN EXCLUDED.register_no <> '' THEN EXCLUDED.register_no ELSE ${FFCS_MATCH_TABLE}.register_no END,
           display_name = CASE WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name ELSE ${FFCS_MATCH_TABLE}.display_name END,
           changes_in_window = EXCLUDED.changes_in_window,
           window_started_at = EXCLUDED.window_started_at,
           updated_at = NOW()`,
        [callerKey, body.semesterId, body.classIds, "registered", discoverable, result.caller.regNo, result.caller.displayName, changesInWindow, new Date(windowStartedAt).toISOString()],
      );

      // Register classes
      await pool.query(
        `INSERT INTO ${FFCS_CLASSES_TABLE} (semester_id, class_id)
         SELECT $1, id FROM UNNEST($2::text[]) AS id
         ON CONFLICT (semester_id, class_id) DO NOTHING`,
        [body.semesterId, body.classIds],
      );
      await pool.query(
        `DELETE FROM ${FFCS_CLASS_REGISTRATIONS_TABLE}
         WHERE semester_id = $1 AND register_no = $2`,
        [body.semesterId, result.caller.regNo],
      );
      if (body.classIds.length > 0) {
        await pool.query(
          `INSERT INTO ${FFCS_CLASS_REGISTRATIONS_TABLE}
             (semester_id, class_id, register_no, display_name, handle, owner_key, discoverable, updated_at)
           SELECT $1, id, $2, $3, $4, $5, $6, NOW()
             FROM UNNEST($7::text[]) AS id
           ON CONFLICT (semester_id, class_id, register_no) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             handle = EXCLUDED.handle,
             owner_key = EXCLUDED.owner_key,
             discoverable = EXCLUDED.discoverable,
             updated_at = NOW()`,
          [body.semesterId, result.caller.regNo, result.caller.displayName, generateHandle(result.caller.regNo), callerKey, discoverable, body.classIds],
        );
      }

      return c.json({
        success: true,
        semesterId: body.semesterId,
        participants: 0,
        me: {
          handle: generateHandle(result.caller.regNo),
          name: result.caller.displayName,
          joined: true,
          discoverable,
          source: "registered",
          classIds: body.classIds,
          updatedAt: new Date().toISOString(),
          changesLeft: MAX_CHANGES_PER_DAY - changesInWindow,
        },
        sections: [],
        overlaps: [],
      });
    }

    if (op === "visibility") {
      if (typeof body.discoverable !== "boolean") {
        return c.json(
          { success: false, error: "invalid_visibility", detail: { detail: "discoverable is required" } }, 400);
      }
      await pool.query(
        `UPDATE ${FFCS_MATCH_TABLE} SET discoverable = $1 WHERE owner_key = $2 AND semester_id = $3`,
        [body.discoverable, callerKey, body.semesterId],
      );
      return c.json({ success: true, semesterId: body.semesterId, discoverable: body.discoverable });
    }

    if (op === "leave") {
      await pool.query(
        `DELETE FROM ${FFCS_MATCH_TABLE} WHERE owner_key = $1 AND semester_id = $2`,
        [callerKey, body.semesterId],
      );
      await pool.query(
        `DELETE FROM ${FFCS_CLASS_REGISTRATIONS_TABLE} WHERE semester_id = $1 AND register_no = $2`,
        [body.semesterId, result.caller.regNo],
      );
      return c.json({ success: true, semesterId: body.semesterId, left: true });
    }

    return c.json({ success: false, error: "invalid_op", detail: { detail: "Unknown op" } }, 400);
  } catch (err: unknown) {
    console.error("[social] ffc-match POST error:", err);
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});




/**
 * GET/POST /api/services/social/ffcs-match — FFCS friend finder.
 *
 * GET ?semesterId=&classIds= — discoverable class rosters (Amaze ID required)
 * POST { cookies?, authorizedID?, csrf?, semesterId, op, source?, discoverable? }
 *   op: get | publish | visibility | leave | classes
 * POST accepts a linked Amaze ID, a verified VTOP session, or both. VTOP
 * session fields are required only to refresh a new semester enrollment.
 */
import { Hono } from "hono";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import {
  identifyCaller,
  ensureSocialSchema,
  FFCS_MATCH_TABLE,
  FFCS_CLASSES_TABLE,
  FFCS_CLASS_REGISTRATIONS_TABLE,
  generateHandle,
  migrateLegacyOwnerKeyForRegister,
  regKey,
} from "../../../../src/lib/social";
import { getDbPool } from "../../../../src/lib/db";
import { verifyAmazeSession } from "../../../../src/lib/amazeId";
import {
  ensureStudentProfilesSchema,
  getStudentProfileByRegNo,
  upsertStudentProfile,
} from "../../../../src/lib/student-profiles";
import fetchTimetable from "../../../../src/lib/fetchTimeTable";
import type { courseItem } from "../../../../src/types/data/attendance";

const MAX_CHANGES_PER_DAY = 3;
const MAX_REGISTERED_CLASSES = 30;
const CLASS_ID_RE = /^CH\d{13}$/;

type MatchCaller = {
  ownerKey: string;
  regNo: string;
  displayName: string;
  handle: string;
  cookies?: string;
  authorizedID?: string;
  csrf?: string;
};

type MatchBody = {
  cookies?: string | string[];
  authorizedID?: string;
  csrf?: string;
  semesterId?: string;
  op?: "get" | "publish" | "visibility" | "leave" | "classes";
  source?: "registered";
  classIds?: string[];
  discoverable?: boolean;
};

function errorResult(status: number, error: string, detail: string) {
  return { ok: false as const, status, error, detail: { detail } };
}

/** Resolve the caller from Amaze ID when linked, or a verified VTOP session. */
async function resolveMatchCaller(req: Request, body: MatchBody) {
  const amazeIdentity = await verifyAmazeSession(req);
  const hasVtopSession = Boolean(body.cookies && body.authorizedID && body.csrf);
  let vtopCaller: Extract<Awaited<ReturnType<typeof identifyCaller>>, { ok: true }>["caller"] | null = null;

  if (hasVtopSession) {
    const result = await identifyCaller(body);
    if (result.ok) vtopCaller = result.caller;
    else if (!amazeIdentity?.vtopRegNo) return result;
  }

  const linkedRegNo = amazeIdentity?.vtopRegNo?.trim().toUpperCase();
  if (linkedRegNo) {
    if (vtopCaller && vtopCaller.regNo.toUpperCase() !== linkedRegNo) {
      return errorResult(403, "identity_mismatch", "The VTOP session belongs to a different student than this Amaze ID.");
    }
    await ensureStudentProfilesSchema();
    const profile = await getStudentProfileByRegNo(linkedRegNo);
    const displayName = vtopCaller?.displayName || profile?.display_name || amazeIdentity?.name || "";
    return {
      ok: true as const,
      caller: {
        ownerKey: regKey(linkedRegNo),
        regNo: linkedRegNo,
        displayName,
        handle: generateHandle(linkedRegNo),
        ...(vtopCaller
          ? {
              cookies: vtopCaller.cookies,
              authorizedID: vtopCaller.authorizedID,
              csrf: vtopCaller.csrf,
            }
          : {}),
      } satisfies MatchCaller,
    };
  }

  if (vtopCaller) {
    return {
      ok: true as const,
      caller: {
        ...vtopCaller,
        handle: generateHandle(vtopCaller.regNo),
      } satisfies MatchCaller,
    };
  }

  if (amazeIdentity) {
    return errorResult(401, "vtop_session_required", "This Amaze ID is not linked to a VTOP registration number. Sign in with VTOP to continue.");
  }
  return errorResult(401, "missing_credentials", "Sign in with Amaze ID or provide a valid VTOP session.");
}

function offeringFromTimetable(course: courseItem) {
  const rawTitle = course.course.trim();
  const code = course.courseCode.replace(/\([TL]\)$/i, "").trim() || rawTitle.split(/\s+/)[0] || "";
  const title = rawTitle.replace(new RegExp(`^${code}\\s*[-:]?\\s*`, "i"), "").trim() || rawTitle;
  const normalized = rawTitle.toLowerCase();
  const type = normalized.includes("embedded theory")
    ? "ETH"
    : normalized.includes("embedded lab")
      ? "ELA"
      : normalized.includes("lab only")
        ? "LO"
        : normalized.includes("theory only")
          ? "TH"
          : /\(L\)$/i.test(course.courseCode)
            ? "LO"
            : "TH";
  const slotAndRoom = course.slotVenue.trim().split(/\s+/);
  return {
    code,
    title,
    type,
    credits: course.LTPJC.trim().split(/\s+/)[4] || "",
    slot: slotAndRoom.shift() || "",
    room: slotAndRoom.join(" "),
    faculty: course.facultyDetails.trim(),
  };
}

/** Use the same VTOP timetable source as /attendance and persist this student's semester enrollments. */
async function syncRegisteredClasses(caller: MatchCaller, semesterId: string): Promise<string[]> {
  if (!caller.cookies || !caller.authorizedID || !caller.csrf) return [];
  const courses = await fetchTimetable(caller.cookies, caller.authorizedID, caller.csrf, semesterId);
  const validCourses = courses
    .filter((course) => CLASS_ID_RE.test(course.classId.trim().toUpperCase()) && course.classId.trim().toUpperCase().startsWith(semesterId))
    .slice(0, MAX_REGISTERED_CLASSES);
  if (!validCourses.length) return [];
  const pool = getDbPool();
  const classIds: string[] = [];
  await pool.query(
    `DELETE FROM ${FFCS_CLASS_REGISTRATIONS_TABLE}
      WHERE semester_id = $1 AND UPPER(register_no) = ANY($2::text[])`,
    [semesterId, [...new Set([caller.regNo, caller.authorizedID].filter(Boolean).map((value) => value!.toUpperCase()))]],
  );
  await pool.query(
    `UPDATE ${FFCS_CLASSES_TABLE}
        SET register_nos = array_remove(array_remove(register_nos, $1), $2), updated_at = NOW()
      WHERE semester_id = $3`,
    [caller.regNo, caller.authorizedID ?? "", semesterId],
  );

  for (const course of validCourses) {
    const classId = course.classId.trim().toUpperCase();
    const offering = offeringFromTimetable(course);
    classIds.push(classId);
    await pool.query(
      `INSERT INTO ${FFCS_CLASSES_TABLE}
         (semester_id, class_id, course_code, course_title, course_type, slot, faculty, credits, room, register_nos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ARRAY[$10]::text[])
       ON CONFLICT (semester_id, class_id) DO UPDATE SET
         course_code = EXCLUDED.course_code,
         course_title = EXCLUDED.course_title,
         course_type = EXCLUDED.course_type,
         slot = EXCLUDED.slot,
         faculty = EXCLUDED.faculty,
         credits = EXCLUDED.credits,
         room = EXCLUDED.room,
         register_nos = ARRAY(SELECT DISTINCT value FROM UNNEST(${FFCS_CLASSES_TABLE}.register_nos || EXCLUDED.register_nos) AS value),
         updated_at = NOW()`,
      [semesterId, classId, offering.code, offering.title, offering.type, offering.slot, offering.faculty, offering.credits, offering.room, caller.regNo],
    );
    await pool.query(
      `INSERT INTO ${FFCS_CLASS_REGISTRATIONS_TABLE}
         (semester_id, class_id, register_no, display_name, handle, owner_key, discoverable, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW())
       ON CONFLICT (semester_id, class_id, register_no) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         handle = EXCLUDED.handle,
         owner_key = EXCLUDED.owner_key,
         updated_at = NOW()`,
      [semesterId, classId, caller.regNo, caller.displayName, caller.handle, caller.ownerKey],
    );
  }
  return [...new Set(classIds)].sort().slice(0, MAX_REGISTERED_CLASSES);
}

async function enrolledClassIds(caller: MatchCaller, semesterId: string): Promise<string[]> {
  const identifiers = [...new Set([caller.regNo, caller.authorizedID].filter(Boolean).map((value) => value!.toUpperCase()))];
  const { rows } = await getDbPool().query(
    `SELECT class_id FROM ${FFCS_CLASS_REGISTRATIONS_TABLE}
      WHERE semester_id = $1 AND UPPER(register_no) = ANY($2::text[])
      ORDER BY class_id`,
    [semesterId, identifiers],
  );
  return rows.map((row: any) => String(row.class_id).toUpperCase());
}

/** Build the response shape consumed by the Friend Finder client. */
async function buildMatchState(caller: MatchCaller, semesterId: string) {
  const pool = getDbPool();
  const [entryResult, participantResult] = await Promise.all([
    pool.query(
      `SELECT class_ids, source, discoverable, changes_in_window, window_started_at, updated_at
         FROM ${FFCS_MATCH_TABLE} WHERE owner_key = $1 AND semester_id = $2`,
      [caller.ownerKey, semesterId],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM ${FFCS_MATCH_TABLE} WHERE semester_id = $1`,
      [semesterId],
    ),
  ]);
  const entry = entryResult.rows[0] as any;
  const classIds = entry?.class_ids ?? [];
  const discoverable = Boolean(entry?.discoverable);
  const candidatesResult = entry && discoverable && classIds.length
    ? await pool.query(
        `SELECT owner_key, register_no, display_name, class_ids, source, updated_at
           FROM ${FFCS_MATCH_TABLE}
          WHERE semester_id = $1 AND owner_key <> $2 AND discoverable = TRUE
            AND class_ids && $3::text[]`,
        [semesterId, caller.ownerKey, classIds],
      )
    : { rows: [] as any[] };
  const classesResult = classIds.length
    ? await pool.query(
        `SELECT class_id, course_code, course_title, course_type, slot, faculty, credits, room
           FROM ${FFCS_CLASSES_TABLE}
          WHERE semester_id = $1 AND class_id = ANY($2::text[])`,
        [semesterId, classIds],
      )
    : { rows: [] as any[] };

  const meSet = new Set<string>(classIds);
  const peopleByClass = new Map<string, any[]>(classIds.map((classId: string) => [classId, []]));
  const overlaps: any[] = [];
  for (const candidate of candidatesResult.rows as any[]) {
    const otherIds: string[] = candidate.class_ids ?? [];
    const sharedClassIds = otherIds.filter((id) => meSet.has(id));
    if (!sharedClassIds.length) continue;
    const person = {
      handle: generateHandle(candidate.register_no),
      name: candidate.display_name || "",
      regNo: candidate.register_no || "",
      source: candidate.source || "registered",
    };
    for (const classId of sharedClassIds) peopleByClass.get(classId)?.push(person);
    const identical = sharedClassIds.length === classIds.length && otherIds.length === classIds.length;
    if (sharedClassIds.length >= 2 || identical) {
      overlaps.push({
        ...person,
        shared: sharedClassIds.length,
        sharedClassIds,
        identical,
        updatedAt: new Date(candidate.updated_at).toISOString(),
      });
    }
  }
  overlaps.sort((a, b) => Number(b.identical) - Number(a.identical) || b.shared - a.shared || a.name.localeCompare(b.name));

  const offerings = new Map((classesResult.rows as any[]).map((row) => [row.class_id, row]));
  const sections = classIds.map((classId: string) => {
    const row = offerings.get(classId) as any;
    const people = peopleByClass.get(classId) ?? [];
    return {
      classId,
      offering: row
        ? {
            classId,
            code: row.course_code || "",
            title: row.course_title || "",
            type: row.course_type || "",
            credits: row.credits || "",
            room: row.room || "",
            slot: row.slot || "",
            faculty: row.faculty || "",
          }
        : null,
      registerNos: people.map((person) => person.regNo).filter(Boolean),
      people,
    };
  });
  const windowStart = entry?.window_started_at ? new Date(entry.window_started_at).getTime() : 0;
  const expired = !windowStart || Date.now() - windowStart >= 86_400_000;
  const changesLeft = !entry || expired
    ? MAX_CHANGES_PER_DAY
    : Math.max(0, MAX_CHANGES_PER_DAY - Number(entry.changes_in_window));

  return {
    success: true,
    semesterId,
    participants: Number(participantResult.rows[0]?.count ?? 0),
    me: {
      handle: caller.handle,
      name: caller.displayName,
      joined: Boolean(entry),
      discoverable,
      source: entry?.source ?? null,
      classIds,
      updatedAt: entry?.updated_at ? new Date(entry.updated_at).toISOString() : null,
      changesLeft,
    },
    sections,
    overlaps: overlaps.slice(0, 50),
  };
}

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
      SELECT c.class_id, c.course_code, c.course_title, c.course_type, c.slot, c.faculty, c.credits, c.room,
             COALESCE(
               json_agg(json_build_object('regNo', r.register_no, 'name', r.display_name, 'handle', r.handle))
               FILTER (WHERE r.register_no IS NOT NULL AND r.discoverable AND m.owner_key IS NOT NULL),
               '[]'::json) AS students
      FROM ${FFCS_CLASSES_TABLE} c
      LEFT JOIN ${FFCS_CLASS_REGISTRATIONS_TABLE} r
        ON r.semester_id = c.semester_id AND r.class_id = c.class_id
      LEFT JOIN ${FFCS_MATCH_TABLE} m
        ON m.semester_id = c.semester_id AND m.owner_key = r.owner_key
       AND m.discoverable = TRUE AND c.class_id = ANY(m.class_ids)
      WHERE c.semester_id = $1`;
    const paramsArr: any[] = [semesterId];

    if (classIdsParam) {
      const classIds = classIdsParam.split(",").filter(Boolean);
      query += ` AND c.class_id = ANY($2)`;
      paramsArr.push(classIds);
    }
    query += ` GROUP BY c.class_id, c.course_code, c.course_title, c.course_type, c.slot, c.faculty, c.credits, c.room
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
        students: r.students || [],
      })),
    });
  } catch (err: unknown) {
    console.error("[social] ffc-match GET error:", err);
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});

// POST: supports Amaze ID or a verified VTOP session.
socialFfcsMatchRouter.post("/ffcs-match", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as MatchBody;
    const semesterId = body.semesterId?.trim().toUpperCase();
    if (!semesterId) {
      return c.json({ success: false, error: "semester_not_supported", detail: { detail: "semesterId is required" } }, 400);
    }
    const op = body.op || "get";
    if (!["get", "publish", "visibility", "leave", "classes"].includes(op)) {
      return c.json({ success: false, error: "invalid_op", detail: { detail: "Unknown friend finder operation" } }, 400);
    }

    const pool = getDbPool();
    await ensureSocialSchema();
    await ensureStudentProfilesSchema();
    if (op === "classes") {
      const { rows } = await pool.query(
        `SELECT class_id, course_code, course_title, course_type, slot, faculty, credits, room
           FROM ${FFCS_CLASSES_TABLE} WHERE semester_id = $1 ORDER BY course_code, class_id`,
        [semesterId],
      );
      return c.json({
        success: true,
        semesterId,
        classes: rows.map((row: any) => ({
          classId: row.class_id,
          courseCode: row.course_code || "",
          courseTitle: row.course_title || "",
          courseType: row.course_type || "",
          slot: row.slot || "",
          faculty: row.faculty || "",
          credits: row.credits || "",
          room: row.room || "",
          students: [],
        })),
      });
    }
    const resolution = await resolveMatchCaller(c.req.raw, body);
    if (!resolution.ok) {
      return c.json({ success: false, error: resolution.error, detail: resolution.detail }, resolution.status as any);
    }
    const caller = resolution.caller;
    await migrateLegacyOwnerKeyForRegister(caller.regNo);
    await upsertStudentProfile(caller.regNo, {
      display_name: caller.displayName,
      semester_id: semesterId,
    });
    if (op === "get") return c.json(await buildMatchState(caller, semesterId));

    if (op === "publish") {
      if (body.source !== "registered") {
        return c.json({ success: false, error: "planned_sharing_disabled", detail: { detail: "Only registered VTOP timetables can be shared." } }, 400);
      }
      // Refresh this semester from VTOP just like /attendance. When Amaze ID is
      // used without VTOP credentials, reuse an earlier attendance enrollment.
      let classIds: string[] = [];
      if (caller.cookies && caller.authorizedID && caller.csrf) {
        try {
          classIds = await syncRegisteredClasses(caller, semesterId);
        } catch (err) {
          console.warn("[social] timetable refresh failed:", err instanceof Error ? err.message : String(err));
          classIds = await enrolledClassIds(caller, semesterId);
        }
      } else {
        classIds = await enrolledClassIds(caller, semesterId);
      }
      if (!classIds.length) {
        const needsVtop = !caller.cookies;
        return c.json({
          success: false,
          error: needsVtop ? "vtop_session_required" : "no_registered_classes",
          detail: {
            detail: needsVtop
              ? "Sign in with VTOP and load attendance for this semester before enrolling."
              : "VTOP shows no registered classes for this semester yet.",
          },
        }, 422);
      }

      const discoverable = body.discoverable !== false;
      const now = Date.now();
      const { rows: existing } = await pool.query(
        "SELECT class_ids, changes_in_window, window_started_at FROM ffcs_match_entries WHERE owner_key = $1 AND semester_id = $2",
        [caller.ownerKey, semesterId],
      );
      let changesInWindow = 1;
      let windowStartedAt = now;
      if (existing.length) {
        const row = existing[0] as any;
        const startedAt = new Date(row.window_started_at).getTime();
        const unchanged = JSON.stringify([...(row.class_ids || [])].sort()) === JSON.stringify([...classIds].sort());
        if (now - startedAt < 86_400_000) {
          changesInWindow = Number(row.changes_in_window) + (unchanged ? 0 : 1);
          windowStartedAt = startedAt;
        }
        if (changesInWindow > MAX_CHANGES_PER_DAY) {
          return c.json({ success: false, error: "change_limit", detail: { detail: "Daily change limit reached." } }, 429);
        }
      }
      await pool.query(
        "INSERT INTO ffcs_match_entries " +
          "(owner_key, semester_id, class_ids, source, discoverable, register_no, display_name, changes_in_window, window_started_at) " +
          "VALUES ($1, $2, $3::text[], 'registered', $4, $5, $6, $7, $8) " +
          "ON CONFLICT (owner_key, semester_id) DO UPDATE SET " +
          "class_ids = EXCLUDED.class_ids, source = EXCLUDED.source, discoverable = EXCLUDED.discoverable, " +
          "register_no = EXCLUDED.register_no, display_name = EXCLUDED.display_name, " +
          "changes_in_window = EXCLUDED.changes_in_window, window_started_at = EXCLUDED.window_started_at, updated_at = NOW()",
        [caller.ownerKey, semesterId, classIds, discoverable, caller.regNo, caller.displayName, changesInWindow, new Date(windowStartedAt).toISOString()],
      );
      await pool.query(
        "UPDATE ffcs_class_registrations SET discoverable = $1, display_name = $2, handle = $3, owner_key = $4, updated_at = NOW() " +
          "WHERE semester_id = $5 AND UPPER(register_no) = $6",
        [discoverable, caller.displayName, caller.handle, caller.ownerKey, semesterId, caller.regNo.toUpperCase()],
      );
      return c.json(await buildMatchState(caller, semesterId));
    }

    if (op === "visibility") {
      if (typeof body.discoverable !== "boolean") {
        return c.json({ success: false, error: "invalid_visibility", detail: { detail: "discoverable is required" } }, 400);
      }
      const updated = await pool.query(
        "UPDATE ffcs_match_entries SET discoverable = $1, updated_at = NOW() " +
          "WHERE owner_key = $2 AND semester_id = $3 RETURNING owner_key",
        [body.discoverable, caller.ownerKey, semesterId],
      );
      if (!updated.rows.length) {
        return c.json({ success: false, error: "not_joined", detail: { detail: "Share your classes first." } }, 404);
      }
      await pool.query(
        "UPDATE ffcs_class_registrations SET discoverable = $1, updated_at = NOW() " +
          "WHERE semester_id = $2 AND UPPER(register_no) = $3",
        [body.discoverable, semesterId, caller.regNo.toUpperCase()],
      );
      return c.json(await buildMatchState(caller, semesterId));
    }

    if (op === "leave") {
      await pool.query("DELETE FROM ffcs_match_entries WHERE owner_key = $1 AND semester_id = $2", [caller.ownerKey, semesterId]);
      await pool.query(
        "DELETE FROM ffcs_class_registrations WHERE semester_id = $1 AND UPPER(register_no) = $2",
        [semesterId, caller.regNo.toUpperCase()],
      );
      await pool.query(
        "UPDATE ffcs_classes SET register_nos = array_remove(register_nos, $1), updated_at = NOW() " +
          "WHERE semester_id = $2 AND $1 = ANY(register_nos)",
        [caller.regNo, semesterId],
      );
      return c.json(await buildMatchState(caller, semesterId));
    }

    return c.json({ success: false, error: "invalid_op", detail: { detail: "Unknown friend finder operation" } }, 400);
  } catch (err: unknown) {
    console.error("[social] ffc-match POST error:", err);
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});


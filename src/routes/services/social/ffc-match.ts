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
import { getWorkerEnv } from "../../../../src/env";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import {
  identifyCaller,
  generateHandle,
  getSocialHandlesForRegister,
  regKey,
  FFCS_CLASSES_TABLE,
  FFCS_CLASS_REGISTRATIONS_TABLE,
} from "../../../../src/lib/social";
import {
  type FfcsClassRow,
  type FfcsRegistrationRow,
  type FfcsMatchRow,
  ensureFfcsSemesterInD1,
  migrateD1FfcsOwnerKey,
  migrateD1SocialOwnerKey,
  readD1Classes,
  readD1Registrations,
  readD1Matches,
  readD1Match,
  saveD1Match,
  setD1MatchVisibilityAndRegistration,
  updateD1RegistrationIdentity,
  upsertD1RegisteredClasses,
  removeD1Match,
} from "../../../../src/lib/socialD1";
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
  await ensureFfcsSemesterInD1(semesterId);
  const classIds: string[] = [];
  const mappedCourses = validCourses.map((course) => {
    const classId = course.classId.trim().toUpperCase();
    const offering = offeringFromTimetable(course);
    classIds.push(classId);
    return {
      classId,
      courseCode: offering.code,
      courseTitle: offering.title,
      courseType: offering.type,
      slot: offering.slot,
      faculty: offering.faculty,
      credits: offering.credits,
      room: offering.room,
    };
  });
  await upsertD1RegisteredClasses({
    semesterId,
    ownerKey: caller.ownerKey,
    registerNo: caller.regNo,
    authorizedID: caller.authorizedID,
    displayName: caller.displayName,
    handle: caller.handle,
    courses: mappedCourses,
  });
  return [...new Set(classIds)].sort().slice(0, MAX_REGISTERED_CLASSES);
}

async function enrolledClassIds(caller: MatchCaller, semesterId: string): Promise<string[]> {
  const identifiers = [...new Set([caller.regNo, caller.authorizedID].filter(Boolean).map((value) => value!.trim().toUpperCase()))];
  if (!identifiers.length) return [];
  await ensureFfcsSemesterInD1(semesterId);
  const db = getWorkerEnv().APP_DB;
  if (!db) return [];
  const placeholders = identifiers.map(() => "?").join(", ");
  const { results } = await db.prepare(`SELECT DISTINCT class_id FROM ${FFCS_CLASS_REGISTRATIONS_TABLE}
    WHERE semester_id = ? AND register_no IN (${placeholders})`)
    .bind(semesterId, ...identifiers).all<{ class_id: string }>();
  return results.map((row) => String(row.class_id).toUpperCase()).sort();
}

/** Build the response shape consumed by the Friend Finder client. */
async function buildMatchState(caller: MatchCaller, semesterId: string) {
  await ensureFfcsSemesterInD1(semesterId);
  const entries = await readD1Matches(semesterId);
  const entry = entries.find((row) => row.owner_key === caller.ownerKey);
  const classIds: string[] = entry?.class_ids ?? [];
  const participantCount = entries.length;
  const discoverable = Boolean(entry?.discoverable);
  const meSet = new Set(classIds);
  const candidates = entry && discoverable
    ? entries.filter((row) => row.owner_key !== caller.ownerKey && row.discoverable
      && row.class_ids.some((classId) => meSet.has(classId)))
    : [];

  const db = getWorkerEnv().APP_DB;
  let offerings = new Map<string, FfcsClassRow>();
  if (db && classIds.length > 0) {
    const placeholders = classIds.map(() => "?").join(", ");
    const { results } = await db.prepare(`SELECT * FROM ${FFCS_CLASSES_TABLE}
      WHERE semester_id = ? AND class_id IN (${placeholders})`)
      .bind(semesterId, ...classIds)
      .all<Omit<FfcsClassRow, "register_nos"> & { register_nos: string }>();
    offerings = new Map(results.map((row) => [row.class_id, {
      ...row,
      register_nos: JSON.parse(row.register_nos || "[]") as string[],
    }]));
  }
  const peopleByClass = new Map<string, any[]>(classIds.map((classId) => [classId, []]));
  const overlaps: any[] = [];
  for (const candidate of candidates) {
    const otherIds = candidate.class_ids ?? [];
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
  const sections = classIds.map((classId) => {
    const row = offerings.get(classId);
    const people = peopleByClass.get(classId) ?? [];
    return {
      classId,
      offering: row ? {
        classId,
        code: row.course_code || "",
        title: row.course_title || "",
        type: row.course_type || "",
        credits: row.credits || "",
        room: row.room || "",
        slot: row.slot || "",
        faculty: row.faculty || "",
      } : null,
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
    handles: await getSocialHandlesForRegister(caller.regNo),
    participants: participantCount,
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
    const semesterId = params.get("semesterId")?.trim().toUpperCase();
    const classIdsParam = params.get("classIds");
    if (!semesterId) {
      return c.json({ success: false, error: "semester_not_supported", detail: { detail: "semesterId is required" } }, 400);
    }

    await ensureFfcsSemesterInD1(semesterId);
    const requestedIds = classIdsParam
      ? [...new Set(classIdsParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))]
      : null;
    const db = getWorkerEnv().APP_DB;

    let classes: FfcsClassRow[];
    let registrations: FfcsRegistrationRow[];
    let entries: FfcsMatchRow[];

    if (db && requestedIds && requestedIds.length > 0) {
      const placeholders = requestedIds.map(() => "?").join(", ");
      const [classesRes, regRes, matchRes] = await Promise.all([
        db.prepare(`SELECT * FROM ${FFCS_CLASSES_TABLE}
          WHERE semester_id = ? AND class_id IN (${placeholders})
          ORDER BY course_code, class_id`)
          .bind(semesterId, ...requestedIds)
          .all<Omit<FfcsClassRow, "register_nos"> & { register_nos: string }>(),
        db.prepare(`SELECT * FROM ${FFCS_CLASS_REGISTRATIONS_TABLE}
          WHERE semester_id = ? AND class_id IN (${placeholders})
          ORDER BY class_id, register_no`)
          .bind(semesterId, ...requestedIds)
          .all<Omit<FfcsRegistrationRow, "discoverable"> & { discoverable: number }>(),
        readD1Matches(semesterId),
      ]);
      classes = classesRes.results.map((row) => ({
        ...row,
        register_nos: JSON.parse(row.register_nos || "[]") as string[],
      }));
      registrations = regRes.results.map((row) => ({
        ...row,
        discoverable: Boolean(row.discoverable),
      }));
      entries = matchRes;
    } else {
      [classes, registrations, entries] = await Promise.all([
        readD1Classes(semesterId),
        readD1Registrations(semesterId),
        readD1Matches(semesterId),
      ]);
    }
    const discoverableOwners = new Set(entries.filter((entry) => entry.discoverable).map((entry) => entry.owner_key));
    const registrationsByClass = new Map<string, FfcsRegistrationRow[]>();
    for (const registration of registrations) {
      if (!registration.discoverable || !discoverableOwners.has(registration.owner_key)) continue;
      const current = registrationsByClass.get(registration.class_id) ?? [];
      current.push(registration);
      registrationsByClass.set(registration.class_id, current);
    }
    const requestedSet = requestedIds ? new Set(requestedIds) : null;
    const resultClasses = classes
      .filter((row) => !requestedSet || requestedSet.has(row.class_id))
      .map((row) => ({
        classId: row.class_id,
        courseCode: row.course_code || "",
        courseTitle: row.course_title || "",
        courseType: row.course_type || "",
        slot: row.slot || "",
        faculty: row.faculty || "",
        credits: row.credits || "",
        room: row.room || "",
        students: (registrationsByClass.get(row.class_id) ?? []).map((person) => ({
          regNo: person.register_no,
          name: person.display_name,
          handle: person.handle,
        })),
      }));
    return c.json({ success: true, semesterId, classes: resultClasses });
  } catch (err: unknown) {
    console.error("[social] ffc-match GET error:", err);
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});

// POST: supports Amaze ID or a verified VTOP session.
socialFfcsMatchRouter.post("/ffcs-match", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as MatchBody;
    const semesterId = typeof body.semesterId === "string" ? body.semesterId.trim().toUpperCase() : undefined;
    if (!semesterId) {
      return c.json({ success: false, error: "semester_not_supported", detail: { detail: "semesterId is required" } }, 400);
    }
    const op = body.op || "get";
    if (!["get", "publish", "visibility", "leave", "classes"].includes(op)) {
      return c.json({ success: false, error: "invalid_op", detail: { detail: "Unknown friend finder operation" } }, 400);
    }
    await ensureFfcsSemesterInD1(semesterId);

    if (op === "classes") {
      const classes = await readD1Classes(semesterId);
      return c.json({
        success: true,
        semesterId,
        classes: classes.map((row) => ({
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
    await migrateD1SocialOwnerKey(caller.regNo, caller.ownerKey);
    await migrateD1FfcsOwnerKey(caller.regNo, caller.ownerKey, semesterId);
    await ensureStudentProfilesSchema();
    await upsertStudentProfile(caller.regNo, {
      display_name: caller.displayName,
      semester_id: semesterId,
    });
    if (op === "get") return c.json(await buildMatchState(caller, semesterId));

    if (op === "publish") {
      if (body.source !== "registered") {
        return c.json({ success: false, error: "planned_sharing_disabled", detail: { detail: "Only registered VTOP timetables can be shared." } }, 400);
      }
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
          detail: { detail: needsVtop
            ? "Sign in with VTOP and load attendance for this semester before enrolling."
            : "VTOP shows no registered classes for this semester yet." },
        }, 422);
      }

      const discoverable = body.discoverable !== false;
      const now = Date.now();
      const existing = await readD1Match(caller.ownerKey, semesterId);
      let changesInWindow = 1;
      let windowStartedAt = now;
      if (existing) {
        const startedAt = new Date(existing.window_started_at).getTime();
        const unchanged = JSON.stringify([...existing.class_ids].sort()) === JSON.stringify([...classIds].sort());
        if (now - startedAt < 86_400_000) {
          changesInWindow = Number(existing.changes_in_window) + (unchanged ? 0 : 1);
          windowStartedAt = startedAt;
        }
        if (changesInWindow > MAX_CHANGES_PER_DAY) {
          return c.json({ success: false, error: "change_limit", detail: { detail: "Daily change limit reached." } }, 429);
        }
      }
      await saveD1Match({
        ownerKey: caller.ownerKey,
        semesterId,
        classIds,
        discoverable,
        registerNo: caller.regNo,
        displayName: caller.displayName,
        changesInWindow,
        windowStartedAt: new Date(windowStartedAt).toISOString(),
      });
      await updateD1RegistrationIdentity({
        ownerKey: caller.ownerKey,
        semesterId,
        registerNo: caller.regNo,
        displayName: caller.displayName,
        handle: caller.handle,
        discoverable,
      });
      return c.json(await buildMatchState(caller, semesterId));
    }

    if (op === "visibility") {
      if (typeof body.discoverable !== "boolean") {
        return c.json({ success: false, error: "invalid_visibility", detail: { detail: "discoverable is required" } }, 400);
      }
      const updated = await setD1MatchVisibilityAndRegistration(
        caller.ownerKey, semesterId, caller.regNo, body.discoverable,
      );
      if (!updated) {
        return c.json({ success: false, error: "not_joined", detail: { detail: "Share your classes first." } }, 404);
      }
      return c.json(await buildMatchState(caller, semesterId));
    }

    if (op === "leave") {
      await removeD1Match({ ownerKey: caller.ownerKey, semesterId, registerNo: caller.regNo });
      return c.json(await buildMatchState(caller, semesterId));
    }

    return c.json({ success: false, error: "invalid_op", detail: { detail: "Unknown friend finder operation" } }, 400);
  } catch (err: unknown) {
    console.error("[social] ffc-match POST error:", err);
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});


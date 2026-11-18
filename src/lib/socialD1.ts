import { getWorkerEnv } from "../env";
import { HOUR, throttled } from "./edgeCache";
import {
  FFCS_CLASSES_TABLE,
  FFCS_CLASS_REGISTRATIONS_TABLE,
  FFCS_MATCH_TABLE,
  SOCIAL_HANDLE_ALIASES_TABLE,
  SOCIAL_TABLE,
  TIMETABLE_TABLE,
  generateHandle,
} from "./social";

export type FfcsClassRow = {
  semester_id: string;
  class_id: string;
  course_code: string;
  course_title: string;
  course_type: string;
  slot: string;
  faculty: string;
  credits: string;
  room: string;
  register_nos: string[];
  created_at: string;
  updated_at: string;
};

export type FfcsRegistrationRow = {
  semester_id: string;
  class_id: string;
  register_no: string;
  display_name: string;
  handle: string;
  owner_key: string;
  discoverable: boolean;
  created_at: string;
  updated_at: string;
};

export type FfcsMatchRow = {
  owner_key: string;
  semester_id: string;
  class_ids: string[];
  source: "planned" | "registered";
  discoverable: boolean;
  changes_in_window: number;
  window_started_at: string;
  created_at: string;
  updated_at: string;
  register_no: string;
  display_name: string;
};

const D1_BATCH_SIZE = 80;
const OWNER_MIGRATION_TTL = 6 * HOUR;

/** Return the service-data D1 binding; migrations own the social schema. */
export async function ensureSocialInD1(): Promise<D1Database> {
  const db = getWorkerEnv().APP_DB;
  if (!db) throw new Error("APP_DB is not configured");
  return db;
}

/** Canonicalize older plaintext register-number social owners in D1. */
export async function migrateD1SocialOwnerKey(registerNo: string, canonicalOwnerKey: string): Promise<void> {
  if (!getWorkerEnv().APP_DB) return;
  // One-time re-key that is a no-op once done; it ran on every ffc-match and
  // identity-sync request, so skip D1 for this owner for a while after it succeeds.
  await throttled("migrate-social-owner", `${registerNo.trim().toUpperCase()}|${canonicalOwnerKey}`,
    OWNER_MIGRATION_TTL, () => runMigrateD1SocialOwnerKey(registerNo, canonicalOwnerKey));
}

async function runMigrateD1SocialOwnerKey(registerNo: string, canonicalOwnerKey: string): Promise<void> {
  const db = getWorkerEnv().APP_DB;
  if (!db) return;
  const normalized = registerNo.trim().toUpperCase();
  const [people, timetableRows, grantKeys, enrollmentRows] = await Promise.all([
    db.prepare(`SELECT owner_key, handle FROM social_people
      WHERE UPPER(register_no) = ? OR UPPER(owner_key) = ?`).bind(normalized, normalized)
      .all<{ owner_key: string; handle: string }>(),
    db.prepare(`SELECT owner_key, semester_id FROM ${TIMETABLE_TABLE}
      WHERE UPPER(register_no) = ? OR UPPER(owner_key) = ?`).bind(normalized, normalized)
      .all<{ owner_key: string; semester_id: string }>(),
    db.prepare(`SELECT DISTINCT owner_a AS owner_key FROM ${SOCIAL_TABLE}
      WHERE UPPER(owner_a) = ? OR UPPER(owner_b) = ?
      UNION SELECT DISTINCT owner_b AS owner_key FROM ${SOCIAL_TABLE}
      WHERE UPPER(owner_a) = ? OR UPPER(owner_b) = ?`)
      .bind(normalized, normalized, normalized, normalized).all<{ owner_key: string }>(),
    db.prepare(`SELECT owner_key, service FROM service_enrollments
      WHERE UPPER(owner_key) = ?`).bind(normalized).all<{ owner_key: string; service: string }>(),
  ]);
  const oldKeys = new Set<string>([
    ...people.results.map((row) => row.owner_key),
    ...timetableRows.results.map((row) => row.owner_key),
    ...grantKeys.results.map((row) => row.owner_key),
    ...enrollmentRows.results.map((row) => row.owner_key),
    normalized,
  ].filter((key) => key && key !== canonicalOwnerKey));
  if (!oldKeys.size) return;

  const statements: D1PreparedStatement[] = [db.prepare(`INSERT OR IGNORE INTO ${SOCIAL_HANDLE_ALIASES_TABLE}
      (register_no, handle) VALUES (?, ?)`).bind(normalized, generateHandle(normalized))];
  for (const row of people.results) {
    if (row.handle) statements.push(db.prepare(`INSERT OR IGNORE INTO ${SOCIAL_HANDLE_ALIASES_TABLE}
      (register_no, handle) VALUES (?, ?)`).bind(normalized, row.handle));
  }

  for (const oldKey of oldKeys) {
    const oldPerson = people.results.find((row) => row.owner_key === oldKey);
    if (oldPerson) {
      const current = await db.prepare(`SELECT 1 FROM social_people WHERE owner_key = ?`).bind(canonicalOwnerKey).first();
      if (current) statements.push(db.prepare(`DELETE FROM social_people WHERE owner_key = ?`).bind(oldKey));
      else statements.push(db.prepare(`UPDATE social_people SET owner_key = ? WHERE owner_key = ?`)
        .bind(canonicalOwnerKey, oldKey));
    }
    for (const timetable of timetableRows.results.filter((row) => row.owner_key === oldKey)) {
      const current = await db.prepare(`SELECT 1 FROM ${TIMETABLE_TABLE} WHERE owner_key = ? AND semester_id = ?`)
        .bind(canonicalOwnerKey, timetable.semester_id).first();
      if (current) statements.push(db.prepare(`DELETE FROM ${TIMETABLE_TABLE} WHERE owner_key = ? AND semester_id = ?`)
        .bind(oldKey, timetable.semester_id));
      else statements.push(db.prepare(`UPDATE ${TIMETABLE_TABLE} SET owner_key = ? WHERE owner_key = ? AND semester_id = ?`)
        .bind(canonicalOwnerKey, oldKey, timetable.semester_id));
    }
    statements.push(db.prepare(`UPDATE ${SOCIAL_TABLE} SET owner_a = ? WHERE owner_a = ?`).bind(canonicalOwnerKey, oldKey));
    statements.push(db.prepare(`UPDATE ${SOCIAL_TABLE} SET owner_b = ? WHERE owner_b = ?`).bind(canonicalOwnerKey, oldKey));
    for (const enrollment of enrollmentRows.results.filter((row) => row.owner_key === oldKey)) {
      const current = await db.prepare(`SELECT 1 FROM service_enrollments WHERE owner_key = ? AND service = ?`)
        .bind(canonicalOwnerKey, enrollment.service).first();
      if (current) statements.push(db.prepare(`DELETE FROM service_enrollments WHERE owner_key = ? AND service = ?`)
        .bind(oldKey, enrollment.service));
      else statements.push(db.prepare(`UPDATE service_enrollments SET owner_key = ? WHERE owner_key = ? AND service = ?`)
        .bind(canonicalOwnerKey, oldKey, enrollment.service));
    }
  }
  for (let index = 0; index < statements.length; index += D1_BATCH_SIZE) {
    await db.batch(statements.slice(index, index + D1_BATCH_SIZE));
  }
}

/** Confirm D1 is configured and the requested semester key is valid. */
export async function ensureFfcsSemesterInD1(semesterId: string): Promise<boolean> {
  if (!getWorkerEnv().APP_DB) throw new Error("APP_DB is not configured");
  if (!semesterId.trim()) throw new Error("semesterId is required");
  return true;
}

export async function readD1Classes(semesterId: string): Promise<FfcsClassRow[]> {
  const db = getWorkerEnv().APP_DB;
  if (!db) return [];
  const { results } = await db.prepare(`SELECT * FROM ${FFCS_CLASSES_TABLE}
    WHERE semester_id = ? ORDER BY course_code, class_id`).bind(semesterId).all<Omit<FfcsClassRow, "register_nos"> & { register_nos: string }>();
  return results.map((row) => ({
    ...row,
    register_nos: JSON.parse(row.register_nos || "[]") as string[],
  }));
}

export async function readD1Registrations(semesterId: string): Promise<FfcsRegistrationRow[]> {
  const db = getWorkerEnv().APP_DB;
  if (!db) return [];
  const { results } = await db.prepare(`SELECT * FROM ${FFCS_CLASS_REGISTRATIONS_TABLE}
    WHERE semester_id = ? ORDER BY class_id, register_no`).bind(semesterId).all<Omit<FfcsRegistrationRow, "discoverable"> & { discoverable: number }>();
  return results.map((row) => ({ ...row, discoverable: Boolean(row.discoverable) }));
}

export async function readD1Matches(semesterId: string): Promise<FfcsMatchRow[]> {
  const db = getWorkerEnv().APP_DB;
  if (!db) return [];
  const { results } = await db.prepare(`SELECT * FROM ${FFCS_MATCH_TABLE}
    WHERE semester_id = ? ORDER BY owner_key`).bind(semesterId).all<Omit<FfcsMatchRow, "class_ids" | "discoverable"> & { class_ids: string; discoverable: number }>();
  return results.map((row) => ({
    ...row,
    class_ids: JSON.parse(row.class_ids || "[]") as string[],
    discoverable: Boolean(row.discoverable),
  }));
}

export async function readD1Match(ownerKey: string, semesterId: string): Promise<FfcsMatchRow | null> {
  const db = getWorkerEnv().APP_DB;
  if (!db) return null;
  const row = await db.prepare(`SELECT * FROM ${FFCS_MATCH_TABLE}
    WHERE owner_key = ? AND semester_id = ?`).bind(ownerKey, semesterId)
    .first<Omit<FfcsMatchRow, "class_ids" | "discoverable"> & { class_ids: string; discoverable: number }>();
  if (!row) return null;
  return {
    ...row,
    class_ids: JSON.parse(row.class_ids || "[]") as string[],
    discoverable: Boolean(row.discoverable),
  };
}

/** Re-key one semester's FFCS rows after the verified register number is canonicalized. */
export async function migrateD1FfcsOwnerKey(
  registerNo: string,
  canonicalOwnerKey: string,
  semesterId: string,
): Promise<void> {
  if (!getWorkerEnv().APP_DB) return;
  await throttled("migrate-ffcs-owner", `${registerNo.trim().toUpperCase()}|${canonicalOwnerKey}|${semesterId}`,
    OWNER_MIGRATION_TTL, () => runMigrateD1FfcsOwnerKey(registerNo, canonicalOwnerKey, semesterId));
}

async function runMigrateD1FfcsOwnerKey(
  registerNo: string,
  canonicalOwnerKey: string,
  semesterId: string,
): Promise<void> {
  const db = getWorkerEnv().APP_DB;
  if (!db) return;
  const normalized = registerNo.trim().toUpperCase();
  const oldKeys = await db.prepare(`SELECT DISTINCT owner_key FROM ${FFCS_CLASS_REGISTRATIONS_TABLE}
      WHERE semester_id = ? AND (UPPER(register_no) = ? OR UPPER(owner_key) = ?)
        AND owner_key <> ?`)
    .bind(semesterId, normalized, normalized, canonicalOwnerKey).all<{ owner_key: string }>();
  // Nothing to re-key (the usual case): don't read every match row in the semester.
  if (oldKeys.results.length === 0) return;
  const matchRows = await readD1Matches(semesterId);
  const statements: D1PreparedStatement[] = [];
  for (const { owner_key: oldKey } of oldKeys.results) {
    const oldMatch = matchRows.find((row) => row.owner_key === oldKey);
    const currentMatch = matchRows.find((row) => row.owner_key === canonicalOwnerKey);
    if (oldMatch && currentMatch) {
      const classIds = [...new Set([...currentMatch.class_ids, ...oldMatch.class_ids])];
      statements.push(db.prepare(`UPDATE ${FFCS_MATCH_TABLE}
        SET class_ids = ?, discoverable = ?, updated_at = ?
        WHERE owner_key = ? AND semester_id = ?`)
        .bind(JSON.stringify(classIds), currentMatch.discoverable || oldMatch.discoverable ? 1 : 0,
          currentMatch.updated_at > oldMatch.updated_at ? currentMatch.updated_at : oldMatch.updated_at,
          canonicalOwnerKey, semesterId));
      statements.push(db.prepare(`DELETE FROM ${FFCS_MATCH_TABLE} WHERE owner_key = ? AND semester_id = ?`)
        .bind(oldKey, semesterId));
    } else if (oldMatch) {
      statements.push(db.prepare(`UPDATE ${FFCS_MATCH_TABLE} SET owner_key = ? WHERE owner_key = ? AND semester_id = ?`)
        .bind(canonicalOwnerKey, oldKey, semesterId));
    }
    statements.push(db.prepare(`UPDATE ${FFCS_CLASS_REGISTRATIONS_TABLE}
      SET owner_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE semester_id = ? AND owner_key = ?`)
      .bind(canonicalOwnerKey, semesterId, oldKey));
  }
  if (statements.length) await db.batch(statements);
}

export async function saveD1Match(input: {
  ownerKey: string;
  semesterId: string;
  classIds: string[];
  discoverable: boolean;
  registerNo: string;
  displayName: string;
  changesInWindow: number;
  windowStartedAt: string;
}): Promise<void> {
  const db = getWorkerEnv().APP_DB;
  if (!db) return;
  await db.prepare(`INSERT INTO ${FFCS_MATCH_TABLE}
      (owner_key, semester_id, class_ids, source, discoverable, register_no,
       display_name, changes_in_window, window_started_at, updated_at)
    VALUES (?, ?, ?, 'registered', ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (owner_key, semester_id) DO UPDATE SET
      class_ids = excluded.class_ids,
      source = excluded.source,
      discoverable = excluded.discoverable,
      register_no = excluded.register_no,
      display_name = excluded.display_name,
      changes_in_window = excluded.changes_in_window,
      window_started_at = excluded.window_started_at,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .bind(input.ownerKey, input.semesterId, JSON.stringify(input.classIds),
      input.discoverable ? 1 : 0, input.registerNo, input.displayName,
      input.changesInWindow, input.windowStartedAt).run();
}

export async function updateD1MatchVisibility(
  ownerKey: string,
  semesterId: string,
  discoverable: boolean,
): Promise<boolean> {
  const db = getWorkerEnv().APP_DB;
  if (!db) return false;
  const result = await db.prepare(`UPDATE ${FFCS_MATCH_TABLE}
    SET discoverable = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE owner_key = ? AND semester_id = ?`)
    .bind(discoverable ? 1 : 0, ownerKey, semesterId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function updateD1RegistrationVisibility(
  semesterId: string,
  registerNo: string,
  discoverable: boolean,
): Promise<void> {
  const db = getWorkerEnv().APP_DB;
  if (!db) return;
  await db.prepare(`UPDATE ${FFCS_CLASS_REGISTRATIONS_TABLE}
    SET discoverable = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE semester_id = ? AND UPPER(register_no) = ?`)
    .bind(discoverable ? 1 : 0, semesterId, registerNo.toUpperCase()).run();
}

export async function updateD1RegistrationIdentity(input: {
  ownerKey: string;
  semesterId: string;
  registerNo: string;
  displayName: string;
  handle: string;
  discoverable: boolean;
}): Promise<void> {
  const db = getWorkerEnv().APP_DB;
  if (!db) return;
  await db.prepare(`UPDATE ${FFCS_CLASS_REGISTRATIONS_TABLE}
    SET discoverable = ?, display_name = ?, handle = ?, owner_key = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE semester_id = ? AND UPPER(register_no) = ?`)
    .bind(input.discoverable ? 1 : 0, input.displayName, input.handle, input.ownerKey,
      input.semesterId, input.registerNo.toUpperCase()).run();
}

export async function upsertD1RegisteredClasses(input: {
  semesterId: string;
  ownerKey: string;
  registerNo: string;
  authorizedID?: string;
  displayName: string;
  handle: string;
  courses: Array<{
    classId: string;
    courseCode: string;
    courseTitle: string;
    courseType: string;
    slot: string;
    faculty: string;
    credits: string;
    room: string;
  }>;
}): Promise<void> {
  const db = getWorkerEnv().APP_DB;
  if (!db) return;
  const identifiers = [...new Set([input.registerNo, input.authorizedID].filter(Boolean).map((value) => value!.trim().toUpperCase()))];
  if (!identifiers.length) return;

  // 1. Find only the student's previously registered class_ids for this semester via indexed lookup
  const placeholders = identifiers.map(() => "?").join(", ");
  const prevRegs = (await db.prepare(`SELECT class_id FROM ${FFCS_CLASS_REGISTRATIONS_TABLE}
    WHERE semester_id = ? AND register_no IN (${placeholders})`)
    .bind(input.semesterId, ...identifiers).all<{ class_id: string }>()).results;
  const previousClassIds = new Set(prevRegs.map((r) => r.class_id));
  const currentCourseIds = new Set(input.courses.map((course) => course.classId));

  // Classes the student dropped
  const droppedClassIds = [...previousClassIds].filter((id) => !currentCourseIds.has(id));

  // Fetch only the relevant classes (dropped ones + current ones), avoiding full-semester table scan
  const classIdsToFetch = [...new Set([...droppedClassIds, ...input.courses.map((c) => c.classId)])];
  let classesById = new Map<string, FfcsClassRow>();
  if (classIdsToFetch.length > 0) {
    const fetchPlaceholders = classIdsToFetch.map(() => "?").join(", ");
    const { results } = await db.prepare(`SELECT * FROM ${FFCS_CLASSES_TABLE}
      WHERE semester_id = ? AND class_id IN (${fetchPlaceholders})`)
      .bind(input.semesterId, ...classIdsToFetch)
      .all<Omit<FfcsClassRow, "register_nos"> & { register_nos: string }>();
    classesById = new Map(results.map((row) => [row.class_id, {
      ...row,
      register_nos: JSON.parse(row.register_nos || "[]") as string[],
    }]));
  }

  const deleteRegistration = db.prepare(`DELETE FROM ${FFCS_CLASS_REGISTRATIONS_TABLE}
    WHERE semester_id = ? AND register_no IN (${placeholders})`)
    .bind(input.semesterId, ...identifiers);
  const statements: D1PreparedStatement[] = [deleteRegistration];

  for (const droppedId of droppedClassIds) {
    const oldClass = classesById.get(droppedId);
    if (!oldClass) continue;
    const registerNos = oldClass.register_nos.filter((value) => !identifiers.includes(value.toUpperCase()));
    if (registerNos.length !== oldClass.register_nos.length) {
      statements.push(db.prepare(`UPDATE ${FFCS_CLASSES_TABLE}
        SET register_nos = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE semester_id = ? AND class_id = ?`)
        .bind(JSON.stringify(registerNos), input.semesterId, oldClass.class_id));
    }
  }

  for (const course of input.courses) {
    const oldRegisters = classesById.get(course.classId)?.register_nos ?? [];
    const registerNos = [...new Set([...oldRegisters.filter((value) => !identifiers.includes(value.toUpperCase())), input.registerNo.trim().toUpperCase()])];
    statements.push(db.prepare(`INSERT INTO ${FFCS_CLASSES_TABLE}
      (semester_id, class_id, course_code, course_title, course_type, slot, faculty, credits, room, register_nos)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (semester_id, class_id) DO UPDATE SET
        course_code = excluded.course_code, course_title = excluded.course_title,
        course_type = excluded.course_type, slot = excluded.slot, faculty = excluded.faculty,
        credits = excluded.credits, room = excluded.room, register_nos = excluded.register_nos,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
      .bind(input.semesterId, course.classId, course.courseCode, course.courseTitle,
        course.courseType, course.slot, course.faculty, course.credits, course.room,
        JSON.stringify(registerNos)));
    statements.push(db.prepare(`INSERT INTO ${FFCS_CLASS_REGISTRATIONS_TABLE}
      (semester_id, class_id, register_no, display_name, handle, owner_key, discoverable, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (semester_id, class_id, register_no) DO UPDATE SET
        display_name = excluded.display_name, handle = excluded.handle,
        owner_key = excluded.owner_key, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
      .bind(input.semesterId, course.classId, input.registerNo.trim().toUpperCase(), input.displayName,
        input.handle, input.ownerKey));
  }
  for (let index = 0; index < statements.length; index += D1_BATCH_SIZE) {
    await db.batch(statements.slice(index, index + D1_BATCH_SIZE));
  }
}

export async function setD1MatchVisibilityAndRegistration(
  ownerKey: string,
  semesterId: string,
  registerNo: string,
  discoverable: boolean,
): Promise<boolean> {
  const db = getWorkerEnv().APP_DB;
  if (!db) return false;
  const updated = await updateD1MatchVisibility(ownerKey, semesterId, discoverable);
  if (updated) await updateD1RegistrationVisibility(semesterId, registerNo, discoverable);
  return updated;
}

export async function removeD1Match(input: {
  ownerKey: string;
  semesterId: string;
  registerNo: string;
}): Promise<void> {
  const db = getWorkerEnv().APP_DB;
  if (!db) return;
  const normalizedReg = input.registerNo.trim().toUpperCase();
  const prevRegs = (await db.prepare(`SELECT class_id FROM ${FFCS_CLASS_REGISTRATIONS_TABLE}
    WHERE semester_id = ? AND register_no = ?`).bind(input.semesterId, normalizedReg)
    .all<{ class_id: string }>()).results;
  const classIds = prevRegs.map((r) => r.class_id);

  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM ${FFCS_MATCH_TABLE} WHERE owner_key = ? AND semester_id = ?`)
      .bind(input.ownerKey, input.semesterId),
    db.prepare(`DELETE FROM ${FFCS_CLASS_REGISTRATIONS_TABLE}
      WHERE semester_id = ? AND register_no = ?`)
      .bind(input.semesterId, normalizedReg),
  ];

  if (classIds.length > 0) {
    const placeholders = classIds.map(() => "?").join(", ");
    const { results } = await db.prepare(`SELECT * FROM ${FFCS_CLASSES_TABLE}
      WHERE semester_id = ? AND class_id IN (${placeholders})`)
      .bind(input.semesterId, ...classIds)
      .all<Omit<FfcsClassRow, "register_nos"> & { register_nos: string }>();
    for (const row of results) {
      const remaining = (JSON.parse(row.register_nos || "[]") as string[])
        .filter((value) => value.toUpperCase() !== normalizedReg);
      statements.push(db.prepare(`UPDATE ${FFCS_CLASSES_TABLE}
        SET register_nos = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE semester_id = ? AND class_id = ?`)
        .bind(JSON.stringify(remaining), input.semesterId, row.class_id));
    }
  }
  await db.batch(statements);
}

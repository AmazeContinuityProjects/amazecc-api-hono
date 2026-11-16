/**
 * POST /api/remote/attendance - attendance view + timetable merge + per-course
 * detail drill-down. I/O-bound; the parsing is cheerio but the pages are small.
 *
 * FFCS enrollment: whenever a user fetches attendance, we record their
 * enrollment for each course in the social FFCS tables (ffcs_classes,
 * ffcs_class_registrations) keyed by reg_no. If the student has no
 * student_profiles row yet, we create a partial Amaze ID account
 * (claim_status = 'incomplete') from their reg number. They can later claim
 * their Amaze ID at auth.amazecc.com/auth, which links D1 users.sub to this
 * reg_no via linkAmazeSub.
 */
import { Hono } from "hono";
import * as cheerio from "cheerio";
import {
  vtopPostForm,
  readText,
  cookieHeader,
  formParams,
} from "../../lib/vtop";
import fetchTimetable from "../../lib/fetchTimeTable";
import { attendanceItem, courseItem } from "../../types/data/attendance";
import { getDbPool } from "../../lib/db";
import { upsertStudentProfile } from "../../lib/student-profiles";
import { getMarks } from "../../lib/marks.htmlparser2";
import type { CourseItem } from "../../types/data/marks";
import {
  ensureSchema,
  ownerKeyFor,
  recordContribution,
  type Contribution,
} from "../../lib/marksStats";

export const attendanceRoute = new Hono();

async function batchAll<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]!);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function mergeAttendanceWithTimetable(attendance: attendanceItem[], timetable: courseItem[]): attendanceItem[] {
  const merged: attendanceItem[] = [];

  timetable.forEach((tt) => {
    const ttCourseCode = tt.courseCode.trim();
    const attEntry = attendance.find(
      (att) => (att?.courseCode?.split(" ")[0] ?? "").trim() === ttCourseCode
    );

    const cleanedVenue = tt.slotVenue
      ? (() => {
          const cleaned = tt.slotVenue.replace(/\s+/g, " ").trim();
          const matches = cleaned.match(/[A-Z]+\d*\s*-\s*\d+\s*[A-Z]?/g);
          return matches ? matches[matches.length - 1] : null;
        })()
      : null;

    if (attEntry) {
      merged.push({
        ...attEntry,
        classId: tt.classId,
        credits: tt.LTPJC?.split(" ")[4] || null,
        slotVenue: cleanedVenue,
        category: tt.category || null,
      });
    } else {
      merged.push({
        slNo: null,
        courseCode: tt.courseCode,
        courseTitle: tt.course,
        courseType: null,
        slotName: "NILL",
        faculty: tt.facultyDetails || null,
        registrationDate: null,
        attendanceDate: null,
        attendedClasses: null,
        totalClasses: null,
        attendancePercentage: null,
        viewLink: null,
        classId: tt.classId,
        credits: tt.LTPJC?.split(" ")[4] || null,
        slotVenue: cleanedVenue,
        category: tt.category || null,
      });
    }
  });
  return merged;
}

function numericValue(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "" || String(value).trim() === "-") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function assessmentPercent(assessment: CourseItem["assessments"][number]): number | null {
  const score = numericValue(assessment.scoredMark);
  const maximum = numericValue(assessment.maxMark);
  if (score === null || maximum === null || maximum <= 0) return null;
  const percent = (score / maximum) * 100;
  return percent >= 0 && percent <= 100 ? percent : null;
}

function assessmentTotals(course: CourseItem | undefined) {
  let weightPercent = 0;
  let weightedMarks = 0;
  for (const assessment of course?.assessments ?? []) {
    if (assessmentPercent(assessment) === null) continue;
    weightPercent += numericValue(assessment.weightagePercent) ?? 0;
    weightedMarks += numericValue(assessment.weightageMark) ?? 0;
  }
  return { weightPercent, weightedMarks };
}

function overallPercent(theory: CourseItem | undefined, lab: CourseItem | undefined): number | null {
  const theoryTotals = assessmentTotals(theory);
  const labTotals = assessmentTotals(lab);

  let earned: number;
  let available: number;
  if (!theory) {
    earned = labTotals.weightedMarks;
    available = labTotals.weightPercent;
  } else if (!lab) {
    earned = theoryTotals.weightedMarks;
    available = theoryTotals.weightPercent;
  } else {
    const theoryCredits = numericValue(theory.credits);
    const labCredits = numericValue(lab.credits);
    if (theoryCredits === null || labCredits === null || theoryCredits <= 0 || labCredits <= 0) {
      return null;
    }
    const totalCredits = theoryCredits + labCredits;
    earned =
      (theoryCredits * theoryTotals.weightedMarks + labCredits * labTotals.weightedMarks) /
      totalCredits;
    available =
      (theoryCredits * theoryTotals.weightPercent + labCredits * labTotals.weightPercent) /
      totalCredits;
  }

  if (available <= 0) return null;
  return Math.min(100, Math.ceil((earned / available) * 100 - 1e-9));
}

function buildMarkContributions(courses: CourseItem[]): Contribution[] {
  const groups = new Map<string, { theory?: CourseItem; lab?: CourseItem }>();
  for (const course of courses) {
    const code = course.courseCode.trim();
    if (!code || !course.classNbr) continue;
    const isLab =
      course.courseType.toLowerCase().includes("lab") || course.slot.toLowerCase().startsWith("l");
    const group = groups.get(code) ?? {};
    group[isLab ? "lab" : "theory"] = course;
    groups.set(code, group);
  }

  const contributions: Contribution[] = [];
  for (const group of groups.values()) {
    const classId = group.theory?.classNbr || group.lab?.classNbr;
    if (!classId) continue;

    const overall = overallPercent(group.theory, group.lab);
    if (overall !== null) {
      contributions.push({
        classId,
        scope: "overall",
        mark: overall,
        serverObserved: true,
      });
    }

    for (const component of ["theory", "lab"] as const) {
      for (const assessment of group[component]?.assessments ?? []) {
        const mark = assessmentPercent(assessment);
        const title = assessment.title.trim();
        if (mark === null || !title) continue;
        contributions.push({
          classId,
          scope: "assessment",
          component,
          title,
          mark,
          serverObserved: true,
        });
      }
    }
  }
  return contributions;
}

async function ingestAttendanceMarks(
  cookies: string,
  authorizedID: string,
  csrf: string,
  semesterId: string,
  courseInfo: courseItem[],
): Promise<Awaited<ReturnType<typeof getMarks>>> {
  const courseCreditMap: Record<string, number> = {};
  for (const course of courseInfo) {
    const credits = parseFloat(course.LTPJC?.split(" ")[4] || "0");
    if (!Number.isFinite(credits)) continue;
    const code = course.courseCode.trim();
    courseCreditMap[`${code}(T)`] = credits;
    courseCreditMap[`${code}(L)`] = credits;
  }

  const marksResult = await getMarks(cookies, authorizedID, csrf, semesterId, courseCreditMap);
  if (typeof marksResult === "string") return marksResult;

  const contributions = buildMarkContributions(marksResult.courses);
  if (contributions.length === 0) return marksResult;

  try {
    const regNo = authorizedID.trim().toUpperCase();
    const ownerKey = await ownerKeyFor(regNo);
    await ensureSchema();

    const client = await getDbPool().connect();
    try {
      await client.query("BEGIN");
      const now = Date.now();
      for (const contribution of contributions) {
        await recordContribution(client, ownerKey, contribution, now);
      }
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("[attendance] marks transaction rollback failed:", rollbackErr);
      }
      throw err;
    } finally {
      await client.release();
    }
  } catch (err) {
    console.error(
      "[attendance] marks ingestion failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return marksResult;
}

attendanceRoute.post("/attendance", async (c) => {
  try {
    const { cookies, authorizedID, csrf, semesterId } = (await c.req
      .json()
      .catch(() => ({}))) as Record<string, unknown>;

    const cookieHeaderValue = cookieHeader({ cookies: cookies as string | string[] | undefined });

    if (!csrf || !authorizedID) {
      return c.json({ success: false, error: "Cannot find _csrf or authorizedID" }, 400);
    }

    const ttRes = await vtopPostForm(
      "/vtop/processViewStudentAttendance",
      formParams({
        authorizedID: String(authorizedID),
        semesterSubId: String(semesterId ?? ""),
        _csrf: String(csrf),
        x: Date.now().toString(),
      }),
      { cookies: cookieHeaderValue, timeoutMs: 20_000 }
    );
    const ttHtml = await readText(ttRes);

    const courseInfo: courseItem[] = await fetchTimetable(
      cookieHeaderValue,
      String(authorizedID),
      String(csrf),
      String(semesterId ?? "")
    );

    let marksRes: Awaited<ReturnType<typeof getMarks>>;
    try {
      marksRes = await ingestAttendanceMarks(
        cookieHeaderValue,
        String(authorizedID),
        String(csrf),
        String(semesterId ?? ""),
        courseInfo,
      );
    } catch (err) {
      console.error(
        "[attendance] marks fetch failed:",
        err instanceof Error ? err.message : String(err),
      );
      marksRes = err instanceof Error ? err.message : String(err);
    }

    // ── FFCS enrollment (social only) ──
    // Record each course in ffcs_classes + ffcs_class_registrations keyed by
    // reg_no. Create a partial student_profiles row if one doesn't exist yet.
    try {
      const regNo = String(authorizedID).trim().toUpperCase();
      const semester = String(semesterId ?? "");

      // Ensure a partial Amaze ID account exists for this reg number.
      await upsertStudentProfile(regNo, {
        semester_id: semester || undefined,
      });

      const pool = getDbPool();

      // Ensure the social FFCS tables exist (inline DDL, house style).
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ffcs_classes (
          semester_id   TEXT NOT NULL,
          class_id      TEXT NOT NULL,
          course_code   TEXT NOT NULL DEFAULT '',
          course_title  TEXT NOT NULL DEFAULT '',
          course_type   TEXT NOT NULL DEFAULT '',
          slot          TEXT NOT NULL DEFAULT '',
          faculty       TEXT NOT NULL DEFAULT '',
          credits       TEXT NOT NULL DEFAULT '',
          room          TEXT NOT NULL DEFAULT '',
          register_nos  TEXT[] NOT NULL DEFAULT '{}',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (semester_id, class_id)
        );
        CREATE INDEX IF NOT EXISTS ffcs_classes_sem_class_idx
          ON ffcs_classes (semester_id, class_id);

        CREATE TABLE IF NOT EXISTS ffcs_class_registrations (
          semester_id   TEXT NOT NULL,
          class_id      TEXT NOT NULL,
          register_no   TEXT NOT NULL,
          display_name  TEXT NOT NULL DEFAULT '',
          handle        TEXT NOT NULL DEFAULT '',
          owner_key     TEXT NOT NULL,
          discoverable  BOOLEAN NOT NULL DEFAULT TRUE,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (semester_id, class_id, register_no)
        );
        CREATE INDEX IF NOT EXISTS ffcs_class_registrations_sem_reg_idx
          ON ffcs_class_registrations (semester_id, register_no);
        CREATE INDEX IF NOT EXISTS ffcs_class_registrations_sem_class_idx
          ON ffcs_class_registrations (semester_id, class_id);
      `);

      for (const course of courseInfo) {
        const classId = course.classId;
        if (!classId) continue;

        // Upsert into ffcs_classes (class catalog)
        await pool.query(
          `INSERT INTO ffcs_classes
            (semester_id, class_id, course_code, course_title, course_type, slot, faculty, credits, room)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (semester_id, class_id)
           DO UPDATE SET
             course_code = EXCLUDED.course_code,
             course_title = EXCLUDED.course_title,
             course_type = EXCLUDED.course_type,
             slot = EXCLUDED.slot,
             faculty = EXCLUDED.faculty,
             credits = EXCLUDED.credits,
             room = EXCLUDED.room,
             updated_at = NOW()`,
          [
            semester,
            classId,
            course.courseCode.trim(),
            course.course,
            course.category || "",
            course.slotVenue || "",
            course.facultyDetails || "",
            course.LTPJC?.split(" ")[4] || "",
            course.slotVenue || "",
          ]
        );

        // Register the student in ffcs_class_registrations
        await pool.query(
          `INSERT INTO ffcs_class_registrations
            (semester_id, class_id, register_no, display_name, handle, owner_key, discoverable, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (semester_id, class_id, register_no)
           DO UPDATE SET
             display_name = EXCLUDED.display_name,
             handle = EXCLUDED.handle,
             owner_key = EXCLUDED.owner_key,
             discoverable = EXCLUDED.discoverable,
             updated_at = NOW()`,
          [
            semester,
            classId,
            regNo,
            "", // display_name - filled when student claims Amaze ID
            "", // handle - filled when student claims Amaze ID
            regNo, // owner_key - reg_no itself until claimed
            true, // discoverable
          ]
        );
      }
    } catch (err) {
      console.error("[attendance] ffc enrollment failed:", err);
      // Don't break the attendance response on enrollment failure.
    }

    const $$$ = cheerio.load(ttHtml);
    const attendance: attendanceItem[] = [];

    $$$("#getStudentDetails table tbody tr").each((_, row) => {
      const cols = $$$(row).find("td");

      if (cols.length < 10) return;

      attendance.push({
        slNo: cols.eq(0).text().trim(),
        courseCode: cols.eq(4).text().trim().startsWith("L")
          ? cols.eq(1).text().trim() + "(L)"
          : cols.eq(1).text().trim() + "(T)",
        courseTitle: cols.eq(2).text().trim(),
        courseType: cols.eq(3).text().trim(),
        slotName: cols.eq(4).text().trim(),
        faculty: cols.eq(5).text().replace(/\s+/g, " ").trim(),
        registrationDate: cols.eq(7).text().trim(),
        attendanceDate: cols.eq(8).text().trim(),
        attendedClasses: parseInt(cols.eq(9).text().trim()),
        totalClasses: parseInt(cols.eq(10).text().trim()),
        attendancePercentage: cols.eq(11).text().trim(),
        viewLink: cols.eq(13).find("a").attr("onclick") || null,
      });
    });

    const mergedAttendance: attendanceItem[] = mergeAttendanceWithTimetable(attendance, courseInfo);

    async function fetchDetail(course: attendanceItem): Promise<attendanceItem> {
      if (!course.viewLink || typeof course.viewLink !== "string") return course;

      const match = course.viewLink.match(
        /processViewAttendanceDetail\('([^']+)','([^']+)'\)/
      );
      if (!match) return course;

      const [, classId, slotName] = match;

      try {
        const attendanceRes = await vtopPostForm(
          "/vtop/processViewAttendanceDetail",
          formParams({
            _csrf: String(csrf),
            authorizedID: String(authorizedID),
            x: Date.now().toString(),
            classId: String(classId),
            slotName: String(slotName),
          }),
          { cookies: cookieHeaderValue, timeoutMs: 20_000 }
        );

        const detailHtml = await readText(attendanceRes);
        const $$ = cheerio.load(detailHtml);
        const detailed: Array<{ date: string; status: string }> = [];

        $$("table.table tr").each((i, row) => {
          if (i === 0) return;

          const cols = $$(row).find("td");
          if (cols.length < 5) return;

          detailed.push({
            date: cols.eq(1).text().trim(),
            status: cols.eq(4).text().trim(),
          });
        });

        course.viewLink = detailed as unknown as typeof course.viewLink;
      } catch (err: unknown) {
        console.error(
          `Failed fetching detail for ${course.courseCode}`,
          err instanceof Error ? err.message : String(err)
        );
      }

      return course;
    }

    const detailedAttendance: attendanceItem[] = await batchAll(mergedAttendance, fetchDetail, 3);

    return c.json(
      { attRes: { semester: semesterId, attendance: detailedAttendance }, marksRes },
      { status: 200 }
    );
  } catch (err: unknown) {
    console.error(err);
    return c.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
});

/**
 * POST /api/remote/attendance/htmlparser2 — the same attendance payload, fully
 * parsed with htmlparser2 + css-select (no cheerio). Lower CPU than the cheerio
 * variant; the recommended path for the 10 ms budget. Also records the
 * caller's enrollment into cohort stats (best-effort, non-fatal).
 */
import { Hono } from "hono";
import { parseDocument } from "htmlparser2";
import { selectAll } from "css-select";
import { textContent, getAttributeValue } from "domutils";
import type { AnyNode, Element } from "domhandler";
import {
  vtopPostForm,
  readText,
  cookieHeader,
  formParams,
} from "../../lib/vtop";
import fetchTimetable from "../../lib/fetchTimeTable.htmlparser2";
import { getMarks } from "../../lib/marks.htmlparser2";
import { parseStudentProfile } from "../../lib/parsers/student-profile.htmlparser2";
import { ensureSchema, ownerKeyFor, recordEnrollment } from "../../lib/marksStats";
import { attendanceItem, courseItem } from "../../types/data/attendance";

export const attendanceHtmlparser2Route = new Hono();

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

function textOf(node: AnyNode | undefined | null): string {
  return node ? textContent(node).replace(/\r\n/g, "\n").trim() : "";
}

function getCells(row: AnyNode): Element[] {
  return selectAll("td", row) as Element[];
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

attendanceHtmlparser2Route.post("/attendance/htmlparser2", async (c) => {
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
    const courseCreditMap: Record<string, number> = {};
    courseInfo.forEach((course) => {
      courseCreditMap[course.courseCode.trim()] = parseFloat(course.LTPJC?.split(" ")[4] || "0");
    });

    const marksRes = await getMarks(
      cookieHeaderValue,
      String(authorizedID),
      String(csrf),
      String(semesterId ?? ""),
      courseCreditMap
    );

    // Record class enrollment from the marks response (source of truth = VTOP).
    try {
      if (marksRes && typeof marksRes !== "string") {
        const identityRes = await vtopPostForm(
          "/vtop/studentsRecord/StudentProfileAllView",
          formParams({
            verifyMenu: "true",
            authorizedID: String(authorizedID),
            _csrf: String(csrf),
            nocache: Date.now().toString(),
          }),
          { cookies: cookieHeaderValue, timeoutMs: 20_000 }
        );
        const profile = parseStudentProfile(await readText(identityRes));
        const regNumber = profile.registerNo || profile.applicationNumber;

        if (!regNumber) {
          console.warn("attendance(htmlparser2): no REGISTER NO in profile response — enrollment skipped");
        } else {
          const ownerKey = await ownerKeyFor(regNumber);
          const classIds = (marksRes.courses ?? [])
            .map((c) => c.classNbr)
            .filter((id): id is string => typeof id === "string" && id.length > 0);

          await ensureSchema();
          await recordEnrollment(ownerKey, classIds, Date.now());
          console.log(`attendance(htmlparser2): enrollment recorded for ${classIds.length} classes`);
        }
      }
    } catch (enrollErr: unknown) {
      console.error(
        "attendance(htmlparser2): enrollment unavailable:",
        enrollErr instanceof Error ? enrollErr.message : String(enrollErr)
      );
    }

    const doc = parseDocument(ttHtml);
    const attendance: attendanceItem[] = [];

    const rows = selectAll("#getStudentDetails table tr", doc);
    for (const row of rows) {
      const cols = getCells(row);
      if (cols.length < 10) continue;

      const code = textOf(cols[1]);
      const slot = textOf(cols[4]);
      attendance.push({
        slNo: textOf(cols[0]),
        courseCode: slot.startsWith("L") ? code + "(L)" : code + "(T)",
        courseTitle: textOf(cols[2]),
        courseType: textOf(cols[3]),
        slotName: slot,
        faculty: textOf(cols[5]).replace(/\s+/g, " ").trim(),
        registrationDate: textOf(cols[7]),
        attendanceDate: textOf(cols[8]),
        attendedClasses: parseInt(textOf(cols[9]), 10),
        totalClasses: parseInt(textOf(cols[10]), 10),
        attendancePercentage: textOf(cols[11]),
        viewLink: (() => {
          const link = selectAll("a", cols[13] ?? row)[0] as Element | undefined;
          return link ? getAttributeValue(link, "onclick") ?? null : null;
        })(),
      });
    }

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

        const detailDoc = parseDocument(await readText(attendanceRes));
        const detailed: Array<{ date: string; status: string }> = [];
        const detailRows = selectAll("table.table tr", detailDoc);

        for (let i = 0; i < detailRows.length; i++) {
          if (i === 0) continue; // header
          const cols = getCells(detailRows[i]!);
          if (cols.length < 5) continue;
          detailed.push({
            date: textOf(cols[1]),
            status: textOf(cols[4]),
          });
        }

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

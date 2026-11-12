/**
 * POST /api/remote/attendance — attendance view + timetable merge + per-course
 * detail drill-down. I/O-bound; the parsing is cheerio but the pages are small.
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
import { getMarks } from "../../lib/marks";
import { attendanceItem, courseItem } from "../../types/data/attendance";

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

/**
 * Timetable fetch — one POST to /vtop/processViewTimeTable, parse the course
 * info table. Same parsing as the original; axios swapped for fetch.
 */
import * as cheerio from "cheerio";
import { vtopPostForm, readText, cookieHeader, formParams } from "./vtop";
import { courseItem } from "../types/data/attendance";

export default async function fetchTimetable(
  cookies: string | string[],
  authorizedID: string,
  csrf: string,
  semesterId: string
): Promise<courseItem[]> {
  const res = await vtopPostForm(
    "/vtop/processViewTimeTable",
    formParams({
      authorizedID: String(authorizedID),
      semesterSubId: String(semesterId ?? ""),
      _csrf: String(csrf),
      x: Date.now().toString(),
    }),
    { cookies: cookieHeader({ cookies }), timeoutMs: 20_000 }
  );

  const html = await readText(res);
  const $$$ = cheerio.load(html);

  const courseInfo: courseItem[] = [];
  $$$("table.table").each((_, table) => {
    $$$(table)
      .find("tbody tr")
      .each((_, row) => {
        const cells = $$$(row).find("td");
        if (cells.length === 0) return;

        courseInfo.push({
          slNo: $$$(cells[0]).text().trim(),
          course: $$$(cells[2]).text().trim(),
          courseCode: $$$(cells[7]).text().trim().startsWith("L")
            ? $$$(cells[2]).text().trim().split(" ")[0] + "(L)"
            : $$$(cells[2]).text().trim().split(" ")[0] + "(T)",
          LTPJC: $$$(cells[3]).text().trim(),
          category: $$$(cells[4]).text().trim(),
          classId: $$$(cells[6]).text().trim(),
          slotVenue: $$$(cells[7]).text().trim(),
          facultyDetails: $$$(cells[8]).text().trim(),
        });
      });
  });

  return courseInfo;
}

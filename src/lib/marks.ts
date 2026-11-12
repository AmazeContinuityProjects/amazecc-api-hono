/**
 * Marks view + credits/CGPA fetch. Same parsing as the original axios version.
 */
import * as cheerio from "cheerio";
import { vtopPostForm, readText, cookieHeader, formParams } from "./vtop";
import { CourseItem, CGPA } from "../types/data/marks";

export async function getMarks(
  cookies: string[] | string,
  authorizedID: string,
  csrf: string,
  semesterId: string,
  courseCreditMap: Record<string, number>
): Promise<{ courses: CourseItem[]; cgpa: CGPA } | string> {
  try {
    const res = await vtopPostForm(
      "/vtop/examinations/doStudentMarkView",
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
    const courses: CourseItem[] = [];

    $$$("table.customTable > tbody > tr.tableContent").each((_, row) => {
      const cols = $$$(row).find("td");
      if (cols.length < 9) return;

      const courseCode = cols.eq(2).text().trim();
      const slot = cols.eq(7).text().trim();
      const isLab = slot.startsWith("L");

      const primaryKey = `${courseCode}(${isLab ? "L" : "T"})`;
      const creditsValue = courseCreditMap[primaryKey] ?? 0;

      const courseData: CourseItem = {
        slNo: cols.eq(0).text().trim(),
        classNbr: cols.eq(1).text().trim(),
        courseCode,
        credits: creditsValue,
        courseTitle: cols.eq(3).text().trim(),
        courseType: cols.eq(4).text().trim(),
        courseSystem: cols.eq(5).text().trim(),
        faculty: cols.eq(6).text().trim().replace(/\s+/g, " "),
        slot: cols.eq(7).text().trim(),
        courseMode: cols.eq(8).text().trim(),
        assessments: [],
      };

      const nestedTableRow = $$$(row).next("tr.tableContent");

      nestedTableRow
        .find("table.customTable-level1 > tbody > tr.tableContent-level1")
        .each((_, assessmentRow) => {
          const assessmentCols = $$$(assessmentRow).find("td");

          courseData.assessments.push({
            slNo: assessmentCols.eq(0).find("output").text().trim(),
            title: assessmentCols.eq(1).find("output").text().trim(),
            maxMark: assessmentCols.eq(2).find("output").text().trim(),
            weightagePercent: assessmentCols.eq(3).find("output").text().trim(),
            status: assessmentCols.eq(4).find("output").text().trim(),
            scoredMark: assessmentCols.eq(5).find("output").text().trim(),
            weightageMark: assessmentCols.eq(6).find("output").text().trim(),
          });
        });

      if (courseData.assessments.length > 0) {
        courses.push(courseData);
      }
    });

    const creditsRes = await vtopPostForm(
      "/vtop/get/dashboard/current/cgpa/credits",
      formParams({
        authorizedID: String(authorizedID),
        _csrf: String(csrf),
        x: Date.now().toString(),
      }),
      { cookies: cookieHeader({ cookies }), timeoutMs: 20_000 }
    );

    const creditsHtml = await readText(creditsRes);
    const $$$$ = cheerio.load(creditsHtml);
    const cgpa: CGPA = {};

    $$$$(".list-group-item").each((_, el) => {
      const label = $$$$("span.card-title", el).text().trim();
      const value = $$$$("span.fontcolor3 span", el).text().trim();

      if (label.includes("Total Credits Required")) cgpa.creditsRequired = value;
      else if (label.includes("Earned Credits")) cgpa.creditsEarned = value;
      else if (label.includes("Current CGPA")) cgpa.cgpa = value;
      else if (label.includes("Non-graded Core Requirement")) cgpa.nonGradedRequirement = value;
    });

    return { courses, cgpa };
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Unknown error";
    throw new Error(`Failed to fetch marks: ${message}`);
  }
}

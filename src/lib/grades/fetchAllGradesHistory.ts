import * as cheerio from "cheerio";
import { vtopPostForm, readText, formParams } from "../vtop";
import { GradeItem, GradeResultsMap, GradeBreakdown } from "../../types/data/allgrades";

async function batchAll<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
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

export async function fetchAllGradesHistory(args: {
  cookieHeader: string;
  authorizedID: string;
  csrf: string;
}): Promise<GradeResultsMap> {
  const { cookieHeader, authorizedID, csrf } = args;

  let startYear = 2024;
  if (typeof authorizedID === "string") {
    startYear = parseInt(authorizedID.slice(0, 2), 10) + 2000;
  }

  const currentYear = new Date().getFullYear();
  const semesters: string[] = [];

  for (let year = startYear; year <= currentYear; year++) {
    const next = (year + 1).toString().slice(-2);
    semesters.push(`CH${year}${next}01`);
    semesters.push(`CH${year}${next}07`);
    semesters.push(`CH${year}${next}05`);
  }

  async function fetchGradeDetail(grade: GradeItem, semId: string): Promise<GradeItem> {
    if (!grade.courseId) {
      grade.details = null;
      return grade;
    }

    try {
      const detailRes = await vtopPostForm(
        "/vtop/examinations/examGradeView/getGradeViewDetails",
        formParams({
          authorizedID,
          semesterSubId: semId,
          courseId: grade.courseId,
          _csrf: csrf,
          x: new Date().toUTCString(),
        }),
        {
          cookies: cookieHeader,
          timeoutMs: 15_000,
          headers: {
            Referer: "https://vtopcc.vit.ac.in/vtop/examinations/examGradeView/StudentGradeView",
          },
        }
      );

      const $$$ = cheerio.load(await readText(detailRes));

      const rangeTable = $$$("table.table-striped")
        .filter((_, el) => $$$(el).text().includes("Range of Grades"))
        .first();

      if (rangeTable.length) {
        const cells = rangeTable.find("tr").eq(2).find("td span");

        if (cells.length >= 7) {
          grade.range = {
            S: $$$(cells[0]).text().trim(),
            A: $$$(cells[2]).text().trim(),
            B: $$$(cells[3]).text().trim(),
            C: $$$(cells[4]).text().trim(),
            D: $$$(cells[5]).text().trim(),
            E: $$$(cells[6]).text().trim(),
            F: $$$(cells[7]).text().trim(),
          };
        }
      }

      const detailTables = $$$("table.table-striped").filter((_, el) =>
        $$$(el).text().includes("Mark Title")
      );

      const breakdown: (GradeBreakdown & { type: string })[] = [];

      detailTables.each((tIndex, tableEl) => {
        const type = tIndex === 0 ? "Theory" : tIndex === 1 ? "Lab" : `Component ${tIndex + 1}`;

        $$$(tableEl)
          .find("tr")
          .slice(2, -1)
          .each((_, row) => {
            const tds = $$$(row).find("td, output");
            if (tds.length < 7) return;

            const clean = (i: number) => $$$(tds[i]).text().replace(/\s+/g, " ").trim();

            breakdown.push({
              slNo: clean(0),
              component: clean(2),
              maxMark: clean(4),
              weightagePercent: clean(6),
              status: clean(8),
              scoredMark: clean(10),
              weightageMark: clean(12),
              type,
            });
          });
      });

      grade.details = (breakdown.length ? breakdown : null) as unknown as GradeBreakdown[] | null;
    } catch {
      grade.details = null;
    }

    return grade;
  }

  async function fetchSemester(semId: string) {
    try {
      const resGrades = await vtopPostForm(
        "/vtop/examinations/examGradeView/doStudentGradeView",
        formParams({
          authorizedID,
          semesterSubId: semId,
          _csrf: csrf,
          x: Date.now().toString(),
        }),
        {
          cookies: cookieHeader,
          timeoutMs: 15_000,
          headers: {
            Referer: "https://vtopcc.vit.ac.in/vtop/examinations/examGradeView/StudentGradeView",
          },
        }
      );

      const $$ = cheerio.load(await readText(resGrades));
      const rows = $$("table.table-bordered tr").slice(2);

      if (rows.length === 0) return null;

      let gpa: string | null = null;
      const grades: GradeItem[] = [];

      rows.each((_, row) => {
        const cols = $$(row).find("td");

        if ($$(row).attr("align") === "center") {
          const txt = $$(row).text().trim();
          const match = txt.match(/GPA\s*:\s*([\d.]+)/i);
          if (match && match[1]) gpa = match[1];
          return;
        }

        if (cols.length < 11) return;

        const btn = cols.eq(11).find('button[onclick^="javascript:getGradeViewDetails"]');
        const onclick = btn.attr("onclick");
        const courseId = onclick?.match(/getGradeViewDetails\('([^']+)'\)/)?.[1] || null;

        grades.push({
          slNo: cols.eq(0).text().trim(),
          courseCode: cols.eq(1).text().trim(),
          courseTitle: cols.eq(2).text().trim(),
          courseType: cols.eq(3).text().trim(),
          grandTotal: cols.eq(9).text().trim(),
          grade: cols.eq(10).text().trim(),
          courseId,
        });
      });

      const detailed = await batchAll(grades, (g) => fetchGradeDetail(g, semId), 3);

      return { gpa, grades: detailed };
    } catch (err) {
      console.warn(`Error fetching semester ${semId}:`, err);
      return null;
    }
  }

  const resultsArray = await batchAll(semesters, fetchSemester, 3);

  const output: GradeResultsMap = {};
  semesters.forEach((semId, i) => {
    output[semId] = resultsArray[i] ?? null;
  });

  return output;
}

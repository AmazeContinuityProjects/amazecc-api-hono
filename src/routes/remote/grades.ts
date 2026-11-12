/**
 * POST /api/remote/grades — unified grades view (overall + semester-wise,
 * effective-grade info merged). Feedback stays served by /api/remote/ffcs.
 */
import { Hono } from "hono";
import * as cheerio from "cheerio";
import {
  vtopPostForm,
  readText,
  cookieHeader,
  formParams,
} from "../../lib/vtop";
import { CGPA, CurriculumItem } from "../../types/data/grades";
import { fetchAllGradesHistory } from "../../lib/grades/fetchAllGradesHistory";
import type { GradeResultsMap } from "../../types/data/allgrades";

export const gradesRoute = new Hono();

type EffectiveCourse = {
  courseCode: string;
  courseTitle: string;
  courseType: string;
  creditsEarned: string;
  grade: string;
  examMonth?: string;
  resultDeclared?: string;
  distributionType?: string;
};

function normalizeKey(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mergeEffectiveIntoSemesters(semesters: GradeResultsMap, effective: EffectiveCourse[]) {
  const remaining = [...effective];
  for (const semId of Object.keys(semesters || {})) {
    const sem = semesters[semId];
    if (!sem || !Array.isArray(sem.grades)) continue;
    for (const course of sem.grades as any[]) {
      const code = String(course.courseCode || "").trim().toUpperCase();
      let idx = -1;
      if (code) idx = remaining.findIndex((e) => e.courseCode.toUpperCase() === code);
      if (idx === -1) {
        const titleKey = normalizeKey(course.courseTitle);
        idx = remaining.findIndex(
          (e) =>
            normalizeKey(e.courseTitle) === titleKey &&
            String(e.grade).toUpperCase() === String(course.grade).toUpperCase()
        );
      }
      if (idx === -1) continue;
      const eff = remaining.splice(idx, 1)[0]!;
      if (eff.distributionType) course.distributionType = eff.distributionType;
      if (eff.creditsEarned) course.creditsEarned = eff.creditsEarned;
      if (eff.examMonth) course.examMonth = eff.examMonth;
      if (eff.resultDeclared) course.resultDeclared = eff.resultDeclared;
      if (eff.courseType) course.effectiveCourseType = eff.courseType;
    }
  }
  if (remaining.length) {
    (semesters as any).__unmapped_effective__ = {
      gpa: null,
      grades: remaining.map((eff) => ({
        courseCode: eff.courseCode,
        courseTitle: eff.courseTitle,
        courseType: eff.courseType,
        grandTotal: "",
        grade: eff.grade,
        courseId: null,
        distributionType: eff.distributionType || "",
        creditsEarned: eff.creditsEarned || "",
        examMonth: eff.examMonth || "",
        resultDeclared: eff.resultDeclared || "",
        effectiveCourseType: eff.courseType || "",
      })),
    };
  }
}

gradesRoute.post("/grades", async (c) => {
  try {
    const { cookies, authorizedID, csrf } = (await c.req
      .json()
      .catch(() => ({}))) as Record<string, unknown>;

    const cookieHeaderValue = cookieHeader({ cookies: cookies as string | string[] | undefined });

    if (!csrf || !authorizedID) {
      return c.json({ success: false, error: "Cannot find _csrf or authorizedID" }, 400);
    }

    const gradeRes = await vtopPostForm(
      "/vtop/examinations/examGradeView/StudentGradeHistory",
      formParams({
        verifyMenu: "true",
        authorizedID: String(authorizedID),
        _csrf: String(csrf),
        nocache: Date.now().toString(),
      }),
      { cookies: cookieHeaderValue, timeoutMs: 20_000 }
    );
    const gradeHtml = await readText(gradeRes);

    const $$ = cheerio.load(gradeHtml);
    const effectiveCourses: EffectiveCourse[] = [];

    const CREDITS_NUMERIC = /^\d+(?:\.\d+)?$/;
    const GRADE_LETTER = /^[SABCDEF]$/i;

    $$('#fixedTableContainer table')
      .eq(1)
      .find("tr.tableContent")
      .each((_, el) => {
        const tds = $$(el).find("td");
        const credits = $$(tds[4]).text().trim();
        const grade = $$(tds[5]).text().trim();
        if (!CREDITS_NUMERIC.test(credits) || !GRADE_LETTER.test(grade)) return;

        effectiveCourses.push({
          courseCode: $$(tds[1]).text().trim(),
          courseTitle: $$(tds[2]).text().trim(),
          courseType: $$(tds[3]).text().trim(),
          creditsEarned: credits,
          grade,
          examMonth: $$(tds[6]).text().trim(),
          resultDeclared: $$(tds[7]).text().trim(),
          distributionType: $$(tds[8]).text().trim(),
        });
      });

    const curriculum: CurriculumItem[] = [];

    $$('#fixedTableContainer table')
      .eq(5)
      .find("tr.tableContent")
      .each((_, el) => {
        const tds = $$(el).find("td");
        curriculum.push({
          basketTitle: $$(tds[0]).text().trim(),
          creditsRequired: $$(tds[1]).text().trim(),
          creditsEarned: $$(tds[2]).text().trim(),
        });
      });

    $$('#fixedTableContainer table')
      .eq(6)
      .find("tr.tableContent")
      .each((_, el) => {
        const tds = $$(el).find("td");
        curriculum.push({
          basketTitle: $$(tds[0]).text().trim(),
          creditsRequired: $$(tds[2]).text().trim(),
          creditsEarned: $$(tds[3]).text().trim(),
        });
      });

    const cgpa: CGPA = {};
    const cgpaRow = $$("table.table.table-hover.table-bordered tbody tr").first();

    if (cgpaRow.length) {
      const tds = cgpaRow.find("td");
      const cell = (i: number) => $$(tds[i]).text().trim();

      const creditsRegistered = cell(0);
      const creditsEarned = cell(1);
      const published = cell(2);

      if (CREDITS_NUMERIC.test(creditsRegistered)) cgpa.creditsRegistered = creditsRegistered;
      if (CREDITS_NUMERIC.test(creditsEarned)) cgpa.creditsEarned = creditsEarned;
      if (CREDITS_NUMERIC.test(published)) cgpa.cgpa = published;

      cgpa.grades = {
        S: parseInt(cell(3)),
        A: parseInt(cell(4)),
        B: parseInt(cell(5)),
        C: parseInt(cell(6)),
        D: parseInt(cell(7)),
        E: parseInt(cell(8)),
        F: parseInt(cell(9)),
        N: parseInt(cell(10)),
      };
    }

    const history = await fetchAllGradesHistory({
      cookieHeader: cookieHeaderValue,
      authorizedID: String(authorizedID),
      csrf: String(csrf),
    });

    mergeEffectiveIntoSemesters(history, effectiveCourses);

    return c.json(
      {
        success: true,
        overall: {
          cgpa,
          curriculum,
        },
        semesters: history,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    console.error(err);
    return c.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
});

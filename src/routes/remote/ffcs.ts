/**
 * POST /api/remote/ffcs — combined FFCS-related payload.
 * registrationSchedule · feedbackStatus · feedback · wishlist · schedule · qcmView.
 * `section` narrows the work; `all` is heavy and schedule needs `semesterId`.
 */
import { Hono } from "hono";
import * as cheerio from "cheerio";
import {
  vtopPostForm,
  readText,
  cookieHeader,
  formParams,
} from "../../lib/vtop";
import { parseVtopHtml } from "../../lib/parsers/auto-parse";
import { parseFeedbackStatus } from "../../lib/parsers/feedback-status";
import { publicErrorMessage } from "../../lib/publicError";
import type { ExamItem, Schedule } from "../../types/data/schedule";

export const ffcsRoute = new Hono();

function cookieHeaderOf(cookies: unknown): string {
  return cookieHeader({ cookies: cookies as string | string[] | undefined });
}

const menuParams = (authorizedID: string, csrf: string, extra: Record<string, string> = {}) =>
  formParams({
    verifyMenu: "true",
    authorizedID: String(authorizedID),
    _csrf: String(csrf),
    nocache: Date.now().toString(),
    ...extra,
  });

async function fetchWishlist(cookieHeaderValue: string, authorizedID: string, csrf: string) {
  const INIT_URL = "/vtop/academics/registration/wishlistRegPage";
  const initResp = await vtopPostForm(INIT_URL, menuParams(authorizedID, csrf), {
    cookies: cookieHeaderValue,
    timeoutMs: 20_000,
  });
  const initHtml = await readText(initResp);
  const $ = cheerio.load(initHtml);

  let semFieldName = "semesterSubId";
  $("select").each((_, el) => {
    const name = $(el).attr("name") || $(el).attr("id") || "";
    let hasSemOption = false;
    $(el)
      .find("option")
      .each((_, opt) => {
        const txt = $(opt).text().trim().toLowerCase();
        if (
          txt.includes("sem") ||
          txt.includes("fall") ||
          txt.includes("winter") ||
          txt.includes("summer")
        ) {
          hasSemOption = true;
        }
      });
    if (hasSemOption && name) semFieldName = name;
  });

  const options: { value: string; text: string }[] = [];
  $(`select[name="${semFieldName}"] option, select[id="${semFieldName}"] option`).each((_, el) => {
    const v = $(el).attr("value");
    if (v && v !== "null" && v !== "") options.push({ value: v, text: $(el).text().trim() });
  });

  const semesters: Record<string, unknown> = {};
  for (const opt of options) {
    try {
      const dataResp = await vtopPostForm(
        INIT_URL,
        formParams({
          authorizedID: String(authorizedID),
          x: new Date().toUTCString(),
          [semFieldName]: opt.value,
          _csrf: String(csrf),
        }),
        { cookies: cookieHeaderValue, timeoutMs: 20_000 }
      );
      semesters[opt.text] = { ...parseVtopHtml(await readText(dataResp)) };
    } catch (e: unknown) {
      semesters[opt.text] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { success: true, semesters };
}

async function fetchSchedule(cookieHeaderValue: string, authorizedID: string, csrf: string, semesterId?: string) {
  const resp = await vtopPostForm(
    "/vtop/examinations/doSearchExamScheduleForStudent",
    formParams({
      authorizedID: String(authorizedID),
      semesterSubId: String(semesterId ?? ""),
      _csrf: String(csrf),
    }),
    { cookies: cookieHeaderValue, timeoutMs: 20_000 }
  );

  const html = await readText(resp);
  const $$$ = cheerio.load(html);
  const schedule: Schedule = {};
  let currentExamType: string | null = null;

  $$$("table.customTable tr").each((_, row) => {
    const tds = $$$(row).find("td");

    if (tds.length === 1 && $$$(tds[0]).attr("colspan") === "13") {
      currentExamType = $$$(tds[0]).text().trim();
      return;
    }

    if ($$$(row).hasClass("tableHeader")) return;
    if (!currentExamType) return;

    if ($$$(row).hasClass("tableContent") && tds.length > 1) {
      const item: ExamItem = {
        courseCode: $$$(tds[1]).text().trim(),
        courseTitle: $$$(tds[2]).text().trim(),
        classId: $$$(tds[4]).text().trim(),
        slot: $$$(tds[5]).text().trim(),
        examDate: $$$(tds[6]).text().trim(),
        examSession: $$$(tds[7]).text().trim(),
        reportingTime: $$$(tds[8]).text().trim(),
        examTime: $$$(tds[9]).text().trim(),
        venue: $$$(tds[10]).text().trim(),
        seatLocation: $$$(tds[11]).text().trim(),
        seatNo: $$$(tds[12]).text().trim(),
      };

      if (!schedule[currentExamType]) {
        schedule[currentExamType] = [];
      }
      (schedule[currentExamType] as ExamItem[]).push(item);
    }
  });

  return { semester: semesterId, Schedule: schedule };
}

function camelCaseQcm(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .replace(/(?:^\w|[A-Z]|\b\w)/g, (m, i) => (i === 0 ? m.toLowerCase() : m.toUpperCase()))
    .replace(/\s+/g, "");
}

type QcmTable = { caption?: string; headers: string[]; rows: Record<string, string>[] };

function extractQcmTables($$: cheerio.CheerioAPI): QcmTable[] {
  const tables: QcmTable[] = [];

  $$("table").each((_, table) => {
    const $table = $$(table);
    if ($table.find("table").length > 0 && $table.find("tr").length <= 2) return;

    const caption = $table.find("caption").first().text().trim() || undefined;
    const headers: string[] = [];
    const rows: Record<string, string>[] = [];

    const $thead = $table.find("thead tr").first();
    if ($thead.length > 0) {
      $thead.find("th, td").each((_, cell) => {
        const text = $$(cell).text().trim();
        if (text) headers.push(text);
      });
    }

    if (headers.length === 0) {
      const $firstRow = $table.find("tr").first();
      $firstRow.find("th").each((_, cell) => {
        const text = $$(cell).text().trim();
        if (text) headers.push(text);
      });
      if (headers.length === 0) {
        $firstRow.find("td").each((_, cell) => {
          const text = $$(cell).text().trim();
          const colspan = $$(cell).attr("colspan");
          if (text && colspan !== "13" && text.length < 100) headers.push(text);
        });
      }
    }

    const startSlice = headers.length > 0 ? 1 : 0;
    const $bodyRows =
      $table.find("tbody tr").length > 0 ? $table.find("tbody tr") : $table.find("tr").slice(startSlice);

    $bodyRows.each((_, row) => {
      const rowData: Record<string, string> = {};
      $$(row).find("td").each((i, cell) => {
        const text = $$(cell).text().trim();
        if (text) rowData[headers[i] || `col${i}`] = text;
      });
      if (Object.keys(rowData).length > 0) rows.push(rowData);
    });

    if (headers.length > 0 && rows.length > 0) {
      tables.push({ caption, headers, rows });
    }
  });

  return tables;
}

function extractQcmKeyValuePairs($$: cheerio.CheerioAPI): Record<string, string> {
  const kvPairs: Record<string, string> = {};

  $$("table").each((_, table) => {
    $$(table).find("tr").each((_, row) => {
      const cells = $$(row).find("td");
      if (cells.length === 2) {
        const label = $$(cells[0]).text().trim().replace(/\s+/g, " ");
        const value = $$(cells[1]).text().trim();
        if (label && value && label !== value && label.length < 80 && !label.startsWith("<")) {
          kvPairs[camelCaseQcm(label)] = value;
        }
      }
    });
  });

  $$("dl").each((_, dl) => {
    $$(dl).find("dt").each((_, dt) => {
      const label = $$(dt).text().trim();
      const dd = $$(dt).next("dd");
      const value = dd.text().trim();
      if (label && value) {
        kvPairs[camelCaseQcm(label)] = value;
      }
    });
  });

  $$(".form-group, .row").each((_, group) => {
    const label = $$(group).find("label").first().text().trim();
    const value =
      $$(group).find("span, .form-control-static, p").first().text().trim() ||
      String($$(group).find("input").first().val() ?? "");
    if (label && value && label.length < 80) {
      kvPairs[camelCaseQcm(label)] = String(value);
    }
  });

  return kvPairs;
}

async function fetchQcmView(cookieHeaderValue: string, authorizedID: string, csrf: string, semesterId?: string) {
  const initRes = await vtopPostForm(
    "/vtop/academics/common/QCMStudentLogin",
    menuParams(authorizedID, csrf),
    { cookies: cookieHeaderValue, timeoutMs: 20_000 }
  );
  const initHtml = await readText(initRes);

  const $ = cheerio.load(initHtml);
  const pageCsrf = String($('input[name="_csrf"]').val() ?? csrf);
  const semesterIds: { value: string; text: string }[] = [];

  $("#semesterSubId option").each((_, opt) => {
    const val = $(opt).attr("value") || "";
    if (val) semesterIds.push({ value: val, text: $(opt).text().trim() });
  });

  const semsToFetch = semesterId ? semesterIds.filter((s) => s.value === semesterId) : semesterIds;
  const allSemesterData: Record<string, unknown> = {};

  for (const sem of semsToFetch) {
    try {
      const dataRes = await vtopPostForm(
        "/vtop/getStudentLoginForQcm",
        formParams({
          _csrf: pageCsrf,
          authorizedID: String(authorizedID),
          semSubId: sem.value,
          paramReturnId: "getStudentLoginForQcm",
          x: Date.now().toString(),
        }),
        { cookies: cookieHeaderValue, timeoutMs: 20_000 }
      );

      const responseHtml = await readText(dataRes);
      const $$ = cheerio.load(responseHtml);
      const $target = $$("#getStudentLoginForQcm");
      const parseRoot = $target.length > 0 ? cheerio.load($target.html() || responseHtml) : $$;

      const tables = extractQcmTables(parseRoot);
      const rawKvPairs = extractQcmKeyValuePairs(parseRoot);

      const tableHeaderKeys = new Set<string>();
      const tableValues = new Set<string>();
      for (const table of tables) {
        for (const h of table.headers) tableHeaderKeys.add(camelCaseQcm(h));
        for (const row of table.rows)
          for (const val of Object.values(row)) tableValues.add(String(val).trim());
      }
      const keyValuePairs: Record<string, string> = {};
      for (const [key, val] of Object.entries(rawKvPairs)) {
        if (!tableHeaderKeys.has(key) && !tableValues.has(val)) keyValuePairs[key] = val;
      }

      const messages: string[] = [];
      parseRoot(".alert, .box-body > p, .callout, .info-box-text").each((_, el) => {
        const text = parseRoot(el).text().trim();
        if (text && text.length > 3) messages.push(text);
      });

      let plainText: string | undefined;
      if (tables.length === 0 && Object.keys(keyValuePairs).length === 0) {
        const bodyText = parseRoot("body").text().trim() || parseRoot.root().text().trim();
        const cleaned = bodyText.replace(/\s+/g, " ").trim();
        if (cleaned && cleaned.length > 3) plainText = cleaned;
      }

      allSemesterData[sem.value] = {
        semester: sem.text,
        tables,
        keyValuePairs,
        ...(messages.length > 0 ? { messages } : {}),
        ...(plainText ? { plainText } : {}),
      };
    } catch (err: unknown) {
      allSemesterData[sem.value] = {
        semester: sem.text,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { success: true, semesters: semesterIds, data: allSemesterData };
}

ffcsRoute.post("/ffcs", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      cookies?: string | string[];
      authorizedID?: string;
      csrf?: string;
      semesterId?: string;
      section?: "registration" | "feedback" | "wishlist" | "schedule" | "qcm" | "qcm-view" | "all";
    };
    const { cookies, authorizedID, csrf, semesterId, section } = body;

    const cookieHeaderValue = cookieHeaderOf(cookies);
    if (!csrf || !authorizedID) {
      return c.json({ success: false, error: "Missing csrf or authorizedID" }, 400);
    }

    const isAll = !section || section === "all";
    const wantRegistration = isAll || section === "registration";
    const wantFeedback = isAll || section === "feedback";
    const wantWishlist = isAll || section === "wishlist";
    const wantSchedule = isAll || section === "schedule";
    const wantQcm = isAll || section === "qcm" || section === "qcm-view";

    let registrationSchedule: unknown = undefined;
    let feedbackStatus: unknown = undefined;
    let feedback: unknown = undefined;
    let wishlist: unknown = undefined;
    let schedule: unknown = undefined;
    let qcmView: unknown = undefined;

    if (wantRegistration) {
      const resp = await vtopPostForm(
        "/vtop/examinations/hostelDetails",
        menuParams(authorizedID!, csrf!),
        { cookies: cookieHeaderValue, timeoutMs: 20_000 }
      );
      registrationSchedule = { success: true, ...parseVtopHtml(await readText(resp)) };
    }

    if (wantFeedback) {
      if (semesterId) {
        const resp = await vtopPostForm(
          "/vtop/processViewFeedBackStatus",
          formParams({
            authorizedID: String(authorizedID),
            semesterSubId: String(semesterId),
            _csrf: String(csrf),
            x: new Date().toUTCString(),
          }),
          { cookies: cookieHeaderValue, timeoutMs: 20_000 }
        );
        const semesterData = parseFeedbackStatus(await readText(resp));
        feedbackStatus = { success: true, semesterId, ...semesterData };
      } else {
        const resp = await vtopPostForm(
          "/vtop/academics/common/FeedBackStatusStudent",
          menuParams(authorizedID!, csrf!),
          { cookies: cookieHeaderValue, timeoutMs: 20_000 }
        );
        feedbackStatus = { success: true, ...parseFeedbackStatus(await readText(resp)) };
      }

      // Simple standalone feedback status (moved from /api/grades)
      const simpleResp = await vtopPostForm(
        "/vtop/processViewFeedBackStatus",
        formParams({
          authorizedID: String(authorizedID),
          semesterSubId: String(semesterId ?? ""),
          _csrf: String(csrf),
          x: Date.now().toString(),
        }),
        { cookies: cookieHeaderValue, timeoutMs: 20_000 }
      );
      const $$$ = cheerio.load(await readText(simpleResp));
      const isGiven = (text: string) => !text.toLowerCase().includes("not");
      feedback = {
        MidSem: {
          Curriculum: isGiven($$$("tbody tr").eq(0).find("td").eq(1).text()),
          Course: isGiven($$$("tbody tr").eq(1).find("td").eq(1).text()),
        },
        EndSem: {
          Curriculum: isGiven($$$("tbody tr").eq(0).find("td").eq(2).text()),
          Course: isGiven($$$("tbody tr").eq(1).find("td").eq(2).text()),
        },
      };
    }

    if (wantWishlist) {
      wishlist = await fetchWishlist(cookieHeaderValue, String(authorizedID), String(csrf));
    }

    if (wantSchedule) {
      if (semesterId) {
        schedule = await fetchSchedule(cookieHeaderValue, String(authorizedID), String(csrf), String(semesterId));
      } else if (section === "schedule") {
        return c.json({ success: false, error: "Missing semesterId for schedule" }, 400);
      } else {
        schedule = { skipped: true, reason: "Missing semesterId for schedule" };
      }
    }

    if (wantQcm) {
      qcmView = await fetchQcmView(cookieHeaderValue, String(authorizedID), String(csrf), semesterId ? String(semesterId) : undefined);
    }

    return c.json({ success: true, registrationSchedule, feedbackStatus, feedback, wishlist, schedule, qcmView });
  } catch (err: unknown) {
    console.error("ffcs error:", err instanceof Error ? err.message : String(err));
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});

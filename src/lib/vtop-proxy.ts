/**
 * VTOP proxy registry — the single source of truth for higher-level multi-page
 * scrapes (registration schedule, EXC registration, …). The individual routes
 * stay thin wrappers; /api/remote/bulk runs any subset inside one invocation.
 */
import * as cheerio from "cheerio";
import { cookieHeader, formParams, vtopPostMenu, vtopPostForm, readText, type VtopCreds } from "./vtop";
import { parseVtopHtml } from "./parsers/auto-parse";

export interface ProxyOutcome {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The semester-iterating pages (EXC registration, course completion): read the
 * init page, discover the semester `<select>`, then re-post once per semester.
 */
async function runSemesterProxy(
  initUrl: string,
  creds: VtopCreds
): Promise<Record<string, unknown>> {
  const initResp = await vtopPostMenu(initUrl, creds);
  const initHtml = await readText(initResp);
  const $ = cheerio.load(initHtml);

  let semFieldName = "semesterSubId";
  $("select").each((_, el) => {
    const name = $(el).attr("name") || $(el).attr("id") || "";
    let hasSem = false;
    $(el).find("option").each((_, o) => {
      const t = $(o).text().trim().toLowerCase();
      if (t.includes("sem") || t.includes("fall") || t.includes("winter") || t.includes("summer")) hasSem = true;
    });
    if (hasSem && name) semFieldName = name;
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
        initUrl,
        formParams({
          authorizedID: String(creds.authorizedID),
          x: new Date().toUTCString(),
          [semFieldName]: opt.value,
          _csrf: String(creds.csrf),
        }),
        { cookies: cookieHeader(creds) }
      );
      semesters[opt.text] = { ...parseVtopHtml(await readText(dataResp)) };
    } catch (e: unknown) {
      semesters[opt.text] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { semesters };
}

type ProxyFn = (creds: VtopCreds) => Promise<unknown>;

export const VTOP_PROXIES: Record<string, ProxyFn> = {
  "hostel-counselling": async (creds) =>
    parseVtopHtml(await readText(await vtopPostMenu("/vtop/examinations/technoCrendentials", creds))),
  "registration-schedule": async (creds) =>
    parseVtopHtml(await readText(await vtopPostMenu("/vtop/examinations/hostelDetails", creds))),
  "exc-registration": (creds) => runSemesterProxy("/vtop/academics/exc/studentRegistration", creds),
  "course-completion": (creds) => runSemesterProxy("/vtop/others/bonafide/CourseCompleteControl", creds),
};

export const VTOP_PROXY_NAMES: readonly string[] = Object.keys(VTOP_PROXIES);

/**
 * Run one proxy by name. Never throws: a failure comes back as
 * `{ success: false, error }` with a 500 so one bad endpoint cannot fail the batch.
 */
export async function runVtopProxy(name: string, creds: VtopCreds): Promise<ProxyOutcome> {
  const fn = VTOP_PROXIES[name];
  if (!fn) return { status: 404, body: { success: false, error: `Unknown endpoint: ${name}` } };
  if (!creds.csrf || !creds.authorizedID) {
    return { status: 400, body: { error: "Missing csrf or authorizedID" } };
  }
  try {
    const data = (await fn(creds)) as Record<string, unknown>;
    return { status: 200, body: { success: true, ...data } };
  } catch (err: unknown) {
    console.error(`${name} error:`, err);
    return {
      status: 500,
      body: { success: false, error: err instanceof Error ? err.message : String(err) },
    };
  }
}

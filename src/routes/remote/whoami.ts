/**
 * POST /api/remote/whoami — aggregate identity across VTOP pages.
 *
 * One VTOP session in (cookies + csrf + authorizedID), a normalized identity
 * out. Same contract as the original /api/whoami: sources run sequentially to
 * avoid VTOP session/rate issues, and every source is independent — a failure
 * in one page surfaces under `fetchErrors` while the rest still return.
 */
import { Hono } from "hono";
import * as cheerio from "cheerio";
import {
  vtopPostForm,
  readText,
  formParams,
  cookieHeader,
  getVtopReferer,
} from "../../lib/vtop";
import { parseStudentProfile } from "../../lib/parsers/student-profile";
import { parseProctor } from "../../lib/parsers/proctor";
import { parseHodDean } from "../../lib/parsers/hod-dean";
import { parseCredentials } from "../../lib/parsers/credentials";
import { parseContact } from "../../lib/parsers/contact";
import { parseAcknowledgement } from "../../lib/parsers/acknowledgement";
import { parseDayboarder } from "../../lib/parsers/dayboarder";
import { parseBankInfo } from "../../lib/parsers/bank-info";
import {
  parseVtopHtml,
  type ParsedVtopPage,
} from "../../lib/parsers/auto-parse";
import { buildIdentity } from "../../lib/identity";
import { publicErrorMessage } from "../../lib/publicError";

export const whoamiRoute = new Hono();

const BASE_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Referer: getVtopReferer(),
} as const;

function clean(value: unknown): string | undefined {
  const v = String(value ?? "").replace(/\s+/g, " ").trim();
  return v || undefined;
}

function cleanParsedPage(parsed: ParsedVtopPage) {
  const selectOptions: Record<string, { value: string; text: string; selected: boolean }[]> = {};
  for (const [k, opts] of Object.entries(parsed.selectOptions || {})) {
    const cleaned = (opts || [])
      .map((o) => ({ value: clean(o.value) || "", text: clean(o.text) || "", selected: !!o.selected }))
      .filter((o) => o.value || o.text);
    if (cleaned.length) selectOptions[k] = cleaned;
  }
  const tables = (parsed.tables || [])
    .map((t) => {
      const rows = (t.rows || [])
        .map((row) => {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(row || {})) {
            const c = clean(v);
            if (c) out[String(k).trim()] = c;
          }
          return out;
        })
        .filter((r) => Object.keys(r).length > 0);
      if (!rows.length) return null;
      const headers = (t.headers || []).map((h) => String(h).trim()).filter(Boolean);
      return {
        ...(clean(t.caption) ? { caption: clean(t.caption) } : {}),
        ...(headers.length ? { headers } : {}),
        rows,
      };
    })
    .filter(Boolean);
  const keyValuePairs: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.keyValuePairs || {})) {
    const c = clean(v);
    if (c) keyValuePairs[k] = c;
  }
  const formFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.formFields || {})) {
    const c = clean(v);
    if (c) formFields[k] = c;
  }
  const messages: Record<string, string> = {};
  if (clean(parsed.messages?.warning)) messages.warning = clean(parsed.messages.warning)!;
  if (clean(parsed.messages?.error)) messages.error = clean(parsed.messages.error)!;
  if (clean(parsed.messages?.success)) messages.success = clean(parsed.messages.success)!;

  return {
    ...(clean(parsed.title) ? { title: clean(parsed.title) } : {}),
    ...(Object.keys(selectOptions).length ? { selectOptions } : {}),
    ...(tables.length ? { tables } : {}),
    ...(Object.keys(keyValuePairs).length ? { keyValuePairs } : {}),
    ...(Object.keys(formFields).length ? { formFields } : {}),
    ...(Object.keys(messages).length ? { messages } : {}),
  };
}

function cleanDayboarder(data: ReturnType<typeof parseDayboarder>) {
  const fields: Record<string, any> = {};
  for (const [k, v] of Object.entries(data.fields || {})) {
    if (k === "_csrf" || k === "authorizedID") continue;
    const value = clean(v.value);
    if (!value) continue;
    const selectedOpt =
      (v.options || []).find((o) => o.selected) ||
      (v.options || []).find((o) => clean(o.value) === value);
    const selectedText = clean(selectedOpt?.text);
    fields[k] = {
      label: clean(v.label) || k,
      value,
      ...(selectedText && selectedText !== value ? { selectedText } : {}),
    };
  }
  return {
    ...(clean(data.title) ? { title: clean(data.title) } : {}),
    ...(Object.keys(fields).length ? { fields } : {}),
  };
}

function cleanEptSchedule(html: string) {
  const $ = cheerio.load(html);
  const parsed = cleanParsedPage(parseVtopHtml(html));
  const title =
    clean(parsed.title) ||
    clean($("h3.box-title, .box-title, h2, h3, strong").first().text());
  const candidates = [
    ...$(".alert, .callout, .text-info, .text-warning, .text-danger, .text-success, .box-body")
      .map((_, el) => $(el).text())
      .get(),
    ...$("p, span, div, td, b").map((_, el) => $(el).text()).get(),
  ];
  let status: string | undefined;
  for (const raw of candidates) {
    let t = clean(raw);
    if (!t) continue;
    if (title && t.toLowerCase().startsWith(title.toLowerCase())) t = clean(t.slice(title.length));
    if (!t) continue;
    if (/exam will be scheduled|not\s+scheduled|no\s+ept|not\s+available|schedule/i.test(t) && t.length <= 180) {
      status = t;
      break;
    }
  }
  const out: Record<string, any> = { ...(parsed as any) };
  if (title) out.title = title;
  if (status && !out.message) out.message = status;
  return out;
}

function cleanAcknowledgement(data: ReturnType<typeof parseAcknowledgement>) {
  const docs = (data.documents || [])
    .map((d) => ({
      ...(clean(d.serialNo) ? { serialNo: clean(d.serialNo) } : {}),
      ...(clean(d.documentName) ? { documentName: clean(d.documentName) } : {}),
      ...(clean(d.status) ? { status: clean(d.status) } : {}),
    }))
    .filter((d) => d.documentName || d.serialNo || d.status);
  const out: Record<string, any> = {};
  if (clean(data.title)) out.title = clean(data.title);
  if (docs.length) out.documents = docs;
  const reg = clean(data.registerNo),
    app = clean(data.applicationNo),
    prog = clean(data.programme),
    br = clean(data.branch),
    campus = clean(data.campus);
  if (app) out.applicationNo = app;
  if (reg) out.registerNo = reg;
  if (prog) out.programme = prog;
  if (br) out.branch = br;
  if (campus) out.campus = campus;
  return out;
}

function hasApaarData(parsed: ParsedVtopPage, html: string): boolean {
  return (
    (parsed.keyValuePairs && Object.keys(parsed.keyValuePairs).length > 0) ||
    (parsed.tables && parsed.tables.some((t) => t.rows.length > 0)) ||
    Object.values(parsed.formFields || {}).some(
      (v) => v && v.length > 4 && v !== "-" && !v.startsWith("0")
    ) ||
    /\.pdf/i.test(html) ||
    /already uploaded|submitted successfully/i.test(html)
  );
}

whoamiRoute.post("/whoami", async (c) => {
  try {
    const { cookies, authorizedID, csrf } = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const cookieHeaderValue = Array.isArray(cookies) ? cookies.join("; ") : String(cookies ?? "");
    if (!csrf || !authorizedID) {
      return c.json({ success: false, error: "Missing csrf or authorizedID" }, 400);
    }

    const headers = { ...BASE_HEADERS, Cookie: cookieHeaderValue };
    const post = async (name: string, url: string) => {
      try {
        const res = await vtopPostForm(url, formParams({
          verifyMenu: "true",
          authorizedID: String(authorizedID),
          _csrf: String(csrf),
          nocache: Date.now().toString(),
        }), { cookies: cookieHeaderValue, headers });
        const html = await readText(res);
        if (!res.ok) return { name, html: "", error: `HTTP ${res.status}` };
        return { name, html, error: null as string | null };
      } catch (e: any) {
        return { name, html: "", error: e?.message || String(e) };
      }
    };

    // Run sequentially to avoid VTOP session/rate issues; each request is independent.
    const sources = [
      ["student", "/vtop/studentsRecord/StudentProfileAllView"],
      ["proctor", "/vtop/proctor/viewProctorDetails"],
      ["hodDean", "/vtop/hrms/viewHodDeanDetails"],
      ["credentials", "/vtop/proctor/viewStudentCredentials"],
      ["apaar", "/vtop/apaarid/upload"],
      ["bank", "/vtop/studentBankInformation/BankInfoStudent"],
      ["contact", "/vtop/hrms/contactDetails"],
      ["acknowledgement", "/vtop/admissions/AcknowledgmentView"],
      ["dayboarder", "/vtop/admissions/dayboarderForMenu"],
      ["eptSchedule", "/vtop/compre/eptScheduleShow"],
    ] as const;

    const results: Record<string, { html: string; error: string | null }> = {};
    for (const [name, url] of sources) {
      results[name] = await post(name, url);
    }

    const fetchErrors = Object.fromEntries(
      Object.entries(results)
        .filter(([, v]) => v.error)
        .map(([k, v]) => [k, v.error])
    );
    const studentHtml = results.student!.html;
    const proctorHtml = results.proctor!.html;
    const hodDeanHtml = results.hodDean!.html;
    const credentialsHtml = results.credentials!.html;
    const apaarHtml = results.apaar!.html;
    const bankHtml = results.bank!.html;
    const contactHtml = results.contact!.html;
    const acknowledgementHtml = results.acknowledgement!.html;
    const dayboarderHtml = results.dayboarder!.html;
    const eptHtml = results.eptSchedule!.html;

    const student = parseStudentProfile(studentHtml);
    const proctor = parseProctor(proctorHtml);
    const hodDean = parseHodDean(hodDeanHtml);
    const credentials = parseCredentials(credentialsHtml);
    const apaarParsed = parseVtopHtml(apaarHtml);
    const apaarHas = hasApaarData(apaarParsed, apaarHtml);
    const bank = parseBankInfo(bankHtml);
    const contact = parseContact(contactHtml);
    const acknowledgement = cleanAcknowledgement(parseAcknowledgement(acknowledgementHtml));
    const dayboarder = cleanDayboarder(parseDayboarder(dayboarderHtml));
    const eptSchedule = cleanEptSchedule(eptHtml);

    const identity = buildIdentity({
      student,
      proctor,
      hodDean,
      credentials,
      apaar: apaarParsed,
      hasApaar: apaarHas,
      bank,
    });

    return c.json({
      success: Object.keys(fetchErrors).length === 0,
      ...(Object.keys(fetchErrors).length ? { fetchErrors } : {}),
      ...identity,
      contact: contact.contacts ?? [],
      ...(clean(contact.title) ? { contactTitle: clean(contact.title) } : {}),
      ...(Object.keys(acknowledgement).length ? { acknowledgement } : {}),
      ...(Object.keys(dayboarder).length ? { dayboarder } : {}),
      ...(Object.keys(eptSchedule).length ? { eptSchedule } : {}),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("whoami error:", msg, err);
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});

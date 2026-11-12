/**
 * POST /api/remote/lms-data — scrape Moodle (lms.vit.ac.in) and return the
 * caller's upcoming assignments, with per-event teacher resolution from the
 * course view page. Session is established fresh on every call (no reuse).
 */
import { Hono } from "hono";
import * as cheerio from "cheerio";
import { lmsGet, lmsPostForm, mergeCookies, lmsUrl } from "../../lib/lms";
import { setCookies } from "../../lib/vtop";

export const lmsDataRoute = new Hono();

interface Assignment {
  name: string;
  due: string;
  done: boolean;
  day: number;
  month: number;
  year: number;
  url: string;
  teachers?: string[];
}

function extractCalendarEvents(html: string) {
  const $ = cheerio.load(html);
  const events: Array<Record<string, unknown>> = [];

  $("td.day.hasevent").each((_, el) => {
    const day = $(el).data("day");
    const month = $(el).find("a[data-day]").data("month") || null;
    const year = $(el).find("a[data-day]").data("year") || null;

    const dayEvents: Array<Record<string, unknown>> = [];

    $(el)
      .find('[data-region="event-item"] a[data-action="view-event"]')
      .each((_, ev) => {
        const title = $(ev).find(".eventname").text().trim();
        const link = $(ev).attr("href");
        dayEvents.push({ title, link });
      });

    events.push({ day, month, year, events: dayEvents });
  });

  return events;
}

function extractTeacherForModule(courseHTML: string, moduleId: string): string[] {
  const $ = cheerio.load(courseHTML);

  const moduleEl = $(`#module-${moduleId}`);
  if (!moduleEl.length) return [];
  const sectionEl = moduleEl.closest('li[id^="section-"]');
  if (!sectionEl.length) return [];
  const sectionTitle = sectionEl.find("h3.sectionname").first().text().trim();
  if (!sectionTitle) return [];
  const match = sectionTitle.match(/^(Dr\.?\s+[A-Za-z.\s]+)/i);
  return match ? [(match[1] ?? "Unknown").trim()] : [sectionTitle];
}

async function scrapeLMS(username: string, password: string): Promise<Assignment[]> {
  const getRes = await lmsGet("/login/index.php");
  const jar = setCookies(getRes).map((s) => s.split(";")[0]!.trim()).filter(Boolean).join("; ");
  const loginHtml = await getRes.text();

  const $ = cheerio.load(loginHtml);
  const token = String($('input[name="logintoken"]').val() ?? "");

  const body = new URLSearchParams();
  body.append("logintoken", token);
  body.append("username", username);
  body.append("password", password);

  const postRes = await lmsPostForm("/login/index.php", body.toString(), jar, { redirect: "manual" });

  const loginCookies = mergeCookies(jar, setCookies(postRes));
  const redirectUrl = postRes.headers.get("location");
  await postRes.text();

  if (!redirectUrl) {
    throw new Error("LMS did not redirect after login — the session was refused.");
  }

  const redirectRes = await lmsGet(lmsUrl(redirectUrl), loginCookies);
  const dashboardHtml = await redirectRes.text();

  const sesskeyMatch = dashboardHtml.match(/"sesskey":"([^"]+)"/);
  const sesskey = sesskeyMatch?.[1];

  if (!sesskey) {
    throw new Error("Cannot find sesskey");
  }

  // Only the current month is scraped; the prev/next-month hooks existed in the
  // original behind commented-out code and are intentionally not enabled.
  const allEvents = extractCalendarEvents(dashboardHtml);

  const eventPromises = (
    allEvents as Array<Record<string, unknown> & { events: Array<Record<string, unknown> & { link: string }> }>
  ).flatMap((dayData) =>
    dayData.events.map(async (ev) => {
      try {
        const eventRes = await lmsGet(lmsUrl(ev.link), loginCookies);
        const eventHtml = await eventRes.text();
        const $ev = cheerio.load(eventHtml);

        const courseLink = $ev("ol.breadcrumb li.breadcrumb-item a").first().attr("href");

        let teachers: string[] = [];

        if (courseLink) {
          const courseId = new URL(lmsUrl(courseLink)).searchParams.get("id");
          const moduleId = new URL(lmsUrl(ev.link)).searchParams.get("id");

          if (courseId && moduleId) {
            const courseRes = await lmsGet(`/course/view.php?id=${courseId}`, loginCookies);
            teachers = extractTeacherForModule(await courseRes.text(), moduleId);
          }
        }

        const courseCodeFull = $ev("ol.breadcrumb li.breadcrumb-item a").first().text().trim();
        const courseNameFull = $ev("ol.breadcrumb li.breadcrumb-item a").first().attr("title") || "";
        const assignmentName = $ev("h1.h2").first().text().trim();
        const name = `${courseCodeFull}/${courseNameFull}/${assignmentName}`;

        const dueText = $ev('div.activity-dates strong:contains("Due:")')
          .parent()
          .text()
          .replace("Due:", "")
          .trim();

        const isDone = $ev('[data-region="completion-info"] button.btn-success').length > 0;

        return {
          name,
          due: dueText,
          done: isDone,
          day: dayData.day as number,
          month: dayData.month as number,
          year: dayData.year as number,
          url: ev.link,
          teachers,
        };
      } catch (err: unknown) {
        console.error("❌ Failed parsing:", ev.link, err instanceof Error ? err.message : String(err));
        return null;
      }
    })
  );

  const finalResults = (await Promise.all(eventPromises)).filter(Boolean);
  return finalResults as Assignment[];
}

lmsDataRoute.post("/lms-data", async (c) => {
  try {
    const { username, pass } = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!username || !pass) {
      return c.json({ success: false, error: "Username and password are required." }, 400);
    }

    const result = await scrapeLMS(String(username), String(pass));
    return c.json(result, 200);
  } catch (err: unknown) {
    console.error(err);
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

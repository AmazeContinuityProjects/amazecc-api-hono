/**
 * POST /api/remote/vitol-data — scrape a Vitol (Moodle-like) site and return
 * upcoming quizzes/assignments with open dates. `vitolSite` selects the host:
 * "vitolcc" (default) or "vitolcc1".
 */
import { Hono } from "hono";
import * as cheerio from "cheerio";
import { setCookies } from "../../lib/vtop";
import { mergeCookies } from "../../lib/lms";

export const vitolDataRoute = new Hono();

interface Assignment {
  name: string;
  opens: string;
  done: boolean;
  day: number;
  month: number;
  year: number;
  url: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function vitolBase(site: string): string {
  return site === "vitolcc1" ? "https://vitolcc1.vit.ac.in" : "https://vitolcc.vit.ac.in";
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

vitolDataRoute.post("/vitol-data", async (c) => {
  try {
    const { username, pass, vitolSite } = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!username || !pass || !vitolSite) {
      return c.json({ success: false, error: "Username, password and vitolSite are required." }, 400);
    }

    const result = await scrapeVitolData(String(username), String(pass), String(vitolSite));
    return c.json(result, 200);
  } catch (err: unknown) {
    console.error(err);
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

async function scrapeVitolData(
  username: string,
  password: string,
  vitolSite: string
): Promise<Assignment[]> {
  const base = vitolBase(vitolSite);
  const url = (p: string) => (p.startsWith("http") ? p : `${base}${p}`);

  const getRes = await fetch(url("/login/index.php"), {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  const jar = setCookies(getRes).map((s) => s.split(";")[0]!.trim()).filter(Boolean).join("; ");

  const loginHtml = await getRes.text();
  const $ = cheerio.load(loginHtml);
  const token = String($('input[name="logintoken"]').val() ?? "");

  const formData = new URLSearchParams();
  formData.append("logintoken", token);
  formData.append("username", username);
  formData.append("password", password);

  const postRes = await fetch(url("/login/index.php"), {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jar,
    },
    body: formData.toString(),
  });

  const loginCookies = mergeCookies(jar, setCookies(postRes));
  const redirectUrl = postRes.headers.get("location");
  await postRes.text();

  if (!redirectUrl) {
    throw new Error("Vitol did not redirect after login — the session was refused.");
  }

  const redirectRes = await fetch(url(redirectUrl), {
    headers: { "User-Agent": UA, Cookie: loginCookies },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  const dashboardHtml = await redirectRes.text();

  const sesskeyMatch = dashboardHtml.match(/"sesskey":"([^"]+)"/);
  const sesskey = sesskeyMatch?.[1];

  if (!sesskey) {
    throw new Error("Cannot find sesskey");
  }

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  let nextMonth = currentMonth + 1;
  let nextYear = currentYear;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear++;
  }

  const calendarEventsCurrent = extractCalendarEvents(dashboardHtml);

  const nextMonthHTML = await fetchCalendarMonthHTML(sesskey, nextYear, nextMonth, loginCookies, base);
  const calendarEventsNext = extractCalendarEvents(nextMonthHTML);

  const allEvents = [...calendarEventsCurrent, ...calendarEventsNext];

  const urlSet = new Set<string>();
  const finalResults: Assignment[] = [];

  for (const dayData of allEvents) {
    for (const ev of (dayData as Record<string, unknown>).events as Array<
      Record<string, unknown> & { link: string }
    >) {
      try {
        const eventRes = await fetch(url(ev.link), {
          headers: { "User-Agent": UA, Cookie: loginCookies },
          redirect: "follow",
          signal: AbortSignal.timeout(15_000),
        });

        const eventHtml = await eventRes.text();
        const $ev = cheerio.load(eventHtml);

        const courseCodeFull = $ev("ol.breadcrumb li.breadcrumb-item a").first().text().trim();
        const courseNameFull = $ev("ol.breadcrumb li.breadcrumb-item a").first().attr("title") || "";
        const assignmentName = $ev("h1.h2").first().text().trim();
        const name = `${courseCodeFull}/${courseNameFull}/${assignmentName}`;

        const opensText = $ev("div.activity-dates strong")
          .filter((_, el) => {
            const text = $ev(el).text();
            return text.includes("Opens:") || text.includes("Opened:");
          })
          .parent()
          .text()
          .replace(/Opens:|Opened:/, "")
          .trim();

        const isDone = $ev('table.quizattemptsummary:contains("Finished")').length > 0;

        if (!urlSet.has(ev.link)) {
          urlSet.add(ev.link);

          finalResults.push({
            name,
            opens: opensText,
            done: isDone,
            day: dayData.day as number,
            month: dayData.month as number,
            year: dayData.year as number,
            url: ev.link,
          });
        }
      } catch (err: unknown) {
        console.error("❌ Failed parsing:", ev.link, err instanceof Error ? err.message : String(err));
      }
    }
  }
  return finalResults;
}

async function fetchCalendarMonthHTML(
  sesskey: string,
  year: number,
  month: number,
  cookies: string,
  base: string
): Promise<string> {
  const body = [
    {
      index: 0,
      methodname: "core_calendar_get_calendar_monthly_view",
      args: {
        year: String(year),
        month: String(month),
        courseid: 1,
        day: 1,
        view: "monthblock",
      },
    },
  ];

  const res = await fetch(
    `${base}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=core_calendar_get_calendar_monthly_view`,
    {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Cookie: cookies,
      },
      body: JSON.stringify(body),
    }
  );
  const json = (await res.json().catch(() => [])) as Array<{ data?: { html?: string } }>;
  return json[0]?.data?.html || "";
}

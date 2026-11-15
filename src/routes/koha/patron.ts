/**
 * POST /api/koha/patron — Koha OPAC login and patron pages.
 *
 * Body: { card, password, page? }
 * Logs into Koha with the OPAC form, then scrapes the requested page
 * (or, without `page`, all known pages). Koha card credentials never leave
 * this process except to webopaccc.vit.ac.in.
 *
 * NOT MOUNTED: webopaccc is unreachable from Cloudflare's egress.
 * Route is verified by type checking only; do not enable without origin-side
 * fixes and a test pass against the live catalog.
 */
import { Hono } from "hono";
import * as cheerio from "cheerio";
import { publicErrorMessage } from "../../lib/publicError";
import { kohaFetch } from "../../lib/koha";

export const kohaPatronRouter = new Hono();

const PAGE_MAP: Record<string, string> = {
  summary: "/cgi-bin/koha/opac-user.pl",
  charges: "/cgi-bin/koha/opac-account.pl",
  details: "/cgi-bin/koha/opac-memberentry.pl",
  tags: "/cgi-bin/koha/opac-tags.pl?mine=1",
  password: "/cgi-bin/koha/opac-passwd.pl",
  history: "/cgi-bin/koha/opac-search-history.pl",
  checkouts: "/cgi-bin/koha/opac-readingrecord.pl",
  suggestions: "/cgi-bin/koha/opac-suggestions.pl",
  messaging: "/cgi-bin/koha/opac-messaging.pl",
  lists: "/cgi-bin/koha/opac-shelves.pl?op=list",
};

function parsePage($: any): Record<string, unknown> {
  const page: Record<string, unknown> = {};

  page.title = $("h1").first().text().trim() || $("title").text().trim();
  page.patronName = $(".userlabel").text().replace("Welcome,", "").trim() || "";

  const tables: Array<Record<string, unknown>> = [];
  $("table").each((_: any, el: any) => {
    const caption =
      $(el).find("caption").text().trim() || $(el).prev("h4, h5").text().trim() || "";
    const headers: string[] = [];
    const rows: string[][] = [];
    $(el).find("thead th").each((_: any, th: any) => {
      headers.push($(th).text().trim());
    });
    $(el).find("tbody tr").each((_: any, tr: any) => {
      const cells: string[] = [];
      $(tr).find("td").each((_: any, td: any) => {
        cells.push($(td).text().trim().replace(/\s+/g, " "));
      });
      if (cells.length) rows.push(cells);
    });
    if (headers.length || rows.length) {
      tables.push({ caption, headers, rows });
    }
  });
  page.tables = tables;

  const alerts: string[] = [];
  $(".alert, .alert-info, .alert-warning").each((_: any, el: any) => {
    const t = $(el).text().trim().replace(/\s+/g, " ");
    if (t && !t.includes("x")) alerts.push(t);
  });
  page.alerts = alerts;

  return page;
}

kohaPatronRouter.post("/patron", async (c) => {
  try {
    const { card, password, page: pageName } = (await c.req.json().catch(() => ({}))) as {
      card?: string;
      password?: string;
      page?: string;
    };

    if (!card || !password) {
      return Response.json(
        { success: false, error: "Card number and password are required" },
        { status: 400 },
      );
    }

    const loginPage = await kohaFetch("GET", "/cgi-bin/koha/opac-user.pl", "");
    const postData = new URLSearchParams({
      koha_login_context: "opac",
      userid: card,
      password,
    }).toString();
    const loginResult = await kohaFetch(
      "POST",
      "/cgi-bin/koha/opac-user.pl",
      loginPage.cookies,
      postData,
    );
    const cookies = loginResult.cookies || loginPage.cookies;

    if (
      loginResult.body.includes("auth_error") ||
      (!loginResult.body.includes("logout") && !loginResult.body.includes("opac-user"))
    ) {
      return Response.json(
        { success: false, error: "Invalid card number or password" },
        { status: 401 },
      );
    }

    if (pageName && PAGE_MAP[pageName]) {
      const pageResult = await kohaFetch("GET", PAGE_MAP[pageName], cookies);
      const $ = cheerio.load(pageResult.body);
      return Response.json({ success: true, page: pageName, data: parsePage($) });
    }

    const result: Record<string, unknown> = { loggedIn: true, patronName: "" };
    const $ = cheerio.load(loginResult.body);
    result.patronName = $(".userlabel").text().replace("Welcome,", "").trim() || "";

    const pages: Record<string, unknown> = {};
    for (const [key, path] of Object.entries(PAGE_MAP)) {
      const r = await kohaFetch("GET", path, cookies);
      const page$ = cheerio.load(r.body);
      pages[key] = parsePage(page$);
    }
    result.pages = pages;

    return Response.json({ success: true, data: result });
  } catch (err: unknown) {
    console.error("[koha] patron error:", err instanceof Error ? err.message : String(err));
    return Response.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
});

/**
 * Faculty directory service (atop the remote directorycc.vit.ac.in site).
 *
 * POST /api/services/faculty/scrape — scrape a school's faculty page
 *   (SSRF-guarded: every redirect hop re-checked against the VIT allow-list),
 *   self-heal the stored URL when it finds the school's dedicated *-faculty
 *   subpage, and return the roster. DB-backed (faculty_directory_urls).
 * GET  /api/services/faculty/schools — list schools (public).
 */
import { Hono } from "hono";
import * as cheerio from "cheerio";
import { getDbPool } from "../../lib/db";
import { publicErrorMessage } from "../../lib/publicError";
import { vitUrl } from "../../lib/upstreamUrl";
import { checkRateLimit, rateLimitResponse, getClientIp } from "../../lib/rateLimit";

export const facultyRoute = new Hono();

interface RosterFaculty {
  id: string;
  name: string;
  designation: string;
  imageUrl: string;
  profileUrl: string;
  email: string;
  employeeId: string;
  intercom: string;
}

/**
 * SSRF-safe fetch with manual redirect following: the stored URL and every
 * `Location` hop are validated against the VIT allow-list before any request
 * is sent. Content-Type must be HTML/text.
 */
async function fetchHtml(url: string, redirects = 0): Promise<string> {
  if (redirects > 3) {
    throw new Error("Too many redirects");
  }
  const safeUrl = vitUrl(url);

  const res = await fetch(safeUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(8_000),
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (location) {
      const next = new URL(location, safeUrl).toString();
      return fetchHtml(next, redirects + 1);
    }
  }

  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("html") && !ctype.includes("text")) {
    throw new Error(`URL is not HTML (${ctype})`);
  }
  return res.text();
}

/**
 * Runs all three roster parsers against a page's HTML:
 * 1. New VIT Person Grid layout (article.vit-person-card)
 * 2. Elementor Grid (article.exad-post-grid-three)
 * 3. Legacy VIT page layout (.member-item, .staff-member, ...)
 */
function extractFaculties(html: string): RosterFaculty[] {
  const $ = cheerio.load(html);
  const faculties: RosterFaculty[] = [];

  // 1. Primary Parser: New VIT Person Grid layout
  $("article.vit-person-card").each((i, el) => {
    const imgLink = $(el).find("a.vit-person-image").first();
    const nameFromAttr = imgLink.attr("aria-label") || "";
    const nameFromText = $(el).find(".vit-person-name").first().text().trim();
    const name = (nameFromAttr || nameFromText).trim();
    if (!name) return;

    const chennaiProfileUrl = imgLink.attr("href") || $(el).find("a.vit-view-profile").first().attr("href") || "";
    const designation = $(el).find(".vit-designation").first().text().trim() || "Faculty";
    const img = $(el).find("img").first().attr("src") || $(el).find("img").first().attr("data-src") || "";

    const imgIdMatch = img.match(/(?:uploads\/\d{4}\/\d{2}\/)(\d{3,})/);
    const urlIdMatch = chennaiProfileUrl.match(/\/(\d{3,})\/?$/);
    const employeeId = imgIdMatch ? imgIdMatch[1]! : urlIdMatch ? urlIdMatch[1]! : "";

    faculties.push({
      id: employeeId || `card-${i}`,
      name,
      designation,
      imageUrl: img,
      profileUrl: employeeId ? `https://directorycc.vit.ac.in/faculty/${employeeId}` : chennaiProfileUrl,
      email: "",
      employeeId,
      intercom: "",
    });
  });

  // 2. Fallback Parser: Elementor Grid
  if (faculties.length === 0) {
    $("article.exad-post-grid-three").each((i, el) => {
      const titleEl = $(el).find("a.exad-post-grid-title").first();
      const name = titleEl.text().trim();
      if (!name) return;

      const chennaiProfileUrl = titleEl.attr("href") || "";
      const designation = $(el).find(".exad-post-grid-category a").first().text().trim() || "Faculty";
      const img = $(el).find("figure.exad-post-grid-thumbnail img").attr("src") || "";

      const idMatch = img.match(/(?:uploads\/\d{4}\/\d{2}\/)(\d{3,})/);
      const employeeId = idMatch ? idMatch[1]! : "";
      const profileUrl = employeeId
        ? `https://directorycc.vit.ac.in/faculty/${employeeId}`
        : chennaiProfileUrl;

      faculties.push({
        id: employeeId || `exad-${i}`,
        name,
        designation,
        imageUrl: img,
        profileUrl,
        email: "",
        employeeId,
        intercom: "",
      });
    });
  }

  // 3. Fallback Parser: Legacy VIT page layout
  if (faculties.length === 0) {
    $(".member-item, .staff-member, .vc_col-sm-3, .vc_col-sm-4").each((i, el) => {
      const nameEl = $(el).find("h3, h4").first();
      const name = nameEl.text().trim();
      if (!name) return;

      const designationEl = nameEl.next("h4, p, h5");
      const designation = designationEl.text().trim() || "Faculty";
      const img = $(el).find("img").attr("src") || "";
      const profileUrl = $(el).find("a").first().attr("href") || "";
      const textContent = $(el).text();

      const emailMatch = textContent.match(/[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}/);
      const empIdMatch = textContent.match(/Employee ID\s*(\d+)/i);
      const intercomMatch = textContent.match(/Intercom\s*([\d\s]+)/i);
      const employeeId = empIdMatch ? empIdMatch[1]! : "";

      faculties.push({
        id: employeeId || `legacy-${i}`,
        name,
        designation,
        imageUrl: img,
        profileUrl,
        email: emailMatch ? emailMatch[0] : "",
        employeeId,
        intercom: intercomMatch ? intercomMatch[1]!.trim() : "",
      });
    });
  }

  return faculties;
}

/**
 * Discovers a dedicated faculty listing subpage from a school page's own links.
 */
function findFacultySubpage(pageUrl: string, html: string): string | null {
  const base = new URL(pageUrl);
  const self = base.pathname.replace(/\/+$/, "");
  const parent = base.origin + self + "/";
  const candidates = new Set<string>();

  const $ = cheerio.load(html);
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!href.toLowerCase().includes("faculty")) return;
    try {
      const u = new URL(href, base);
      if (u.origin !== base.origin) return;
      const path = u.pathname.replace(/\/+$/, "");
      const last = path.split("/").filter(Boolean).pop() || "";
      const isBareFaculty = path === "/faculty";
      if ((last.endsWith("-faculty") || last === "faculty") && !isBareFaculty) {
        candidates.add(u.toString());
      }
    } catch {
      /* ignore malformed hrefs */
    }
  });

  const ranked = [...candidates].sort((a, b) => {
    const aIn = a.startsWith(parent) ? 0 : 1;
    const bIn = b.startsWith(parent) ? 0 : 1;
    return aIn - bIn;
  });
  return ranked[0] ?? null;
}

facultyRoute.post("/faculty/scrape", async (c) => {
  // Unauthenticated (the app's faculty tab falls back to it); rate-limited per IP.
  const rl = checkRateLimit(`faculty-scrape:${getClientIp(c.req.raw)}`, 10, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const { schoolId } = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!schoolId) {
      return c.json({ success: false, error: "schoolId is required" }, 400);
    }

    const pool = getDbPool();
    const { rows } = await pool.query(
      `SELECT url FROM faculty_directory_urls WHERE id = $1`,
      [schoolId]
    );

    if (rows.length === 0) {
      return c.json({ success: false, error: "School not found" }, 404);
    }

    const url = rows[0]!.url as string;
    const html = await fetchHtml(url);
    let faculties = extractFaculties(html);

    // Self-heal: stored URLs often point at school homepages whose faculty grids
    // are client-rendered. If no cards were found, look for the school's dedicated
    // "*-faculty" subpage (statically rendered) and parse that instead.
    if (faculties.length === 0) {
      const subpage = findFacultySubpage(url, html);
      if (subpage && subpage !== url) {
        try {
          const subHtml = await fetchHtml(subpage);
          faculties = extractFaculties(subHtml);
          if (faculties.length > 0) {
            try {
              await pool.query(
                `UPDATE faculty_directory_urls SET url = $1 WHERE id = $2 AND url <> $1`,
                [subpage, schoolId]
              );
            } catch (e) {
              console.error("faculty/scrape self-heal update failed:", e instanceof Error ? e.message : e);
            }
          }
        } catch (e) {
          console.error(`faculty/scrape subpage fetch failed (${subpage}):`, e instanceof Error ? e.message : e);
        }
      }
    }

    return c.json({ success: true, faculties });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("faculty/scrape error:", message);
    return c.json({ success: false, error: "Failed to fetch faculty list" }, 500);
  }
});

facultyRoute.get("/faculty/schools", async (c) => {
  try {
    const pool = getDbPool();
    const { rows } = await pool.query(
      `SELECT id, school_name FROM faculty_directory_urls ORDER BY school_name ASC`
    );
    return c.json({ success: true, schools: rows });
  } catch (error: unknown) {
    console.error("faculty/schools error:", error instanceof Error ? error.message : error);
    return c.json({ success: false, schools: [], error: publicErrorMessage(error) }, 500);
  }
});

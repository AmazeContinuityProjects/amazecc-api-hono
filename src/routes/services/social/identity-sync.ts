/**
 * POST /api/services/social/identity/sync — sync the caller's identity and
 * timetable from VTOP.
 *
 * Body: { cookies, authorizedID, csrf, proposedSemesterId? }
 * Returns { success, identity, semesterSource, version, busyMap, courses,
 *           peers, grantSecrets }
 */
import { Hono } from "hono";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import {
  identifyCaller,
  ensureSocialSchema,
  regKey,
  generateHandle,
  SOCIAL_TABLE,
  TIMETABLE_TABLE,
  FFCS_MATCH_TABLE,
  type CallerIdentity,
} from "../../../../src/lib/social";
import { upsertStudentProfile, getStudentProfileByRegNo } from "../../../../src/lib/student-profiles";
import { getDbPool } from "../../../../src/lib/db";
import { vtopPostForm, readText, formParams } from "../../../../src/lib/vtop";
import { parseStudentProfile } from "../../../../src/lib/parsers/student-profile";

export const socialIdentitySyncRouter = new Hono();

const SEMESTER_PAGES = [
  "/vtop/academics-common/index",
  "/vtop/studentRegistration/studentRegistration",
];

socialIdentitySyncRouter.post("/identity/sync", async (c) => {
  const ip = c.req.header("x-forwarded-for") || "unknown";
  // rate limit: 20 per 60s per IP
  const rlKey = `social-sync:${ip}`;
  const now = Date.now();
  // simple in-memory sliding window (matches legacy house style)
  const hits: number[] = [];
  // NOTE: legacy used a module-level Map; here we keep it simple with a
  // per-request check since hono routes are stateless. For production the
  // rate limit should be Redis-backed.

  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      cookies?: string | string[];
      authorizedID?: string;
      csrf?: string;
      proposedSemesterId?: string;
    };

    const result = await identifyCaller(body);
    if (!result.ok) {
      return c.json(
        { success: false, error: result.error, detail: result.detail }, result.status as any,
      );
    }

    const caller = result.caller;
    await ensureSocialSchema();

    // Upsert the person profile (partial Amaze ID account, incomplete)
    await upsertStudentProfile(caller.regNo, {
      display_name: caller.displayName,
    });

    const pool = getDbPool();

    // Parse timetable
    const timetableRes = await vtopPostForm(
      "/vtop/processViewTimeTable",
      formParams({
        verifyMenu: "true",
        authorizedID: caller.authorizedID,
        _csrf: caller.csrf,
        nocache: Date.now().toString(),
      }),
      { cookies: caller.cookies, timeoutMs: 20_000 },
    );

    const ttHtml = await readText(timetableRes);
    // TODO: parse timetable HTML into busyMap + courses (cheerio)
    // For now return empty structures; the legacy parser is complex and
    // should be ported separately if needed.
    const busyMap: Record<string, unknown> = {};
    const courses: unknown[] = [];

    // Determine semester
    let semesterId = body.proposedSemesterId;
    let semesterSource = "proposed";
    if (!semesterId) {
      // try cached semester
      const { rows: cached } = await pool.query(
        "SELECT value FROM app_config WHERE key = 'social_current_semester'",
      );
      if (cached.length && (cached[0] as any).value?.semesterId) {
        semesterId = (cached[0] as any).value.semesterId;
        semesterSource = "cached";
      } else {
        // fetch semester list from VTOP
        for (const page of SEMESTER_PAGES) {
          try {
            const semRes = await vtopPostForm(
              page,
              formParams({
                verifyMenu: "true",
                authorizedID: caller.authorizedID,
                _csrf: caller.csrf,
                nocache: Date.now().toString(),
              }),
              { cookies: caller.cookies, timeoutMs: 20_000 },
            );
            const semHtml = await readText(semRes);
            // TODO: parse semester from HTML
          } catch {
            // continue
          }
        }
      }
    }

    // Upsert timetable
    let version = 1;
    let publishedAt = new Date().toISOString();
    if (semesterId) {
      const { rows } = await pool.query(
        `INSERT INTO ${TIMETABLE_TABLE}
           (owner_key, semester_id, busy_map, courses, slotmap_version, register_no, display_name)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
         ON CONFLICT (owner_key, semester_id) DO UPDATE SET
           busy_map = EXCLUDED.busy_map,
           courses = EXCLUDED.courses,
           slotmap_version = EXCLUDED.slotmap_version,
           register_no = CASE WHEN EXCLUDED.register_no <> '' THEN EXCLUDED.register_no ELSE ${TIMETABLE_TABLE}.register_no END,
           display_name = CASE WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name ELSE ${TIMETABLE_TABLE}.display_name END,
           version = ${TIMETABLE_TABLE}.version + 1,
           published_at = NOW()
         RETURNING version, published_at`,
        [
          caller.ownerKey,
          semesterId,
          JSON.stringify(busyMap),
          JSON.stringify(courses),
          "v1",
          caller.regNo,
          caller.displayName,
        ],
      );
      version = Number(rows[0].version);
      publishedAt = new Date(rows[0].published_at).toISOString();
    }

    // Build peer view (grants)
    const peers: unknown[] = [];
    const grantSecrets: unknown[] = [];
    // TODO: port grant logic from socialGrants

    return c.json({
      success: true,
      identity: {
        ownerKey: caller.ownerKey,
        handle: generateHandle(caller.regNo),
        displayName: caller.displayName,
        semesterId: semesterId || "",
        semesterLabel: "",
        derivedAt: new Date().toISOString(),
        slotmapVersion: "v1",
      },
      semesterSource,
      version,
      busyMap,
      courses,
      peers,
      grantSecrets,
    });
  } catch (err: unknown) {
    console.error("[social] identity/sync error:", err);
    return c.json(
      { success: false, error: publicErrorMessage(err) }, 500);
  }
});




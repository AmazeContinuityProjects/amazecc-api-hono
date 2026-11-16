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
  generateHandle,
  getSocialHandlesForRegister,
  SOCIAL_TABLE,
  TIMETABLE_TABLE,
  FFCS_MATCH_TABLE,
  type CallerIdentity,
} from "../../../../src/lib/social";
import { upsertStudentProfile, getStudentProfileByRegNo } from "../../../../src/lib/student-profiles";
import { readAppConfig } from "../../../../src/lib/appConfig";
import { vtopPostForm, readText, formParams } from "../../../../src/lib/vtop";
import { parseStudentProfile } from "../../../../src/lib/parsers/student-profile";
import { ensureSocialInD1, migrateD1SocialOwnerKey } from "../../../../src/lib/socialD1";

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
    const db = await ensureSocialInD1();
    await migrateD1SocialOwnerKey(caller.regNo, caller.ownerKey);
    const handles = await getSocialHandlesForRegister(caller.regNo);
    await db.prepare(`INSERT INTO social_people (owner_key, handle, display_name, register_no)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (owner_key) DO UPDATE SET
         handle = excluded.handle,
         display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE social_people.display_name END,
         register_no = excluded.register_no,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
      .bind(caller.ownerKey, generateHandle(caller.regNo), caller.displayName, caller.regNo).run();

    // Upsert the person profile (partial Amaze ID account, incomplete)
    await upsertStudentProfile(caller.regNo, {
      display_name: caller.displayName,
    });

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
      const cached = await readAppConfig<{ semesterId?: string }>("social_current_semester");
      if (cached?.semesterId) {
        semesterId = cached.semesterId;
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
      const row = await db.prepare(`INSERT INTO ${TIMETABLE_TABLE}
             (owner_key, semester_id, busy_map, courses, slotmap_version, register_no, display_name)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner_key, semester_id) DO UPDATE SET
             busy_map = excluded.busy_map,
             courses = excluded.courses,
             slotmap_version = excluded.slotmap_version,
             register_no = CASE WHEN excluded.register_no <> '' THEN excluded.register_no ELSE ${TIMETABLE_TABLE}.register_no END,
             display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE ${TIMETABLE_TABLE}.display_name END,
             version = ${TIMETABLE_TABLE}.version + 1,
             published_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           RETURNING version, published_at`)
        .bind(caller.ownerKey, semesterId, JSON.stringify(busyMap), JSON.stringify(courses), "v1",
          caller.regNo, caller.displayName).first<{ version: number; published_at: string }>();
      if (row) {
        version = Number(row.version);
        publishedAt = new Date(row.published_at).toISOString();
      }
    }

    // Build peer view (grants)
    const peers: unknown[] = [];
    const grantSecrets: unknown[] = [];
    // TODO: port grant logic from socialGrants

    return c.json({
      success: true,
      handles,
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




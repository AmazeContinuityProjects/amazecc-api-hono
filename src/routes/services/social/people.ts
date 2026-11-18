/**
 * POST /api/services/social/people — look up a person by handle.
 *
 * Body: { cookies, authorizedID, csrf, handle }
 * Returns { success, person: { handle, displayName, alreadyPaired } }
 */
import { Hono } from "hono";
import { publicErrorMessage } from "../../../../src/lib/publicError";
import { identifyCaller } from "../../../../src/lib/social";
import { ensureSocialInD1 } from "../../../../src/lib/socialD1";

export const socialPeopleRouter = new Hono();

const HANDLE_RE = /^AMZ-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const PEOPLE_CACHE_TTL_MS = 300_000;
const peopleCache = new Map<string, { handle: string; displayName: string | null; alreadyPaired: boolean; expiresAt: number }>();

socialPeopleRouter.post("/people", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      cookies?: string | string[];
      authorizedID?: string;
      csrf?: string;
      handle?: string;
    };

    const result = await identifyCaller(body);
    if (!result.ok) {
      return c.json(
        { success: false, error: result.error, detail: result.detail }, result.status as any,
      );
    }

    if (!body.handle || !HANDLE_RE.test(body.handle.trim())) {
      return c.json(
        { success: false, error: "invalid_handle_format", detail: { detail: "Handle must match AMZ-XXXX-XXXX" } }, 400);
    }

    const cleanHandle = body.handle.trim().toUpperCase();
    const now = Date.now();
    const cached = peopleCache.get(cleanHandle);
    if (cached && now < cached.expiresAt) {
      return c.json({
        success: true,
        person: {
          handle: cached.handle,
          displayName: cached.displayName,
          alreadyPaired: cached.alreadyPaired,
        },
      });
    }

    const db = await ensureSocialInD1();

    let person = await db.prepare(`SELECT p.owner_key, p.handle, p.display_name,
            (SELECT COUNT(*) FROM social_grants g
              WHERE (g.owner_a = p.owner_key OR g.owner_b = p.owner_key) AND g.revoked_at IS NULL) AS grant_count
          FROM social_people p WHERE p.handle = ? LIMIT 1`)
      .bind(cleanHandle)
      .first<{ owner_key: string; handle: string; display_name: string | null; grant_count: number }>();

    if (!person) {
      const alias = await db.prepare(`SELECT register_no FROM social_handle_aliases WHERE handle = ? LIMIT 1`)
        .bind(cleanHandle).first<{ register_no: string }>();
      if (alias) {
        person = await db.prepare(`SELECT p.owner_key, p.handle, p.display_name,
                (SELECT COUNT(*) FROM social_grants g
                  WHERE (g.owner_a = p.owner_key OR g.owner_b = p.owner_key) AND g.revoked_at IS NULL) AS grant_count
              FROM social_people p WHERE p.register_no = ? LIMIT 1`)
          .bind(alias.register_no.trim().toUpperCase())
          .first<{ owner_key: string; handle: string; display_name: string | null; grant_count: number }>();
      }
    }

    if (!person) {
      return c.json({ success: false, error: "handle_not_found" }, 404);
    }

    const personData = {
      handle: person.handle,
      displayName: person.display_name || null,
      alreadyPaired: Number(person.grant_count) > 0,
    };
    if (peopleCache.size >= 5000) peopleCache.clear();
    peopleCache.set(cleanHandle, { ...personData, expiresAt: now + PEOPLE_CACHE_TTL_MS });

    return c.json({
      success: true,
      person: personData,
    });
  } catch (err: unknown) {
    console.error("[social] people error:", err);
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});




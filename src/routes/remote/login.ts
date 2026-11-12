/**
 * POST /api/remote/login — VTOP login (captcha + session).
 *
 * Returns the session cookies + csrf + authorizedID for the caller to reuse
 * across remote routes. The fire-and-forget club sync runs in the SYNC_QUEUE
 * consumer (or ctx.waitUntil as a local-dev fallback).
 */
import { Hono } from "hono";
import { attemptVtopLogin, parseDashboardIdentity } from "../../lib/vtopLogin";
import { checkRateLimit, rateLimitResponse, getClientIp } from "../../lib/rateLimit";
import { getDbPool } from "../../lib/db";
import { signClubToken } from "../../lib/clubAuth";
import { syncClubsFromVtop, type ClubsSyncJob } from "../../lib/syncClubs";
import { withDeadline } from "../../lib/vtop";

export const loginRoute = new Hono();

const DB_LOOKUP_BUDGET_MS = 5_000;

loginRoute.post("/login", async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = checkRateLimit(`login:${ip}`, 5, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const { username, password } = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
    };
    if (!username || !password) {
      return Response.json({ success: false, message: "Username and password are required" }, { status: 400 });
    }

    const outcome = await attemptVtopLogin(String(username), String(password));
    if (!outcome.ok) {
      return Response.json({ success: false, message: outcome.message }, { status: outcome.status });
    }

    const { allCookies, dashboardHtml } = outcome;
    const { csrf: new_csrf, authorizedID } = parseDashboardIdentity(dashboardHtml, String(username));

    // Fire-and-forget the daily club sync in the queue (not on the hot path).
    const syncJob: ClubsSyncJob = {
      type: "clubs-sync",
      cookies: allCookies,
      csrf: new_csrf,
      authorizedID,
    };
    const env = c.env as { SYNC_QUEUE?: { send: (msg: ClubsSyncJob) => Promise<void> } };
    try {
      if (env.SYNC_QUEUE) {
        await env.SYNC_QUEUE.send(syncJob);
      } else if (c.executionCtx?.waitUntil) {
        c.executionCtx.waitUntil(syncClubsFromVtop({ cookies: allCookies, csrf: new_csrf, authorizedID }));
      }
    } catch (queueErr) {
      console.error("[login] clubs-sync enqueue failed:", queueErr);
    }

    // Is this user a club representative? (DB read; short budget, non-fatal.)
    let clubToken: string | undefined;
    let clubRoles: Array<{ club_id: string; role: string }> = [];
    try {
      const pool = getDbPool();
      const { rows } = await withDeadline(
        pool.query("SELECT club_id, role FROM club_representatives WHERE vtop_id = $1", [authorizedID]),
        DB_LOOKUP_BUDGET_MS,
        `club_representatives lookup exceeded ${DB_LOOKUP_BUDGET_MS}ms`
      );

      if (rows.length > 0) {
        const roleMap = new Map<string, { club_id: string; role: string }>();
        for (const r of rows) {
          if (!r.club_id) continue;
          const existing = roleMap.get(r.club_id);
          if (!existing || r.role === "super-club-rep") {
            roleMap.set(r.club_id, r);
          }
        }
        clubRoles = Array.from(roleMap.values());
        clubToken = await signClubToken(authorizedID, clubRoles);
      }
    } catch (dbErr) {
      console.error("Failed to fetch club roles for login:", dbErr);
    }

    return Response.json({
      success: true,
      message: "Login successful!",
      cookies: allCookies,
      csrf: new_csrf,
      authorizedID,
      clubToken,
      clubRoles,
    });
  } catch (err: unknown) {
    console.error(err);
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 502 }
    );
  }
});

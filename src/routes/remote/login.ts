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
import { syncClubsFromVtop, type ClubsSyncJob } from "../../lib/syncClubs";

export const loginRoute = new Hono();

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

    return Response.json({
      success: true,
      message: "Login successful!",
      cookies: allCookies,
      csrf: new_csrf,
      authorizedID,
    });
  } catch (err: unknown) {
    console.error(err);
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 502 }
    );
  }
});

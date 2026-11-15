/**
 * POST /api/events/login — EventHub login.
 *
 * Returns `{ success, jsessionid }` where `jsessionid` is the compound cookie
 * fragment (`"<id>"` or `"<id>; cookiesession1=<c>"`) the frontend caches and
 * re-sends as `jsessionid` on every other /api/events/* call.
 */
import { Hono } from "hono";
import { publicErrorMessage } from "../../lib/publicError";
import { extractCookies, looksLikeLoginPage } from "../../lib/eventHubAuth";

export const eventsLoginRouter = new Hono();

eventsLoginRouter.post("/login", async (c) => {
  try {
    const { username, password } = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
    };

    if (!username || !password) {
      return Response.json(
        { success: false, error: "Username and password are required" },
        { status: 400 },
      );
    }

    const loginParams = new URLSearchParams({ username, password, validateVitian: "1" });
    const loginRes = await fetch("https://eventhubcc.vit.ac.in/EventHub/mainDashboard", {
      method: "POST",
      body: loginParams,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });

    const jsessionid = extractCookies(loginRes.headers);
    if (!jsessionid) {
      return Response.json(
        { success: false, error: "Failed to authenticate with Event Hub. Please check your credentials." },
        { status: 401 },
      );
    }

    // EventHub returns HTTP 200 + Set-Cookie even for bad credentials, so the
    // cookie alone proves nothing. A failed login re-renders the login form.
    const loginHtml = await loginRes.text();
    if (looksLikeLoginPage(loginHtml)) {
      return Response.json(
        { success: false, error: "Failed to authenticate with Event Hub. Please check your credentials." },
        { status: 401 },
      );
    }

    return Response.json({ success: true, jsessionid }, { status: 200 });
  } catch (err: unknown) {
    console.error("[events] login failed:", err);
    return Response.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
});

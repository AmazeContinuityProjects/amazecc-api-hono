/**
 * POST /api/events/paynow — generate the payment T&C auto-submit page.
 *
 * Body: { username, password, url }
 * Returns `{ status: "payment_form", html, tcUrl }`. The HTML embeds the
 * caller's EventHub credentials in a hidden form that auto-submits to the
 * T&C page — necessary because the browser holds no EventHub session.
 */
import { Hono } from "hono";
import { eventHubUrl } from "../../lib/upstreamUrl";
import { publicErrorMessage } from "../../lib/publicError";

export const eventsPaynowRouter = new Hono();

eventsPaynowRouter.post("/paynow", async (c) => {
  try {
    const { username, password, url } = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
      url?: string;
    };

    if (!username || !password || !url) {
      return Response.json(
        { error: "Missing username, password, or url" },
        { status: 400 },
      );
    }

    // Pin the caller-supplied target to Event Hub before echoing it back to
    // the client, so it cannot be used to bounce users elsewhere.
    let tcUrl: string;
    try {
      tcUrl = eventHubUrl(url);
    } catch {
      return Response.json({ error: "Invalid url" }, { status: 400 });
    }

    // Instead of fetching and parsing the T&C page, generate a page that logs
    // the user into Event Hub via a hidden form, then redirects to the T&C page.
    const htmlPayload = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Redirecting to Event Hub...</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f8fafc; color: #334155; }
                .loader { border: 3px solid #e2e8f0; border-top: 3px solid #3b82f6; border-radius: 50%; width: 24px; height: 24px; animation: spin 1s linear infinite; margin-right: 12px; }
                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                .container { display: flex; align-items: center; background: white; padding: 20px 30px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="loader"></div>
                <p>Authenticating securely with Event Hub...</p>
            </div>

            <form id="loginForm" action="https://eventhubcc.vit.ac.in/EventHub/mainDashboard" method="POST">
                <input type="hidden" name="username" value="${username.replace(/"/g, "&quot;")}" />
                <input type="hidden" name="password" value="${password.replace(/"/g, "&quot;")}" />
                <input type="hidden" name="validateVitian" value="1" />
            </form>

            <script>
                // Submit the login form as a top-level navigation to bypass Safari ITP
                document.getElementById("loginForm").submit();
            </script>
        </body>
        </html>
        `;

    return Response.json(
      { status: "payment_form", html: htmlPayload, tcUrl },
      { status: 200 },
    );
  } catch (err: unknown) {
    console.error("[events] paynow failed:", err);
    return Response.json({ error: publicErrorMessage(err) }, { status: 500 });
  }
});

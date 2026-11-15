/**
 * POST /api/events/download — stream a file from EventHub to the client.
 *
 * The caller supplies `url`, so it must be pinned to Event Hub: otherwise
 * this becomes an SSRF proxy that also hands our session cookie to a host of
 * the caller's choosing.
 */
import { Hono } from "hono";
import { getEventHubCookie } from "../../lib/eventHubAuth";
import { eventHubUrl } from "../../lib/upstreamUrl";
import { publicErrorMessage } from "../../lib/publicError";
import { credentialsRejected } from "./_shared";

export const eventsDownloadRouter = new Hono();

eventsDownloadRouter.post("/download", async (c) => {
  try {
    const { username, password, jsessionid, url } = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
      jsessionid?: string;
      url?: string;
    };

    if (!username && !jsessionid) {
      return Response.json({ error: "Missing username or jsessionid" }, { status: 400 });
    }
    if (!url) {
      return Response.json({ error: "Missing url" }, { status: 400 });
    }

    const cookie = await getEventHubCookie({ username, password, jsessionid });

    if (!cookie) {
      // Distinguish "we hold no credentials" from "these credentials were
      // rejected". (An expired cached session builds a cookie fine and fails
      // later on the login page, so this is a real credentials problem.)
      return credentialsRejected(!username && !password);
    }

    let fileUrl: string;
    try {
      fileUrl = eventHubUrl(url);
    } catch {
      return Response.json({ error: "Invalid url" }, { status: 400 });
    }

    const fileRes = await fetch(fileUrl, {
      headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
      // Certificates can be sizeable but never large; cap generously.
      signal: AbortSignal.timeout(60_000),
    });

    if (!fileRes.ok) {
      return Response.json(
        { error: `Failed to download file from Event Hub. Status: ${fileRes.status}` },
        { status: 502 },
      );
    }

    const contentType = fileRes.headers.get("content-type") || "application/pdf";
    let contentDisposition = fileRes.headers.get("content-disposition");

    if (!contentDisposition) {
      const isCert = url.toLowerCase().includes("certificate");
      contentDisposition = `attachment; filename="${isCert ? "Certificate" : "Receipt"}.pdf"`;
    }

    // Stream the file straight to the client without buffering in memory.
    return new Response(fileRes.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": contentDisposition,
      },
    });
  } catch (error: unknown) {
    console.error("[events] download failed:", error);
    return Response.json({ error: publicErrorMessage(error) }, { status: 500 });
  }
});

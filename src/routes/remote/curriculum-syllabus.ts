/**
 * POST /api/remote/curriculum/syllabus — download the PDF/ZIP syllabus for a
 * course code. Streams the upstream file straight through.
 */
import { Hono } from "hono";
import { getVtopBaseUrl, cookieHeader } from "../../lib/vtop";
import { publicErrorMessage } from "../../lib/publicError";

export const syllabusRoute = new Hono();

syllabusRoute.post("/curriculum/syllabus", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const { cookies, authorizedID, csrf, courseCode } = body;
    const cookieValue = cookieHeader({ cookies: cookies as string | string[] | undefined });
    if (!csrf || !authorizedID || !courseCode) {
      return c.json({ error: "Missing csrf, authorizedID, or courseCode" }, 400);
    }

    const params = new URLSearchParams();
    params.append("_csrf", String(csrf));
    params.append("_csrf", String(csrf)); // VTOP's form sends it twice
    params.append("authorizedID", String(authorizedID));
    params.append("courseCode", String(courseCode));

    const downloadRes = await fetch(
      `${getVtopBaseUrl()}/vtop/courseSyllabusDownload1`,
      {
        method: "POST",
        headers: {
          Cookie: cookieValue,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Referer: "https://vtopcc.vit.ac.in/vtop/academics/common/Curriculum",
        },
        body: params.toString(),
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      }
    );

    const contentType = downloadRes.headers.get("content-type") || "application/octet-stream";
    if (!downloadRes.ok) {
      const snippet = await downloadRes
        .text()
        .then((t) => t.replace(/\s+/g, " ").trim().substring(0, 300))
        .catch(() => "");
      console.error("syllabus fail:", downloadRes.status, contentType, snippet.substring(0, 200));
      return c.json(
        {
          success: false,
          error: `VTOP returned ${downloadRes.status} ${contentType}`,
          snippet,
        },
        502
      );
    }

    const ext = contentType.includes("zip") ? "zip" : "pdf";
    const contentDisposition =
      downloadRes.headers.get("content-disposition") ||
      `attachment; filename="${courseCode}_syllabus.${ext}"`;

    return new Response(downloadRes.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": contentDisposition,
      },
    });
  } catch (err: unknown) {
    console.error("syllabus error:", err instanceof Error ? err.message : String(err));
    return c.json({ success: false, error: publicErrorMessage(err) }, 500);
  }
});

import { Hono } from "hono";
import { getVtopBaseUrl, cookieHeader } from "../../lib/vtop";
export const circularsDownloadRoute = new Hono();
import { publicErrorMessage } from "../../lib/publicError";

circularsDownloadRoute.post("/circulars/download", async (c) => {
  try {
    const { cookies, authorizedID, csrf, circularId } = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const cookieValue = cookieHeader({ cookies: cookies as string | string[] | undefined });
    if (!csrf || !authorizedID || !circularId || !cookieValue)
      return c.json({ error: "Missing csrf, authorizedID, circularId or cookies" }, { status: 400 });



    const timestamp = new Date().toUTCString();
    const params = new URLSearchParams({
      _csrf: String(csrf),
      authorizedID: String(authorizedID),
      val: String(circularId),
      x: timestamp,
    });
    const url = `${getVtopBaseUrl()}/vtop/admissions/viewStatusWiseCostCentreCircularContent?${params}`;

    const downloadRes = await fetch(url, {
      method: "GET",
      headers: {
        Cookie: cookieValue,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://vtopcc.vit.ac.in/vtop/admissions/costCentreCircularsViewPageController",
      },
      redirect: "follow",
    });

    const contentType = downloadRes.headers.get("content-type") || "application/pdf";
    if (!downloadRes.ok) {
      const snippet = await downloadRes.text().then(t => t.replace(/\s+/g, " ").trim().substring(0, 300)).catch(() => "");
      return c.json({ success: false, error: `VTOP returned ${downloadRes.status}`, snippet }, { status: 502 });
    }

    const contentDisposition = downloadRes.headers.get("content-disposition") || `attachment; filename="circular.pdf"`;
    return new Response(downloadRes.body, {
      status: 200,
      headers: { "Content-Type": contentType, "Content-Disposition": contentDisposition },
    });
  } catch (err: unknown) {
    return c.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
});

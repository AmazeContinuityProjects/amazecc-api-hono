/**
 * POST /api/events/preview — fetch the event detail page and scrape it.
 *
 * Body: { eid, username?, password?, jsessionid? }
 * Returns the description, labelled meta details, and the fee input value.
 */
import { Hono } from "hono";
import * as cheerio from "cheerio";
import { getEventHubCookie } from "../../lib/eventHubAuth";
import { publicErrorMessage } from "../../lib/publicError";
import { credentialsRejected } from "./_shared";

export const eventsPreviewRouter = new Hono();

eventsPreviewRouter.post("/preview", async (c) => {
  try {
    const { username, password, jsessionid, eid } = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
      jsessionid?: string;
      eid?: string | number;
    };

    if (!eid) {
      return Response.json({ error: "Missing eid" }, { status: 400 });
    }

    const cookie = await getEventHubCookie({ username, password, jsessionid });

    if (!cookie) {
      return credentialsRejected(!username && !password);
    }

    const previewParams = new URLSearchParams({ eid: String(eid) });
    const previewRes = await fetch("https://eventhubcc.vit.ac.in/EventHub/eventPreview", {
      method: "POST",
      body: previewParams,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0",
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!previewRes.ok) {
      throw new Error(`Failed to load Event Preview: ${previewRes.status}`);
    }

    const html = await previewRes.text();
    const $ = cheerio.load(html);

    let description = "";
    const metaDetails: Record<string, string> = {};

    $(".list-group-item").each((_, el) => {
      const label = $(el).find(".fw-bold").text().trim();
      if (label === "Event Description") {
        description = $(el).find("span").not(".badge").text().trim();
      } else if (label) {
        let value = $(el).find("span").not(".badge").text().trim();
        // Sometimes the value is inside a label inside the span
        const labelText = $(el).find("span label").text().trim();
        if (labelText) value = labelText;

        metaDetails[label] = value;
      }
    });

    const feeInput = $("#EventFees1");
    if (feeInput.length) {
      metaDetails["Total Fees"] = feeInput.val()?.toString() || "0";
    }

    // Public poster image URL - the client renders it directly from the
    // EventHub id instead of us proxying a base64 blob.
    const imageSrc = `https://eventhubcc.vit.ac.in/EventHub/image/?id=${encodeURIComponent(String(eid))}`;

    return Response.json(
      { eid, imageSrc, description, metaDetails },
      { status: 200 },
    );
  } catch (err: unknown) {
    console.error("[events] preview failed:", err);
    return Response.json({ error: publicErrorMessage(err) }, { status: 500 });
  }
});

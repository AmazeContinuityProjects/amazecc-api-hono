import { Hono } from "hono";
export const transportRoute = new Hono();
import { vtopPostForm, readText, cookieHeader, formParams } from "../../lib/vtop";
import * as cheerio from "cheerio";


/**
 * Ask VTOP for the live GPS share link for a registered route.
 *
 * Returns `""` on any failure so a tracking-link outage can never take down the
 * whole transport response (the registration page is the primary payload).
 */
async function fetchBusUrl(
  cookieValue: string,
  authorizedID: string,
  csrf: string,
  busRouteId: string
): Promise<string> {
  try {
    const resp = await vtopPostForm(
      "/vtop/transport/trackMyBus",
      formParams({
        authorizedID: String(authorizedID),
        _csrf: String(csrf),
        busRouteId: String(busRouteId),
        x: Date.now().toString(),
      }),
      {
        cookies: cookieValue,
        timeoutMs: 15_000,
        headers: {
          // VTOP answers this endpoint with an HTML "Unidentified OS or Browser"
          // page when Accept isn't JSON. Force JSON here.
          Accept: "application/json",
        },
      }
    );

    const raw = await readText(resp);
    if (/^\s*<!doctype html/i.test(raw)) return "";
    const parsed = JSON.parse(raw);
    return parsed?.busUrl || "";
  } catch (err) {
    console.error("Bus tracking link unavailable:", err);
    return "";
  }
}

transportRoute.post("/transport", async (c) => {
  try {
    const { cookies, authorizedID, csrf } = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const cookieValue = cookieHeader({ cookies: cookies as string | string[] | undefined });
    if (!csrf || !authorizedID) {
      return c.json({ error: "Missing csrf or authorizedID" }, { status: 400 });
    }

    const resp = await vtopPostForm(
      "/vtop/transport/transportRegistration",
      formParams({
        verifyMenu: "true",
        authorizedID: String(authorizedID),
        _csrf: String(csrf),
        nocache: Date.now().toString(),
      }),
      { cookies: cookieValue, timeoutMs: 20_000 }
    );

    const html = await readText(resp);
    if (!html || typeof html !== "string") {
      return c.json({ hasRegistration: false, error: "Empty response from VTOP" }, { status: 200 });
    }

    const $ = cheerio.load(html);

    const busRouteId = $("#busRouteId").val() as string || "";

    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

    const tableRows: { label: string; value: string }[] = [];
    $("table.table tr").each((_, row) => {
      const tds = $(row).find("td");
      if (tds.length >= 2) {
        tableRows.push({
          label: normalize($(tds[0]).text()),
          value: normalize($(tds[1]).text()),
        });
      }
    });

    const qrCode = $('#qrAttendance img[src^="data:image"]').attr("src") || "";
    const pageCsrf = $('input[name="_csrf"]').val() as string || csrf;

    const data: Record<string, string> = {};
    for (const row of tableRows) {
      if (row.label.includes("Register Number")) data.registerNumber = row.value;
      else if (row.label.includes("Name of the Student")) data.name = row.value;
      else if (row.label.includes("Programme")) data.programme = row.value;
      else if (row.label.includes("Branch")) data.branch = row.value;
      else if (row.label.includes("Route Selected")) data.routeSelected = row.value;
      else if (row.label.includes("FP Reference Number")) data.fpReference = row.value;
      else if (row.label.includes("Payment Status")) data.paymentStatus = row.value;
    }

    const hasRegistration = !!(busRouteId && data.routeSelected && data.paymentStatus);

    // Same session, so the tracking link rides along with the registration fetch.
    // Uses the page's own csrf (falls back to the login csrf) like the VTOP page does.
    const busUrl = busRouteId
      ? await fetchBusUrl(cookieValue, String(authorizedID), pageCsrf as string, busRouteId)
      : "";

    return c.json({
      success: true,
      hasRegistration,
      ...data,
      busRouteId,
      busUrl,
      qrCode,
      pageCsrf,
    });
  } catch (error: unknown) {
    console.error("Transport fetch error:", error);
    return c.json(
      { hasRegistration: false, error: (error instanceof Error ? error.message : String(error)) || "Failed to fetch transport data" },
      { status: 200 }
    );
  }
});

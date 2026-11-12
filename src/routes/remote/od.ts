import { Hono } from "hono";
export const odRoute = new Hono();
import { vtopPostForm, readText, cookieHeader, formParams } from "../../lib/vtop";

import { parseOdDetails } from "../../lib/parsers/od-details";

odRoute.post("/od", async (c) => {
  try {
    const { cookies, authorizedID, csrf, semesterId } = (await c.req.json().catch(() => ({}))) as Record<string, unknown> & { semesterId?: string };
    const cookieValue = cookieHeader({ cookies: cookies as string | string[] | undefined });
    if (!csrf || !authorizedID) {
      return c.json({ error: "Missing csrf or authorizedID" }, { status: 400 });
    }
    if (!semesterId) {
      return c.json({ error: "Missing semesterId (e.g. CH20262701)" }, { status: 400 });
    }

    // Warm the menu session exactly like the browser (verifyMenu shell first)
    await vtopPostForm(
      "/vtop/academics/common/getStudentOdDetails",
      formParams({
        verifyMenu: "true",
        authorizedID: String(authorizedID),
        _csrf: String(csrf),
        nocache: Date.now().toString(),
      }),
      { cookies: cookieValue, timeoutMs: 20_000 }
    ).then((r) => r.text());

    // Fetch the OD table fragment (relative "searchStudentOdDetails"
    // resolves against <base href=".../vtop/">)
    const resp = await vtopPostForm(
      "/vtop/searchStudentOdDetails",
      formParams({
        authorizedID: String(authorizedID),
        semesterSubId: String(semesterId),
        _csrf: String(csrf),
      }),
      { cookies: cookieValue, timeoutMs: 20_000 }
    );

    const data = parseOdDetails(await readText(resp), String(semesterId));
    return c.json({ success: true, ...data });
  } catch (err: unknown) {
    console.error("od error:", err instanceof Error ? err.message : String(err));
    return c.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
});

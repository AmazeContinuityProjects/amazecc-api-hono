import { Hono } from "hono";
export const circularsRoute = new Hono();
import { vtopPostForm, readText, cookieHeader, formParams } from "../../lib/vtop";

import { parseCirculars } from "../../lib/parsers/circulars";

circularsRoute.post("/circulars", async (c) => {
  try {
    const { cookies, authorizedID, csrf } = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const cookieValue = cookieHeader({ cookies: cookies as string | string[] | undefined });
    if (!csrf || !authorizedID) {
      return c.json({ error: "Missing csrf or authorizedID" }, { status: 400 });
    }

    const resp = await vtopPostForm(
      "/vtop/admissions/costCentreCircularsViewPageController",
      formParams({
        verifyMenu: "true",
        authorizedID: String(authorizedID),
        _csrf: String(csrf),
        nocache: Date.now().toString(),
      }),
      { cookies: cookieValue, timeoutMs: 20_000 }
    );

    const data = parseCirculars(await readText(resp));
    return c.json({
      success: true,
      ...data,
    });
  } catch (err: unknown) {
    console.error("circulars error:", (err instanceof Error ? err.message : String(err)));
    return c.json(
      { success: false, error: (err instanceof Error ? err.message : String(err)) },
      { status: 500 }
    );
  }
});

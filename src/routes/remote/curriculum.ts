import { Hono } from "hono";
export const curriculumRoute = new Hono();
import { vtopPostForm, readText, cookieHeader, formParams } from "../../lib/vtop";

import { parseCurriculum, parseCurriculumCategoryView, extractPageCsrf } from "../../lib/parsers/curriculum";
import { publicErrorMessage } from "../../lib/publicError";

curriculumRoute.post("/curriculum", async (c) => {
  try {
    const { cookies, authorizedID, csrf } = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const cookieValue = cookieHeader({ cookies: cookies as string | string[] | undefined });
    if (!csrf || !authorizedID) {
      return c.json({ error: "Missing csrf or authorizedID" }, { status: 400 });
    }

    const CURRICULUM_REFERER = "https://vtopcc.vit.ac.in/vtop/academics/common/Curriculum";

    const resp = await vtopPostForm(
      "/vtop/academics/common/Curriculum",
      formParams({
        verifyMenu: "true",
        authorizedID: String(authorizedID),
        _csrf: String(csrf),
        nocache: Date.now().toString(),
      }),
      { cookies: cookieValue, timeoutMs: 20_000, headers: { Referer: CURRICULUM_REFERER } }
    );
    const curriculumHtml = await readText(resp);

    const data = parseCurriculum(curriculumHtml);
    const pageCsrf = extractPageCsrf(curriculumHtml) || String(csrf);

    const detailPromises = data.categories.map(async (cat) => {
      try {
        const detailResp = await vtopPostForm(
          "/vtop/academics/common/curriculumCategoryView",
          formParams({
            _csrf: pageCsrf,
            categoryId: cat.code,
            authorizedID: String(authorizedID),
            x: new Date().toUTCString(),
          }),
          { cookies: cookieValue, timeoutMs: 20_000, headers: { Referer: CURRICULUM_REFERER } }
        );

        const baskets = parseCurriculumCategoryView(await readText(detailResp));
        return { code: cat.code, baskets };
      } catch {
        return { code: cat.code, baskets: [] };
      }
    });

    const detailResults = await Promise.all(detailPromises);

    for (const detail of detailResults) {
      const entry = data.details.find(d => d.code === detail.code);
      if (entry) entry.baskets = detail.baskets;
    }

    return c.json({ success: true, pageCsrf, ...data });
  } catch (err: unknown) {
    console.error("curriculum error:", (err instanceof Error ? err.message : String(err)));
    return c.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
});

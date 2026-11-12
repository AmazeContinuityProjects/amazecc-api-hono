/**
 * POST /api/remote/bulk — run several whitelisted VTOP proxies in one
 * invocation. Unknown proxy names are dropped, never executed. A single
 * failing proxy is reported in its own result object and never fails the batch.
 */
import { Hono } from "hono";
import { runVtopProxy, VTOP_PROXY_NAMES } from "../../lib/vtop-proxy";

export const bulkRoute = new Hono();

bulkRoute.post("/bulk", async (c) => {
  try {
    const { endpoints, cookies, authorizedID, csrf } = (await c.req.json().catch(() => ({}))) as {
      endpoints?: unknown;
      cookies?: string | string[];
      authorizedID?: string;
      csrf?: string;
    };
    const requested = Array.isArray(endpoints) ? endpoints : [];
    const wanted = requested.filter(
      (e): e is string => typeof e === "string" && (VTOP_PROXY_NAMES as readonly string[]).includes(e)
    );

    if (wanted.length === 0) {
      return c.json({ success: false, error: "No supported endpoints requested" }, 400);
    }

    const results: Record<string, unknown> = {};
    await Promise.allSettled(
      wanted.map(async (name) => {
        const outcome = await runVtopProxy(name, { cookies, authorizedID, csrf });
        results[name] = outcome.body;
      })
    );

    return c.json({ success: true, results });
  } catch (error: unknown) {
    console.error("bulk error:", error);
    return c.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to run bulk request" },
      500
    );
  }
});

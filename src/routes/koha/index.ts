/**
 * /api/koha/* — Koha OPAC + catalog integration.
 *
 * Native port of the legacy Next.js Koha routes. NOT MOUNTED on
 * hono.amazecc.com: webopaccc.vit.ac.in does not answer Cloudflare's egress
 * (connection blackhole, verified 2026-11-14), so proxy to the Render
 * upstream remains the serving path. Mount with one line
 * (`app.route("/api/koha", kohaRouter)`) when the origin opens egress, then
 * smoke test /patron, /search and /detail live.
 *
 * Trust model is unchanged: patron login sends Koha card/password to OPAC
 * only; search/detail are public catalog data. The Amaze ID guard in
 * lib/guard.ts still runs before whichever mount serves these (patron =
 * any Amaze ID; search/detail remain public-by-design).
 */
import { Hono } from "hono";
import { kohaPatronRouter } from "./patron";
import { kohaSearchRouter } from "./search";
import { kohaDetailRouter } from "./detail";

export const kohaRouter = new Hono();

kohaRouter.route("/", kohaPatronRouter); // POST /patron  (guard: Amaze ID)
kohaRouter.route("/", kohaSearchRouter); // GET  /search?q=
kohaRouter.route("/", kohaDetailRouter); // GET  /detail?biblionumber=

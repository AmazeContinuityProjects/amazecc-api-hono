/**
 * /api/services/* — features built atop remote scraping and the database:
 * the marks pipeline, the unified enrollment, the faculty directory.
 */
import { Hono } from "hono";

import { marksSyncRoute } from "./marks-sync";
import { marksStatsRoute } from "./marks-stats";
import { marksTokensRoute } from "./marks-tokens";
import { enrollRoute } from "./enroll";
import { facultyRoute } from "./faculty";

export const servicesRouter = new Hono();

servicesRouter.route("/", marksSyncRoute);
servicesRouter.route("/", marksStatsRoute);
servicesRouter.route("/", marksTokensRoute);
servicesRouter.route("/", enrollRoute);
servicesRouter.route("/", facultyRoute);

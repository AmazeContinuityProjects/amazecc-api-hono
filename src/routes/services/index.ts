/**
 * /api/services/* — features built atop remote scraping and the database:
 * the unified enrollment, the faculty directory, class curves.
 */
import { Hono } from "hono";

import { marksStatsRoute } from "./marks-stats";
import { marksTokensRoute } from "./marks-tokens";
import { curvesRouter } from "./curves";
import { enrollRoute } from "./enroll";
import { facultyRoute } from "./faculty";

export const servicesRouter = new Hono();

servicesRouter.route("/", marksStatsRoute);
servicesRouter.route("/", marksTokensRoute);
servicesRouter.route("/", curvesRouter);
servicesRouter.route("/", enrollRoute);
servicesRouter.route("/", facultyRoute);

/**
 * /api/events/* — EventHub integration.
 *
 * Native port of the legacy Next.js event routes. Events carry their own
 * VIT credentials (username/password or a cached jsessionid), never Amaze
 * ID — same trust model as the VTOP scrapers, so these paths are NOT in the
 * first-party Amaze-ID guard. Everything that goes out is pinned to the
 * eventhubcc.vit.ac.in host (see lib/upstreamUrl).
 */
import { Hono } from "hono";
import { eventsListRouter } from "./list";
import { eventsLoginRouter } from "./login";
import { eventsPreviewRouter } from "./preview";
import { eventsProfileRouter } from "./profile";
import { eventsRegisterRouter } from "./register";
import { eventsDownloadRouter } from "./download";
import { eventsPaynowRouter } from "./paynow";

export const eventsRouter = new Hono();

eventsRouter.route("/", eventsListRouter); // GET  /          (public catalogue)
eventsRouter.route("/", eventsLoginRouter); // POST /login
eventsRouter.route("/", eventsPreviewRouter); // POST /preview
eventsRouter.route("/", eventsProfileRouter); // POST /profile
eventsRouter.route("/", eventsRegisterRouter); // POST /register
eventsRouter.route("/", eventsDownloadRouter); // POST /download
eventsRouter.route("/", eventsPaynowRouter); // POST /paynow

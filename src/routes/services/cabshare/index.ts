/**
 * /api/cabshare/* — CabShare ride-sharing ported from legacy.
 *
 * All routes require Amaze ID (DPoP) linked to a VTOP reg_no.
 */
import { Hono } from "hono";
import { cabshareAuthRouter } from "./auth";
import { cabshareTripsRouter } from "./trips";
import { cabshareTripsMeRouter } from "./trips-me";
import { cabshareHubsRouter } from "./hubs";
import { cabshareMatchRouter } from "./match";
import { cabshareWaitlistRouter } from "./waitlist";
import { cabshareStatsRouter } from "./stats";
import { cabshareRatingsRouter } from "./ratings";
import { cabshareNotificationsRouter } from "./notifications";
import { cabshareBlocksRouter } from "./blocks";

export const cabshareRouter = new Hono();

cabshareRouter.route("/", cabshareAuthRouter);
cabshareRouter.route("/", cabshareTripsRouter);
cabshareRouter.route("/", cabshareTripsMeRouter);
cabshareRouter.route("/", cabshareHubsRouter);
cabshareRouter.route("/", cabshareMatchRouter);
cabshareRouter.route("/", cabshareWaitlistRouter);
cabshareRouter.route("/", cabshareStatsRouter);
cabshareRouter.route("/", cabshareRatingsRouter);
cabshareRouter.route("/", cabshareNotificationsRouter);
cabshareRouter.route("/", cabshareBlocksRouter);

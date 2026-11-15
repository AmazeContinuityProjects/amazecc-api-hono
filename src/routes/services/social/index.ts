/**
 * /api/services/social/* — Social / friend-finder routes ported from legacy.
 *
 * All routes require Amaze ID (first-party guard). Identity within social is
 * established via VTOP session (identifyCaller) — VTOP is reachable from
 * Cloudflare egress, so social can go live natively.
 */
import { Hono } from "hono";
import { socialIdentitySyncRouter } from "./identity-sync";
import { socialPeopleRouter } from "./people";
import { socialTimetableRouter } from "./timetable";
import { socialPairClaimRouter } from "./pair-claim";
import { socialGrantRevokeRouter } from "./grant-revoke";
import { socialGrantVisibilityRouter } from "./grant-visibility";
import { socialSemesterRouter } from "./semester";
import { socialFfcsMatchRouter } from "./ffc-match";

export const socialRouter = new Hono();

socialRouter.route("/", socialIdentitySyncRouter);
socialRouter.route("/", socialPeopleRouter);
socialRouter.route("/", socialTimetableRouter);
socialRouter.route("/", socialPairClaimRouter);
socialRouter.route("/", socialGrantRevokeRouter);
socialRouter.route("/", socialGrantVisibilityRouter);
socialRouter.route("/", socialSemesterRouter);
socialRouter.route("/", socialFfcsMatchRouter);


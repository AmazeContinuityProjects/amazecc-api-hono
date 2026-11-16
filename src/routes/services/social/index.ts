/**
 * /api/services/social/* — Social / friend-finder routes ported from legacy.
 *
 * Routes use Amaze ID (first-party guard), with FFCS Friend Finder also
 * accepting a verified VTOP session so students can enroll before linking ID.
 * VTOP is reachable from Cloudflare egress, so social can run natively.
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


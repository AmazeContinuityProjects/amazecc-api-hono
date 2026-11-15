/**
 * /api/profile/* — Amaze ID profile management.
 *
 * All routes require Amaze ID (DPoP) linked to a VTOP reg_no.
 */
import { Hono } from "hono";
import { profilePhoneRouter } from "./phone";

export const profileRouter = new Hono();

profileRouter.route("/", profilePhoneRouter);

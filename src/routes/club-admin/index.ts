/**
 * /api/club-admin/* - club representative surface. Identity is Amaze ID
 * (shared D1 with auth.amazecc.com); a club rep is a VTOP-linked Amaze ID
 * with rows in club_representatives. No HMAC club tokens.
 */
import { Hono } from "hono";
import * as reps from "./reps";
import * as details from "./details";
import * as feed from "./feed";
import * as feedPromote from "./feed-promote";
import * as landingPage from "./landing-page";
import * as myClubs from "./my-clubs";

export const clubAdminRouter = new Hono();

clubAdminRouter.get("/my-clubs", (c) => myClubs.GET(c.req.raw));

clubAdminRouter.get("/reps", (c) => reps.GET(c.req.raw));
clubAdminRouter.post("/reps", (c) => reps.POST(c.req.raw));
clubAdminRouter.delete("/reps", (c) => reps.DELETE(c.req.raw));

clubAdminRouter.get("/details", (c) => details.GET(c.req.raw));
clubAdminRouter.post("/details", (c) => details.POST(c.req.raw));

clubAdminRouter.get("/feed", (c) => feed.GET(c.req.raw));
clubAdminRouter.post("/feed", (c) => feed.POST(c.req.raw));
clubAdminRouter.delete("/feed", (c) => feed.DELETE(c.req.raw));
clubAdminRouter.post("/feed/promote", (c) => feedPromote.POST(c.req.raw));

clubAdminRouter.get("/landing-page", (c) => landingPage.GET(c.req.raw));
clubAdminRouter.post("/landing-page", (c) => landingPage.POST(c.req.raw));

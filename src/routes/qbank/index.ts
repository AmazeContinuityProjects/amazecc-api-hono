/**
 * /api/qbank/* - question-bank admin surface (ported from the Next.js API).
 * Everything here requires an Amaze ID session with role=admin.
 * The papers download endpoint is public, matching the original.
 */
import { Hono } from "hono";
import * as questions from "./questions";
import * as bulk from "./bulk";
import * as queue from "./queue";
import * as ocr from "./ocr";
import * as publish from "./publish";
import * as reject from "./reject";
import * as importToStorage from "./import-to-storage";
import * as papersDownload from "./papers-download";

export const qbankRouter = new Hono();

/** Fabricate the Next-style context object some handlers expect. */
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

// admin CRUD
qbankRouter.get("/admin/questions", (c) => questions.GET(c.req.raw));
qbankRouter.post("/admin/questions", (c) => questions.POST(c.req.raw));
qbankRouter.patch("/admin/questions", (c) => questions.PATCH(c.req.raw));
qbankRouter.delete("/admin/questions", (c) => questions.DELETE(c.req.raw));
qbankRouter.post("/admin/questions/bulk", (c) => bulk.POST(c.req.raw));

qbankRouter.get("/admin/queue", (c) => queue.GET(c.req.raw));
qbankRouter.patch("/admin/queue", (c) => queue.PATCH(c.req.raw));

qbankRouter.post("/admin/ocr", (c) => ocr.POST(c.req.raw));
qbankRouter.post("/admin/publish", (c) => publish.POST(c.req.raw));
qbankRouter.post("/admin/reject", (c) => reject.POST(c.req.raw));
qbankRouter.post("/admin/import-to-storage", (c) => importToStorage.POST(c.req.raw));

// public download (was public in the Next.js API)
qbankRouter.get("/papers/download/:paperId", (c) =>
  papersDownload.GET(c.req.raw, ctx({ paperId: c.req.param("paperId") }))
);

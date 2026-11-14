/**
 * POST /api/qbank/upload — student paper upload.
 *
 * Amaze ID required (any signed-in user). Identity for attribution comes from
 * the session - never from the request body. Papers are moderated before
 * they become visible: every upload lands in PENDING and is approved via the
 * admin surface.
 */
import { Hono } from "hono";
import { getDbPool } from "../../lib/db";
import { verifyAmazeSession, adminUnauthorized } from "../../lib/amazeId";

export const qbankUploadRouter = new Hono();

qbankUploadRouter.post("/", async (c) => {
  const req = c.req.raw;
  const identity = await verifyAmazeSession(req);
  if (!identity) return adminUnauthorized();

  const json = (await req.json().catch(() => null)) as {
    courseCode?: string;
    title?: string;
    paperType?: string;
    examYear?: string | number;
    examSemester?: string;
    fileUrl?: string;
  } | null;
  if (!json || !json.courseCode || !json.title || !json.fileUrl) {
    return Response.json({ success: false, error: "Missing required fields" }, { status: 400 });
  }

  const uploader = identity.vtopRegNo ?? `amaze:${identity.id.slice(0, 8)}`;

  const pool = getDbPool();
  const { rows } = await pool.query(
    `INSERT INTO papers_archive
      (course_code, title, source_type, exam_year, exam_semester, file_url, uploader_reg_no, approval_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING source_id`,
    [
      json.courseCode,
      json.title,
      json.paperType || "CAT 1",
      parseInt(String(json.examYear ?? ""), 10) || new Date().getFullYear(),
      json.examSemester || "Fall",
      json.fileUrl,
      uploader,
      "PENDING",
    ],
  );

  return Response.json({ success: true, sourceId: rows[0].source_id });
});

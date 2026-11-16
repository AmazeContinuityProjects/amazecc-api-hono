import { verifyAmazeSession, adminUnauthorized } from "../../lib/amazeId";
import { getDbPool } from "../../lib/db";

/** Public courses that have at least one approved paper. */
export async function courses() {
  try {
    const pool = getDbPool();
    const { rows } = await pool.query(
      `SELECT DISTINCT course_code AS code, title
         FROM papers_archive
        WHERE approval_status = 'APPROVED'
        ORDER BY course_code`,
    );
    return Response.json({ success: true, data: rows });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

/** Public approved papers for one course. */
export async function papers(req: Request) {
  const courseCode = new URL(req.url).searchParams.get("course")?.trim();
  if (!courseCode) {
    return Response.json({ success: false, error: "course param required" }, { status: 400 });
  }

  try {
    const pool = getDbPool();
    const { rows } = await pool.query(
      `SELECT * FROM papers_archive
        WHERE course_code = $1 AND approval_status = 'APPROVED'
        ORDER BY created_at DESC`,
      [courseCode],
    );
    return Response.json({ success: true, data: rows });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

/** Public extracted questions, limited to papers that have been approved. */
export async function questions(req: Request) {
  const courseCode = new URL(req.url).searchParams.get("course")?.trim();
  if (!courseCode) {
    return Response.json({ success: false, error: "course param required" }, { status: 400 });
  }

  try {
    const pool = getDbPool();
    const { rows } = await pool.query(
      `SELECT q.*, p.source_type, p.exam_semester, p.exam_year
         FROM qbank_questions q
         JOIN papers_archive p ON q.source_id = p.source_id
        WHERE p.course_code = $1 AND p.approval_status = 'APPROVED'
        ORDER BY q.question_number`,
      [courseCode],
    );
    return Response.json({ success: true, data: rows });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength ? text : null;
}

/**
 * Submit a paper for moderation. The global Hono guard requires a valid Amaze
 * ID session; the authenticated user's linked VTOP registration number wins
 * over the optional client-supplied display value.
 */
export async function upload(req: Request) {
  const identity = await verifyAmazeSession(req);
  if (!identity) return adminUnauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isRecord(body)) {
    return Response.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }

  const courseCode = asText(body.courseCode, 32)?.toUpperCase();
  const title = asText(body.title, 200);
  const fileUrl = asText(body.fileUrl, 2048);
  if (!courseCode || !title || !fileUrl) {
    return Response.json({ success: false, error: "Missing or invalid required fields" }, { status: 400 });
  }

  let normalizedFileUrl: string;
  try {
    const parsedUrl = new URL(fileUrl);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return Response.json({ success: false, error: "fileUrl must be an HTTP(S) URL" }, { status: 400 });
    }
    normalizedFileUrl = parsedUrl.toString();
  } catch {
    return Response.json({ success: false, error: "fileUrl must be a valid HTTP(S) URL" }, { status: 400 });
  }

  const sourceType = asText(body.paperType, 40) ?? "CAT 1";
  const examSemester = asText(body.examSemester, 40) ?? "Fall";
  const examYearInput = typeof body.examYear === "string" || typeof body.examYear === "number"
    ? String(body.examYear)
    : "";
  const examYearParsed = Number.parseInt(examYearInput, 10);
  const examYear = Number.isFinite(examYearParsed) && examYearParsed >= 1900 && examYearParsed <= 2200
    ? examYearParsed
    : new Date().getFullYear();
  const uploaderRegNo = identity.vtopRegNo ?? asText(body.uploaderRegNo, 32) ?? "anonymous";

  try {
    const pool = getDbPool();
    const { rows } = await pool.query(
      `INSERT INTO papers_archive
         (course_code, title, source_type, exam_year, exam_semester, file_url, uploader_reg_no, approval_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
       RETURNING source_id`,
      [courseCode, title, sourceType, examYear, examSemester, normalizedFileUrl, uploaderRegNo],
    );
    return Response.json({ success: true, sourceId: rows[0]?.source_id });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

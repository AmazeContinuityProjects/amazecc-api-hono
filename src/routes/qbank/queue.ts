import { requireAdminAuth } from "../../lib/auth";
import { getDbPool } from "../../lib/db";

/** Port of src/app/api/qbank/admin/queue/route.ts. */

export async function GET(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  try {
    const pool = getDbPool();
    const status = new URL(req.url).searchParams.get("status");

    let queryText = `SELECT * FROM papers_archive`;
    const params: unknown[] = [];
    if (status && status !== "ALL") {
      queryText += ` WHERE approval_status = $1`;
      params.push(status);
    }
    queryText += ` ORDER BY created_at DESC`;

    const { rows } = await pool.query(queryText, params);
    return Response.json({ success: true, data: rows });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  try {
    const body = (await req.json()) as any;
    const { paperId, ...updates } = body;
    if (!paperId) return Response.json({ success: false, error: "paperId required" }, { status: 400 });

    const allowedFields: Record<string, string> = {
      title: "title",
      course_code: "course_code",
      source_type: "source_type",
      exam_year: "exam_year",
      exam_semester: "exam_semester",
      file_url: "file_url",
      approval_status: "approval_status",
      uploader_reg_no: "uploader_reg_no",
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;
    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields[key]) {
        setClauses.push(`${allowedFields[key]} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }

    if (setClauses.length === 0) {
      return Response.json({ success: false, error: "No valid fields to update" }, { status: 400 });
    }

    values.push(paperId);
    const queryText = `UPDATE papers_archive SET ${setClauses.join(", ")} WHERE source_id = $${paramIndex} RETURNING *`;
    const pool = getDbPool();
    const { rows } = await pool.query(queryText, values);

    if (rows.length === 0) {
      return Response.json({ success: false, error: "Paper not found" }, { status: 404 });
    }
    return Response.json({ success: true, data: rows[0] });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

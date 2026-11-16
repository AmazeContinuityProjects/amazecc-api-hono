import { requireSection } from"../../lib/auth";
import { ensureQbankInD1 } from "../../lib/qbankD1";

/** Port of src/app/api/qbank/admin/queue/route.ts. */

export async function GET(req: Request) {
  const auth = await requireSection('qbank')(req);
  if (auth instanceof Response) return auth;
  try {
    const status = new URL(req.url).searchParams.get("status");
    const db = await ensureQbankInD1();
    const result = status && status !== "ALL"
      ? await db.prepare(`SELECT * FROM papers_archive WHERE approval_status = ? ORDER BY created_at DESC`).bind(status).all()
      : await db.prepare(`SELECT * FROM papers_archive ORDER BY created_at DESC`).all();
    return Response.json({ success: true, data: result.results });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const auth = await requireSection('qbank')(req);
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

    const db = await ensureQbankInD1();
    const d1Clauses = setClauses.map((clause) => clause.replace(/ = \$\d+$/, " = ?"));
    const row = await db.prepare(`UPDATE papers_archive SET ${d1Clauses.join(", ")} WHERE source_id = ? RETURNING *`)
      .bind(...values, paperId).first();
    if (!row) return Response.json({ success: false, error: "Paper not found" }, { status: 404 });
    return Response.json({ success: true, data: row });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

import { requireAdminAuth } from "../../lib/auth";
import { getDbPool } from "../../lib/db";

// All handlers: `(req: Request) => Promise<Response>` — byte-compatible port
// of src/app/api/qbank/admin/questions/route.ts (Next.js).

export async function GET(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  try {
    const paperId = new URL(req.url).searchParams.get("paperId");
    if (!paperId) return Response.json({ success: false, error: "paperId required" }, { status: 400 });
    const pool = getDbPool();
    const { rows } = await pool.query(
      `SELECT * FROM qbank_questions WHERE source_id = $1 ORDER BY question_number ASC`,
      [paperId]
    );
    return Response.json({ success: true, data: rows });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  try {
    const { paperId } = (await req.json()) as any;
    if (!paperId) return Response.json({ success: false, error: "paperId required" }, { status: 400 });
    const pool = getDbPool();
    const { rows } = await pool.query(
      `INSERT INTO qbank_questions (source_id, question_number, question_text, marks, question_type)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [paperId, "New", "Enter question text here...", 0, "DESCRIPTIVE"]
    );
    return Response.json({ success: true, data: rows[0] });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  try {
    const body = (await req.json()) as any;
    const { questionId } = body;
    if (!questionId) return Response.json({ success: false, error: "questionId required" }, { status: 400 });

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;
    const addUpdate = (field: string, value: unknown) => {
      updates.push(`${field} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    };

    if ("questionText" in body) addUpdate("question_text", body.questionText);
    if ("questionNumber" in body) addUpdate("question_number", body.questionNumber);
    if ("marks" in body) addUpdate("marks", body.marks);
    if ("questionType" in body) addUpdate("question_type", body.questionType);
    if ("options" in body) addUpdate("options", body.options ? JSON.stringify(body.options) : null);
    if ("correctAnswer" in body) addUpdate("correct_answer", body.correctAnswer);
    if ("imageUrl" in body) addUpdate("image_url", body.imageUrl);
    if ("topicName" in body) addUpdate("topic_name", body.topicName);

    if (updates.length === 0) return Response.json({ success: true });

    values.push(questionId);
    const query = `UPDATE qbank_questions SET ${updates.join(", ")} WHERE question_id = $${paramIndex}`;
    const pool = getDbPool();
    await pool.query(query, values);
    return Response.json({ success: true });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  try {
    const { questionId } = (await req.json()) as any;
    if (!questionId) return Response.json({ success: false, error: "questionId required" }, { status: 400 });
    const pool = getDbPool();
    await pool.query(`DELETE FROM qbank_questions WHERE question_id = $1`, [questionId]);
    return Response.json({ success: true });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

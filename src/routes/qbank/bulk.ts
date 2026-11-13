import { requireAdminAuth } from "../../lib/auth";
import { getDbPool } from "../../lib/db";

/** Port of src/app/api/qbank/admin/questions/bulk/route.ts. */
export async function POST(req: Request) {
  try {
    const auth = await requireAdminAuth(req);
    if (auth instanceof Response) return auth;

    const { paperId, questions } = (await req.json()) as any;
    if (!paperId || !Array.isArray(questions)) {
      return Response.json({ success: false, error: "Invalid payload" }, { status: 400 });
    }

    const pool = getDbPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM qbank_questions WHERE source_id = $1", [paperId]);

      for (const q of questions) {
        await client.query(
          `INSERT INTO qbank_questions (source_id, question_number, question_type, topic_name, marks, question_text, options, correct_answer, image_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            paperId,
            q.question_number?.toString() || "1",
            q.question_type || (q.options && Object.keys(q.options).length > 0 ? "MCQ" : "DESCRIPTIVE"),
            q.topic_name || null,
            parseInt(q.marks) || 0,
            q.question_text || "",
            q.options ? JSON.stringify(q.options) : null,
            q.correct_answer || null,
            q.image_url || null,
          ]
        );
      }

      await client.query("COMMIT");
      return Response.json({ success: true, count: questions.length });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      await client.release();
    }
  } catch (error: unknown) {
    console.error("Bulk questions import error:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

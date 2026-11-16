import { requireSection } from"../../lib/auth";
import { ensureQbankInD1, nextQbankId } from "../../lib/qbankD1";

/** Port of src/app/api/qbank/admin/questions/bulk/route.ts. */
export async function POST(req: Request) {
  try {
    const auth = await requireSection('qbank')(req);
    if (auth instanceof Response) return auth;

    const { paperId, questions } = (await req.json()) as any;
    if (!paperId || !Array.isArray(questions)) {
      return Response.json({ success: false, error: "Invalid payload" }, { status: 400 });
    }

    const db = await ensureQbankInD1();
    if (db) {
      const existing = await db.prepare(`SELECT question_id FROM qbank_questions WHERE source_id = ?`)
        .bind(paperId).all<{ question_id: string }>();
      const statements: D1PreparedStatement[] = [];
      const ids: string[] = [];
      for (const q of questions) {
        const questionId = await nextQbankId();
        ids.push(questionId);
        statements.push(db.prepare(`INSERT INTO qbank_questions
          (question_id, source_id, question_number, question_type, topic_name, marks, question_text, options, correct_answer, image_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(questionId, paperId, q.question_number?.toString() || "1",
            q.question_type || (q.options && Object.keys(q.options).length > 0 ? "MCQ" : "DESCRIPTIVE"),
            q.topic_name || null, Number.parseInt(q.marks) || 0, q.question_text || "",
            q.options ? JSON.stringify(q.options) : null, q.correct_answer || null, q.image_url || null));
      }
      try {
        for (let index = 0; index < statements.length; index += 80) {
          await db.batch(statements.slice(index, index + 80));
        }
        const keep = new Set(ids);
        const staleIds = existing.results.map((row) => row.question_id).filter((id) => !keep.has(id));
        const deletes = staleIds.map((id) => db.prepare(`DELETE FROM qbank_questions WHERE question_id = ?`).bind(id));
        for (let index = 0; index < deletes.length; index += 80) {
          await db.batch(deletes.slice(index, index + 80));
        }
      } catch (error) {
        if (ids.length) {
          await db.prepare(`DELETE FROM qbank_questions WHERE question_id IN (${ids.map(() => "?").join(", ")})`)
            .bind(...ids).run().catch(() => {});
        }
        throw error;
      }
      return Response.json({ success: true, count: questions.length });
    }

    throw new Error("APP_DB is not configured");
  } catch (error: unknown) {
    console.error("Bulk questions import error:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

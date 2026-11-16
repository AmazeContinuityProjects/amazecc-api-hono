import { requireSection } from"../../lib/auth";
import { decodeQbankQuestions, ensureQbankInD1, nextQbankId } from "../../lib/qbankD1";

// All handlers: `(req: Request) => Promise<Response>` — byte-compatible port
// of src/app/api/qbank/admin/questions/route.ts (Next.js).

export async function GET(req: Request) {
  const auth = await requireSection('qbank')(req);
  if (auth instanceof Response) return auth;
  try {
    const paperId = new URL(req.url).searchParams.get("paperId");
    if (!paperId) return Response.json({ success: false, error: "paperId required" }, { status: 400 });
    const db = await ensureQbankInD1();
    const { results } = await db.prepare(`SELECT * FROM qbank_questions WHERE source_id = ? ORDER BY question_number ASC`)
        .bind(paperId).all();
    return Response.json({ success: true, data: decodeQbankQuestions(results as Array<Record<string, unknown>>) });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requireSection('qbank')(req);
  if (auth instanceof Response) return auth;
  try {
    const { paperId } = (await req.json()) as any;
    if (!paperId) return Response.json({ success: false, error: "paperId required" }, { status: 400 });
    const db = await ensureQbankInD1();
    const questionId = await nextQbankId();
    await db.prepare(`INSERT INTO qbank_questions
        (question_id, source_id, question_number, question_text, marks, question_type)
        VALUES (?, ?, 'New', 'Enter question text here...', 0, 'DESCRIPTIVE')`)
        .bind(questionId, paperId).run();
    const data = await db.prepare("SELECT * FROM qbank_questions WHERE question_id = ?")
        .bind(questionId).first();
    return Response.json({ success: true, data });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const auth = await requireSection('qbank')(req);
  if (auth instanceof Response) return auth;
  try {
    const body = (await req.json()) as any;
    const { questionId } = body;
    if (!questionId) return Response.json({ success: false, error: "questionId required" }, { status: 400 });

    const updates: string[] = [];
    const values: unknown[] = [];
    const addUpdate = (field: string, value: unknown) => {
      updates.push(`${field} = ?`);
      values.push(value);
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

    const db = await ensureQbankInD1();
    await db.prepare(`UPDATE qbank_questions SET ${updates.join(", ")} WHERE question_id = ?`)
        .bind(...values, questionId).run();
    return Response.json({ success: true });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const auth = await requireSection('qbank')(req);
  if (auth instanceof Response) return auth;
  try {
    const { questionId } = (await req.json()) as any;
    if (!questionId) return Response.json({ success: false, error: "questionId required" }, { status: 400 });
    const db = await ensureQbankInD1();
    await db.prepare(`DELETE FROM qbank_questions WHERE question_id = ?`).bind(questionId).run();
    return Response.json({ success: true });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

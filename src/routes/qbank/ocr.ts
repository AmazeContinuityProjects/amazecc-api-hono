import { requireSection } from"../../lib/auth";
import { ensureQbankInD1, nextQbankId } from "../../lib/qbankD1";

/**
 * Port of src/app/api/qbank/admin/ocr/route.ts.
 * NOTE: the upstream handler was a simulated OCR pipeline (fixed delay + mock
 * questions). The artificial 3s delay is dropped; the mock extraction remains
 * unchanged for behavioral parity.
 */
export async function POST(req: Request) {
  const auth = await requireSection('qbank')(req);
  if (auth instanceof Response) return auth;
  try {
    const { paperId } = (await req.json()) as any;
    if (!paperId) return Response.json({ error: "Paper ID is required" }, { status: 400 });

    const db = await ensureQbankInD1();
    await db.prepare(`UPDATE papers_archive SET approval_status = 'OCR_PROCESSING' WHERE source_id = ?`).bind(paperId).run();

    const extractedQuestions = [
      { num: "1", text: "Solve for x: $$\\frac{d}{dx} (e^{2x} \\sin x) = 0$$", marks: 5, type: "DESCRIPTIVE" },
      { num: "2", text: "A particle moves in a circle of radius 2m. If its speed is $$v = 4t^2$$, find its tangential acceleration at $$t = 1$$s.", marks: 10, type: "NUMERICAL" },
      { num: "3", text: "What is the time complexity of QuickSort in the worst case?", marks: 2, type: "MCQ" },
    ];

    for (const q of extractedQuestions) {
      const options = q.type === "MCQ" ? JSON.stringify({ A: "$$O(n \\log n)$$", B: "$$O(n^2)$$", C: "$$O(n)$$", D: "$$O(1)$$" }) : null;
      const answer = q.type === "MCQ" ? "B" : null;

      await db.prepare(`INSERT INTO qbank_questions
          (question_id, source_id, question_number, question_text, marks, question_type, options, correct_answer)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(await nextQbankId(), paperId, q.num, q.text, q.marks, q.type, options, answer).run();
    }

    await db.prepare(`UPDATE papers_archive SET approval_status = 'PENDING_Q_APPROVAL' WHERE source_id = ?`).bind(paperId).run();
    return Response.json({ success: true, count: extractedQuestions.length });
  } catch (error: unknown) {
    console.error("OCR Pipeline Error:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

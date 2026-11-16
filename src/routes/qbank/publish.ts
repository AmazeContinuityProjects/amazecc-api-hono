import { requireSection } from"../../lib/auth";
import { ensureQbankInD1 } from "../../lib/qbankD1";

/** Port of src/app/api/qbank/admin/publish/route.ts. */
export async function POST(req: Request) {
  const auth = await requireSection('qbank')(req);
  if (auth instanceof Response) return auth;
  try {
    const { paperId } = (await req.json()) as any;
    if (!paperId) return Response.json({ success: false, error: "paperId required" }, { status: 400 });
    const db = await ensureQbankInD1();
    await db.prepare(`UPDATE papers_archive SET approval_status = 'APPROVED' WHERE source_id = ?`).bind(paperId).run();
    return Response.json({ success: true });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

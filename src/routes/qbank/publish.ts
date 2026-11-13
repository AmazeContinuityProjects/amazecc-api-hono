import { requireSection } from"../../lib/auth";
import { getDbPool } from "../../lib/db";

/** Port of src/app/api/qbank/admin/publish/route.ts. */
export async function POST(req: Request) {
  const auth = await requireSection('qbank')(req);
  if (auth instanceof Response) return auth;
  try {
    const { paperId } = (await req.json()) as any;
    if (!paperId) return Response.json({ success: false, error: "paperId required" }, { status: 400 });
    const pool = getDbPool();
    await pool.query(`UPDATE papers_archive SET approval_status = 'APPROVED' WHERE source_id = $1`, [paperId]);
    return Response.json({ success: true });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

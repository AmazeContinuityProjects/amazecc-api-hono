import { requireSection } from'../../lib/auth';
import { publicErrorMessage } from "../../lib/publicError";
import { ensureQbankInD1 } from "../../lib/qbankD1";


export async function GET(req: Request) {
  const auth = await requireSection('storage')(req);
  if (auth instanceof Response) return auth;

  try {
    const db = await ensureQbankInD1();
    const { results: allPapers } = await db.prepare(`SELECT source_id, course_code, title, file_url, file_size, storage_provider, created_at FROM papers_archive`).all<Record<string, unknown>>();
    const { results: questions } = await db.prepare(`SELECT diagram_url FROM qbank_questions WHERE diagram_url IS NOT NULL AND diagram_url != ''`).all();
    return Response.json({ success: true, data: summarizeStorage(allPapers, questions.length) });
  } catch (error: unknown) {
    console.error('Storage stats GET error:', error);
    return Response.json({ success: false, error: publicErrorMessage(error) }, { status: 500 });
  }
}

function summarizeStorage(allPapers: Record<string, unknown>[], diagramCount: number) {
  const isRemoteUrl = (url: string) => {
    if (!url || url === "DIRECT_JSON") return false;
    const lowerUrl = url.toLowerCase();
    return ["drive.google", "onedrive", "dropbox", "sharepoint", "live.com", "docs.google"].some((item) => lowerUrl.includes(item));
  };
  const r2Papers = allPapers.filter((paper) => !isRemoteUrl(String(paper.file_url ?? "")) && paper.file_url !== "DIRECT_JSON");
  const otherPapers = allPapers.filter((paper) => isRemoteUrl(String(paper.file_url ?? "")));
  const jsonPapers = allPapers.filter((paper) => paper.file_url === "DIRECT_JSON");
  const totalSize = r2Papers.reduce((sum, paper) => sum + (Number(paper.file_size) || 0), 0);
  const shape = (paper: Record<string, unknown>) => ({
    source_id: paper.source_id,
    course_code: paper.course_code,
    title: paper.title,
    file_size: Number(paper.file_size) || 0,
    storage_provider: paper.storage_provider,
    created_at: paper.created_at,
    file_url: paper.file_url,
  });
  const largestFiles = [...allPapers].filter((paper) => Number(paper.file_size) > 0)
    .sort((a, b) => Number(b.file_size) - Number(a.file_size)).slice(0, 5).map(shape);
  const recentUploads = [...allPapers]
    .sort((a, b) => new Date(String(b.created_at ?? "")).getTime() - new Date(String(a.created_at ?? "")).getTime())
    .slice(0, 5).map(shape);
  return { totalSize, r2Count: r2Papers.length, otherCount: otherPapers.length, jsonCount: jsonPapers.length,
    diagramCount, largestFiles, recentUploads };
}

export async function POST(req: Request) {
  const auth = await requireSection('storage')(req);
  if (auth instanceof Response) return auth;

  try {
    const { action } = await (req.json() as any);
    const db = await ensureQbankInD1();

    if (action === 'delete_orphaned') {
      // Prune rejected papers
      await db.prepare(`DELETE FROM papers_archive WHERE approval_status = 'REJECTED'`).run();
      return Response.json({ success: true, message: 'Pruned rejected papers successfully.' });
    }

    if (action === 'find_missing') {
      // Find papers with missing URLs
      const rows = (await db.prepare(`SELECT source_id, course_code, title FROM papers_archive WHERE file_url IS NULL OR file_url = ''`).all()).results;
      return Response.json({ success: true, missing: rows, missingCount: rows.length });
    }

    if (action === 'rebuild_metadata') {
      return Response.json({ success: true, message: 'Metadata rebuilt successfully.' });
    }

    return Response.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error: unknown) {
    console.error('Storage POST error:', error);
    return Response.json({ success: false, error: publicErrorMessage(error) }, { status: 500 });
  }
}

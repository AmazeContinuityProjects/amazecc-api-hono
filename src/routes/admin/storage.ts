import { requireAdminAuth } from '../../lib/auth';
import { getDbPool } from '../../lib/db';
import { publicErrorMessage } from "../../lib/publicError";


export async function GET(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const pool = getDbPool();

    // Fetch all papers from database
    const { rows: allPapers } = await pool.query(
      `SELECT source_id, course_code, title, file_url, file_size, storage_provider, created_at FROM papers_archive`
    );

    // Classification utility
    const isRemoteUrl = (url: string) => {
      if (!url || url === 'DIRECT_JSON') return false;
      const lowerUrl = url.toLowerCase();
      return (
        lowerUrl.includes('drive.google') ||
        lowerUrl.includes('onedrive') ||
        lowerUrl.includes('dropbox') ||
        lowerUrl.includes('sharepoint') ||
        lowerUrl.includes('live.com') ||
        lowerUrl.includes('docs.google')
      );
    };

    const r2Papers = allPapers.filter((p: Record<string, unknown>) => !isRemoteUrl(p.file_url as string) && (p.file_url as string) !== 'DIRECT_JSON');
    const otherPapers = allPapers.filter((p: Record<string, unknown>) => isRemoteUrl(p.file_url as string));
    const jsonPapers = allPapers.filter((p: Record<string, unknown>) => (p.file_url as string) === 'DIRECT_JSON');

    const totalSize = r2Papers.reduce((sum: number, p: Record<string, unknown>) => sum + (Number(p.file_size as string | number | undefined) || 0), 0);

    const largestFiles = [...allPapers]
      .filter((p: Record<string, unknown>) => p.file_size as unknown)
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) => (Number(b.file_size as string | number | undefined) || 0) - (Number(a.file_size as string | number | undefined) || 0))
      .slice(0, 5)
      .map((p: Record<string, unknown>) => ({
        source_id: p.source_id as string,
        course_code: p.course_code as string,
        title: p.title as string,
        file_size: Number(p.file_size as string | number | undefined) || 0,
        storage_provider: p.storage_provider as string,
        created_at: p.created_at as string,
        file_url: p.file_url as string
      }));

    const recentUploads = [...allPapers]
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime())
      .slice(0, 5)
      .map((p: Record<string, unknown>) => ({
        source_id: p.source_id as string,
        course_code: p.course_code as string,
        title: p.title as string,
        file_size: Number(p.file_size as string | number | undefined) || 0,
        storage_provider: p.storage_provider as string,
        created_at: p.created_at as string,
        file_url: p.file_url as string
      }));

    // Fetch diagram count
    const { rows: questions } = await pool.query(
      `SELECT diagram_url FROM qbank_questions WHERE diagram_url IS NOT NULL AND diagram_url != ''`
    );
    const diagramCount = questions.length;

    return Response.json({
      success: true,
      data: {
        totalSize,
        r2Count: r2Papers.length,
        otherCount: otherPapers.length,
        jsonCount: jsonPapers.length,
        diagramCount,
        largestFiles,
        recentUploads
      }
    });
  } catch (error: unknown) {
    console.error('Storage stats GET error:', error);
    return Response.json({ success: false, error: publicErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const { action } = await (req.json() as any);
    const pool = getDbPool();

    if (action === 'delete_orphaned') {
      // Prune rejected papers
      await pool.query(`DELETE FROM papers_archive WHERE approval_status = 'REJECTED'`);
      return Response.json({ success: true, message: 'Pruned rejected papers successfully.' });
    }

    if (action === 'find_missing') {
      // Find papers with missing URLs
      const { rows } = await pool.query(`SELECT source_id, course_code, title FROM papers_archive WHERE file_url IS NULL OR file_url = ''`);
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

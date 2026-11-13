import { getDbPool } from '../../lib/db';
import { requireSection } from'../../lib/auth';




/**
 * @openapi
 * /api/admin/ocr:
 *   post:
 *     tags:
 *       - Admin
 *     summary: POST endpoint for /api/admin/ocr
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               paperId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Bad Request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal Server Error
 */


export async function POST(req: Request) {
  const authResult = await requireSection('ocr')(req);
  if (authResult instanceof Response) {
    return authResult;
  }

  try {
    const { paperId } = await (req.json() as any);
    if (!paperId) return Response.json({ error: 'Paper ID is required' }, { status: 400 });

    const pool = getDbPool();

    // Check if already processing
    const { rows } = await pool.query(
      `SELECT approval_status FROM papers_archive WHERE source_id = $1`,
      [paperId]
    );

    if (rows.length === 0) return Response.json({ error: 'Paper not found' }, { status: 404 });
    if (rows[0].approval_status === 'OCR_QUEUED' || rows[0].approval_status === 'OCR_PROCESSING') {
      return Response.json({ error: 'Paper is already being processed' }, { status: 400 });
    }

    // Update status to QUEUED for the local worker to pick up
    await pool.query(
      `UPDATE papers_archive SET approval_status = 'OCR_QUEUED' WHERE source_id = $1`,
      [paperId]
    );

    return Response.json({ success: true, message: 'Paper queued for local OCR processing' });
  } catch (error: unknown) {
    console.error('OCR Queue Error:', error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
import { getDbPool } from '../../lib/db';
import { requireAdminAuth } from '../../lib/auth';




/**
 * @openapi
 * /api/admin/ocr/reset:
 *   post:
 *     tags:
 *       - Admin
 *     summary: POST endpoint for /api/admin/ocr/reset
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
  const authResult = await requireAdminAuth(req);
  if (authResult instanceof Response) {
    return authResult;
  }

  try {
    const { paperId } = await (req.json() as any);
    if (!paperId) return Response.json({ error: 'Paper ID is required' }, { status: 400 });

    const pool = getDbPool();

    // Reset status to PENDING so it can be "Started" again or manually reviewed
    await pool.query(
      `UPDATE papers_archive SET approval_status = 'PENDING' WHERE source_id = $1`,
      [paperId]
    );

    return Response.json({ success: true, message: 'Paper status reset to PENDING' });
  } catch (error: unknown) {
    console.error('OCR Reset Error:', error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
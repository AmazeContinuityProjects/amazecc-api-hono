import { requireAdminAuth } from '../../lib/auth';
import { getDbPool } from '../../lib/db';
import { ensureAuditLogsTable } from '../../lib/audit';


export async function GET(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const pool = getDbPool();
    await ensureAuditLogsTable();

    const [
      usersResult,
      papersResult,
      busesResult,
      subsResult,
      transportRoutesResult,
      rulesResult,
      auditLogsResult
    ] = await Promise.all([
      pool.query(`SELECT COUNT(DISTINCT user_id) AS count FROM push_subscriptions`).catch(() => ({ rows: [{ count: 0 }] })),
      pool.query(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE approval_status = 'APPROVED') AS approved,
        COUNT(*) FILTER (WHERE approval_status = 'PENDING') AS pending,
        COUNT(*) FILTER (WHERE approval_status = 'PENDING_Q_APPROVAL') AS pending_review,
        COUNT(*) FILTER (WHERE approval_status LIKE 'OCR%') AS ocr_status,
        COUNT(*) FILTER (WHERE approval_status = 'OCR_FAILED') AS failed_ocr
      FROM papers_archive`).catch(() => ({ rows: [{ total: 0, approved: 0, pending: 0, pending_review: 0, ocr_status: 0, failed_ocr: 0 }] })),
      pool.query(`SELECT COUNT(*) AS count FROM buses`).catch(() => ({ rows: [{ count: 0 }] })),
      pool.query(`SELECT COUNT(*) AS count FROM push_subscriptions WHERE vitol_enabled = TRUE`).catch(() => ({ rows: [{ count: 0 }] })),
      pool.query(`SELECT COUNT(*) AS count FROM buses_v2`).catch(() => ({ rows: [{ count: 0 }] })),
      pool.query(`SELECT COUNT(*) AS count FROM transport_rules`).catch(() => ({ rows: [{ count: 0 }] })),
      pool.query(`
        SELECT 
          id, 
          admin_user, 
          action, 
          target_resource, 
          created_at AS timestamp,
          details,
          ip_address
        FROM admin_audit_logs 
        ORDER BY created_at DESC 
        LIMIT 100
      `).catch(() => ({ rows: [] }))
    ]);

    return Response.json({
      success: true,
      data: {
        activeUsers: Number(usersResult.rows[0]?.count || 0),
        papers: {
          total: Number(papersResult.rows[0]?.total || 0),
          approved: Number(papersResult.rows[0]?.approved || 0),
          pending: Number(papersResult.rows[0]?.pending || 0),
          pendingReview: Number(papersResult.rows[0]?.pending_review || 0),
          failedOcr: Number(papersResult.rows[0]?.failed_ocr || 0),
        },
        busRoutes: Number(busesResult.rows[0]?.count || 0),
        transportRoutes: Number(transportRoutesResult.rows[0]?.count || 0),
        transportRules: Number(rulesResult.rows[0]?.count || 0),
        vitolSubscribers: Number(subsResult.rows[0]?.count || 0),
        recentLogs: auditLogsResult.rows.map(r => ({
          id: r.id,
          admin_user: r.admin_user,
          action: r.action,
          target_resource: r.target_resource,
          timestamp: r.timestamp,
          details: r.details,
          ip_address: r.ip_address
        }))
      },
    });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
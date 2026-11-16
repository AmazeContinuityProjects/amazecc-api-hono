import { requireSection } from "../../lib/auth";
import { getAppDataDb } from "../../lib/sqlCompat";
import { ensureAuditLogsTable } from "../../lib/audit";
import { ensureQbankInD1 } from "../../lib/qbankD1";
import { ensureTransportInD1 } from "../../lib/transportD1";

export async function GET(req: Request) {
  const auth = await requireSection("dashboard")(req);
  if (auth instanceof Response) return auth;

  try {
    const db = getAppDataDb();
    await Promise.all([ensureQbankInD1(), ensureTransportInD1(), ensureAuditLogsTable()]);

    const [usersResult, papersResult, busesResult, subsResult, transportRoutesResult, rulesResult, auditLogsResult] =
      await Promise.all([
        db.query(`SELECT COUNT(DISTINCT user_id) AS count FROM push_subscriptions`),
        db.query(`SELECT COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN approval_status = 'APPROVED' THEN 1 ELSE 0 END), 0) AS approved,
          COALESCE(SUM(CASE WHEN approval_status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN approval_status = 'PENDING_Q_APPROVAL' THEN 1 ELSE 0 END), 0) AS pending_review,
          COALESCE(SUM(CASE WHEN approval_status LIKE 'OCR%' THEN 1 ELSE 0 END), 0) AS ocr_status,
          COALESCE(SUM(CASE WHEN approval_status = 'OCR_FAILED' THEN 1 ELSE 0 END), 0) AS failed_ocr
        FROM papers_archive`),
        db.query(`SELECT COUNT(*) AS count FROM buses`),
        db.query(`SELECT COUNT(*) AS count FROM push_subscriptions WHERE vitol_enabled = 1`),
        db.query(`SELECT COUNT(*) AS count FROM buses_v2`),
        db.query(`SELECT COUNT(*) AS count FROM transport_rules`),
        db.query(`SELECT id, admin_user, action, target_resource, created_at AS timestamp,
            details, ip_address
          FROM admin_audit_logs
          ORDER BY created_at DESC
          LIMIT 100`),
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
        recentLogs: auditLogsResult.rows.map((row) => ({
          id: row.id,
          admin_user: row.admin_user,
          action: row.action,
          target_resource: row.target_resource,
          timestamp: row.timestamp,
          details: row.details,
          ip_address: row.ip_address,
        })),
      },
    });
  } catch {
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

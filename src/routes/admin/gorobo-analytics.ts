import { getDbErrorStatus, getDbErrorMessage } from "../../lib/dbErrors";
import { getAppDataDb } from "../../lib/sqlCompat";
import { ensureGoroboSchema } from "../../lib/gorobo/schema";
import { requireGoroboAdmin } from "../../lib/gorobo/admin-auth";


/**
 * GET /api/admin/gorobo/analytics
 * Aggregates store performance KPIs, low stock warnings, revenue, and order velocity.
 */
export async function GET(req: Request) {
  const auth = await requireGoroboAdmin(req);
  if (auth instanceof Response) return auth;

  try {
    await ensureGoroboSchema();
    const db = getAppDataDb();

    const [
      ordersMetrics,
      todayMetrics,
      inventoryMetrics,
      lowStockList,
      walletSummary,
      recentOrders
    ] = await Promise.all([
      // Total orders & revenue stats
      db.query(`
        SELECT 
          COUNT(*) AS total_orders,
          COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_orders,
          COALESCE(SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END), 0) AS confirmed_orders,
          COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) AS processing_orders,
          COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) AS ready_orders,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_orders,
          COALESCE(SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END), 0) AS archived_orders,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN total ELSE 0 END), 0) AS completed_revenue,
          COALESCE(SUM(CASE WHEN status IN ('confirmed', 'processing', 'ready') THEN total ELSE 0 END), 0) AS active_pipeline_revenue,
          COALESCE(SUM(total), 0) AS total_quoted_revenue
        FROM gorobo_orders
      `).catch(() => ({ rows: [{}] })),

      // Today's stats
      db.query(`
        SELECT 
          COUNT(*) AS today_orders,
          COALESCE(SUM(total), 0) AS today_revenue
        FROM gorobo_orders
        WHERE created_at >= CURRENT_DATE
      `).catch(() => ({ rows: [{ today_orders: 0, today_revenue: 0 }] })),

      // Inventory metrics
      db.query(`
        SELECT 
          COUNT(*) AS total_skus,
          COALESCE(SUM(CASE WHEN stock_quantity > 0 AND in_stock = 1 THEN 1 ELSE 0 END), 0) AS in_stock_count,
          COALESCE(SUM(CASE WHEN stock_quantity <= low_stock_threshold OR in_stock = 0 THEN 1 ELSE 0 END), 0) AS low_stock_count,
          COALESCE(SUM(CASE WHEN stock_quantity = 0 THEN 1 ELSE 0 END), 0) AS out_of_stock_count,
          COUNT(DISTINCT category) AS total_categories
        FROM gorobo_items
      `).catch(() => ({ rows: [{ total_skus: 0, in_stock_count: 0, low_stock_count: 0, out_of_stock_count: 0, total_categories: 0 }] })),

      // Low stock alert items list
      db.query(`
        SELECT id, name, category, stock_quantity, low_stock_threshold, location_bin, price, in_stock
        FROM gorobo_items
        WHERE stock_quantity <= low_stock_threshold OR in_stock = false
        ORDER BY stock_quantity ASC, name ASC
        LIMIT 20
      `).catch(() => ({ rows: [] })),

      // Financial wallet summary
      db.query(`
        SELECT 
          COALESCE(SUM(CASE WHEN kind = 'profit' THEN amount ELSE 0 END), 0) AS profit_total,
          COALESCE(SUM(CASE WHEN kind = 'profit' AND status = 'settled' THEN amount ELSE 0 END), 0) AS profit_settled,
          COALESCE(SUM(CASE WHEN kind = 'gst' THEN amount ELSE 0 END), 0) AS gst_total,
          COALESCE(SUM(CASE WHEN kind = 'gst' AND status = 'settled' THEN amount ELSE 0 END), 0) AS gst_settled,
          COALESCE(SUM(CASE WHEN kind = 'cost' THEN amount ELSE 0 END), 0) AS vendor_payable,
          COALESCE(SUM(CASE WHEN kind = 'cost' AND status = 'settled' THEN amount ELSE 0 END), 0) AS vendor_paid
        FROM gorobo_wallet_entries
      `).catch(() => ({ rows: [{ profit_total: 0, profit_settled: 0, gst_total: 0, gst_settled: 0, vendor_payable: 0, vendor_paid: 0 }] })),

      // Recent 5 orders
      db.query(`
        SELECT id, user_name, phone_number, total, status, created_at, items
        FROM gorobo_orders
        ORDER BY created_at DESC
        LIMIT 5
      `).catch(() => ({ rows: [] }))
    ]);

    const om = ordersMetrics.rows[0] || {};
    const tm = todayMetrics.rows[0] || {};
    const im = inventoryMetrics.rows[0] || {};
    const wm = walletSummary.rows[0] || {};

    return Response.json({
      success: true,
      analytics: {
        today: {
          orders: Number(tm.today_orders || 0),
          revenue: Number(tm.today_revenue || 0),
        },
        orders: {
          total: Number(om.total_orders || 0),
          pending: Number(om.pending_orders || 0),
          confirmed: Number(om.confirmed_orders || 0),
          processing: Number(om.processing_orders || 0),
          ready: Number(om.ready_orders || 0),
          completed: Number(om.completed_orders || 0),
          archived: Number(om.archived_orders || 0),
          completedRevenue: Number(om.completed_revenue || 0),
          activePipelineRevenue: Number(om.active_pipeline_revenue || 0),
          totalQuotedRevenue: Number(om.total_quoted_revenue || 0),
        },
        inventory: {
          totalSkus: Number(im.total_skus || 0),
          inStockCount: Number(im.in_stock_count || 0),
          lowStockCount: Number(im.low_stock_count || 0),
          outOfStockCount: Number(im.out_of_stock_count || 0),
          totalCategories: Number(im.total_categories || 0),
          lowStockAlerts: lowStockList.rows.map(r => ({
            id: r.id,
            name: r.name,
            category: r.category,
            stockQuantity: Number(r.stock_quantity ?? 0),
            lowStockThreshold: Number(r.low_stock_threshold ?? 5),
            locationBin: r.location_bin || "",
            price: Number(r.price),
            inStock: r.in_stock,
          })),
        },
        financials: {
          profitTotal: Number(wm.profit_total || 0),
          profitSettled: Number(wm.profit_settled || 0),
          gstTotal: Number(wm.gst_total || 0),
          gstSettled: Number(wm.gst_settled || 0),
          vendorPayable: Number(wm.vendor_payable || 0),
          vendorPaid: Number(wm.vendor_paid || 0),
        },
        recentOrders: recentOrders.rows.map(r => ({
          id: r.id,
          userName: r.user_name,
          phoneNumber: r.phone_number,
          total: Number(r.total),
          status: r.status,
          createdAt: r.created_at,
          itemCount: Array.isArray(r.items) ? r.items.length : 0,
        }))
      }
    });
  } catch (error: unknown) {
    console.error("admin gorobo analytics GET error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

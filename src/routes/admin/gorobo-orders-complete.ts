/**
 * @openapi
 * /api/admin/gorobo/orders/[id]/complete:
 *   post:
 *     tags:
 *       - GoRoBo Admin
 *     summary: Complete an order and create wallet entries (admin)
 *     description: >
 *       Moves a confirmed order to completed and creates the Amaze Wallet ledger
 *       entries once: customer/profit (margin after discount + shipment),
 *       customer/gst (GST collected), vendor/cost (raw base cost paid to vendor).
 *       Running this twice is rejected (409) and never duplicates entries.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Order completed and wallet entries created
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Order not found
 *       409:
 *         description: Order is not in confirmed status
 */

import { getDbErrorStatus, getDbErrorMessage } from "../../lib/dbErrors";
import { ensureGoroboSchema, type GoroboOrderLine } from "../../lib/gorobo/schema";
import { requireGoroboAdmin } from "../../lib/gorobo/admin-auth";
import { computeQuote, computeWalletAmounts } from "../../lib/gorobo/quote";
import { mapOrderRow, type GoroboOrderRow } from "../../lib/gorobo/orders";
import { getWorkerEnv } from "../../env";


interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, context: RouteContext) {
  const auth = await requireGoroboAdmin(req);
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  try {
    await ensureGoroboSchema();
    const appDb = getWorkerEnv().APP_DB;
    if (!appDb) throw new Error("APP_DB is not configured");
    if (appDb) {
      const order = await appDb.prepare(`SELECT id, user_name, phone_number, items, total, status, subtotal,
          discount_pct, discount_amount, gst_pct, gst_amount, shipment_cost, notes, created_at
        FROM gorobo_orders WHERE id = ?`).bind(id).first<GoroboOrderRow & { items: string | GoroboOrderLine[] }>();
      if (!order) {
        return Response.json({ success: false, error: "Order not found" }, { status: 404 });
      }
      if (order.status !== "confirmed") {
        return Response.json(
          { success: false, error: `Only confirmed orders can be completed (current: ${order.status})` },
          { status: 409 },
        );
      }
      const lines = Array.isArray(order.items) ? order.items : JSON.parse(order.items || "[]") as GoroboOrderLine[];
      const quote = computeQuote({
        lines,
        discountPct: Number(order.discount_pct),
        gstPct: Number(order.gst_pct),
        shipmentCost: Number(order.shipment_cost),
      });
      const wallet = computeWalletAmounts(quote, lines);
      const results = await appDb.batch([
        appDb.prepare(`UPDATE gorobo_orders SET status = 'completed' WHERE id = ? AND status = 'confirmed'`).bind(id),
        appDb.prepare(`INSERT INTO gorobo_wallet_entries (order_id, party, kind, amount)
          SELECT ?, 'customer', 'profit', ? WHERE EXISTS (
            SELECT 1 FROM gorobo_orders WHERE id = ? AND status = 'completed'
          ) AND NOT EXISTS (SELECT 1 FROM gorobo_wallet_entries WHERE order_id = ? AND party = 'customer' AND kind = 'profit')`)
          .bind(id, wallet.profit, id, id),
        appDb.prepare(`INSERT INTO gorobo_wallet_entries (order_id, party, kind, amount)
          SELECT ?, 'customer', 'gst', ? WHERE EXISTS (
            SELECT 1 FROM gorobo_orders WHERE id = ? AND status = 'completed'
          ) AND NOT EXISTS (SELECT 1 FROM gorobo_wallet_entries WHERE order_id = ? AND party = 'customer' AND kind = 'gst')`)
          .bind(id, wallet.gst, id, id),
        appDb.prepare(`INSERT INTO gorobo_wallet_entries (order_id, party, kind, amount)
          SELECT ?, 'vendor', 'cost', ? WHERE EXISTS (
            SELECT 1 FROM gorobo_orders WHERE id = ? AND status = 'completed'
          ) AND NOT EXISTS (SELECT 1 FROM gorobo_wallet_entries WHERE order_id = ? AND party = 'vendor' AND kind = 'cost')`)
          .bind(id, wallet.cost, id, id),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) {
        const current = await appDb.prepare(`SELECT status FROM gorobo_orders WHERE id = ?`).bind(id).first<{ status: string }>();
        return Response.json(
          { success: false, error: `Only confirmed orders can be completed (current: ${current?.status ?? "missing"})` },
          { status: 409 },
        );
      }
      const freshOrder = await appDb.prepare(`SELECT id, user_name, phone_number, items, total, status, subtotal,
          discount_pct, discount_amount, gst_pct, gst_amount, shipment_cost, notes, created_at
        FROM gorobo_orders WHERE id = ?`).bind(id).first<GoroboOrderRow & { items: string | GoroboOrderLine[] }>();
      const walletRows = await appDb.prepare(`SELECT party, kind, amount, status, settled_at, created_at
        FROM gorobo_wallet_entries WHERE order_id = ? ORDER BY kind, party`).bind(id).all();
      if (!freshOrder) throw new Error(`Completed GoRobo order ${id} disappeared`);
      const normalizedOrder = {
        ...freshOrder,
        items: Array.isArray(freshOrder.items) ? freshOrder.items : JSON.parse(freshOrder.items || "[]"),
      } as GoroboOrderRow;
      return Response.json({ success: true, order: mapOrderRow(normalizedOrder), wallet: walletRows.results });
    }
    throw new Error("GoRobo order completion did not return a D1 result");
  } catch (error: unknown) {
    console.error("admin gorobo order complete error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

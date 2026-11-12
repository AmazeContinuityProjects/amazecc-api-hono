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

import { getDbPool, getDbErrorStatus, getDbErrorMessage } from "../../lib/db";
import { ensureGoroboSchema, type GoroboOrderLine } from "../../lib/gorobo/schema";
import { requireGoroboAdmin } from "../../lib/gorobo/admin-auth";
import { computeQuote, computeWalletAmounts } from "../../lib/gorobo/quote";
import { mapOrderRow, type GoroboOrderRow } from "../../lib/gorobo/orders";


interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, context: RouteContext) {
  const auth = await requireGoroboAdmin(req);
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  try {
    await ensureGoroboSchema();
    const pool = getDbPool();

    const { rows: existing } = await pool.query<GoroboOrderRow>(
      `SELECT status FROM gorobo_orders WHERE id = $1`,
      [id]
    );
    if (existing.length === 0) {
      return Response.json({ success: false, error: "Order not found" }, { status: 404 });
    }
    if (existing[0].status !== "confirmed") {
      return Response.json(
        { success: false, error: `Only confirmed orders can be completed (current: ${existing[0].status})` },
        { status: 409 }
      );
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: orderRows } = await client.query<GoroboOrderRow>(
        `SELECT id, user_name, phone_number, items, total, status, subtotal, discount_pct,
                discount_amount, gst_pct, gst_amount, shipment_cost, notes, created_at
         FROM gorobo_orders WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const order = orderRows[0];
      if (order.status !== "confirmed") {
        await client.query("ROLLBACK");
        return Response.json(
          { success: false, error: `Only confirmed orders can be completed (current: ${order.status})` },
          { status: 409 }
        );
      }

      const lines: GoroboOrderLine[] = Array.isArray(order.items) ? order.items : [];
      const quote = computeQuote({
        lines,
        discountPct: Number(order.discount_pct),
        gstPct: Number(order.gst_pct),
        shipmentCost: Number(order.shipment_cost),
      });
      const wallet = computeWalletAmounts(quote, lines);

      await client.query(
        `UPDATE gorobo_orders SET status = 'completed' WHERE id = $1`,
        [id]
      );
      await client.query(
        `INSERT INTO gorobo_wallet_entries (order_id, party, kind, amount) VALUES
         ($1, 'customer', 'profit', $2),
         ($1, 'customer', 'gst', $3),
         ($1, 'vendor', 'cost', $4)`,
        [id, wallet.profit, wallet.gst, wallet.cost]
      );

      await client.query("COMMIT");

      const { rows: freshOrder } = await client.query<GoroboOrderRow>(
        `SELECT id, user_name, phone_number, items, total, status, subtotal, discount_pct,
                discount_amount, gst_pct, gst_amount, shipment_cost, notes, created_at
         FROM gorobo_orders WHERE id = $1`,
        [id]
      );

      const { rows: walletRows } = await client.query(
        `SELECT party, kind, amount::float8, status, settled_at, created_at
         FROM gorobo_wallet_entries WHERE order_id = $1 ORDER BY kind, party`,
        [id]
      );

      return Response.json({
        success: true,
        order: mapOrderRow(freshOrder[0]),
        wallet: walletRows,
      });
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    console.error("admin gorobo order complete error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

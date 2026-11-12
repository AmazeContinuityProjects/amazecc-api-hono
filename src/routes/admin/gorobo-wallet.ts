/**
 * @openapi
 * /api/admin/gorobo/wallet:
 *   get:
 *     tags:
 *       - GoRoBo Admin
 *     summary: Amaze Wallet summary + transaction history (admin)
 *     description: >
 *       Summarizes profit, GST collected, vendor payables and customer receivables,
 *       plus a per-order transaction list with settlement status for each party.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Wallet data fetched
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */

import { getDbPool, getDbErrorStatus, getDbErrorMessage } from "../../lib/db";
import { ensureGoroboSchema } from "../../lib/gorobo/schema";
import { requireGoroboAdmin } from "../../lib/gorobo/admin-auth";


interface EntryRow {
  order_id: string;
  user_name: string;
  phone_number: string;
  created_at: string;
  party: "customer" | "vendor";
  kind: "profit" | "gst" | "cost";
  amount: number;
  status: "pending" | "settled";
}

export async function GET(req: Request) {
  const auth = await requireGoroboAdmin(req);
  if (auth instanceof Response) return auth;

  try {
    await ensureGoroboSchema();
    const pool = getDbPool();

    const { rows } = await pool.query<EntryRow>(
      `SELECT w.order_id, o.user_name, o.phone_number, o.created_at,
              w.party, w.kind, w.amount::float8, w.status
       FROM gorobo_wallet_entries w
       JOIN gorobo_orders o ON o.id = w.order_id
       ORDER BY o.created_at DESC, w.kind, w.party`
    );

    const summary = {
      profitTotal: 0,
      profitSettled: 0,
      gstTotal: 0,
      gstSettled: 0,
      vendorPayable: 0,
      vendorPaid: 0,
      customerReceivable: 0,
      customerReceived: 0,
    };

    const byOrder = new Map<
      string,
      { orderId: string; userName: string; phoneNumber: string; createdAt: string;
        customer: { profit?: EntryRow; gst?: EntryRow }; vendor: { cost?: EntryRow } }
    >();

    for (const r of rows) {
      const order = byOrder.get(r.order_id) || {
        orderId: r.order_id,
        userName: r.user_name,
        phoneNumber: r.phone_number,
        createdAt: r.created_at,
        customer: {},
        vendor: {},
      };
      if (r.party === "customer") {
        order.customer[r.kind === "profit" ? "profit" : "gst"] = r;
        if (r.kind === "profit") {
          summary.profitTotal += r.amount;
          if (r.status === "settled") summary.profitSettled += r.amount;
          summary.customerReceivable += r.amount;
          if (r.status === "settled") summary.customerReceived += r.amount;
        } else {
          summary.gstTotal += r.amount;
          if (r.status === "settled") summary.gstSettled += r.amount;
        }
      } else {
        order.vendor.cost = r;
        summary.vendorPayable += r.amount;
        if (r.status === "settled") summary.vendorPaid += r.amount;
      }
      byOrder.set(r.order_id, order);
    }

    const transactions = [...byOrder.values()].map((o) => ({
      orderId: o.orderId,
      userName: o.userName,
      phoneNumber: o.phoneNumber,
      createdAt: o.createdAt,
      customer: {
        profit: o.customer.profit ? { amount: o.customer.profit.amount, status: o.customer.profit.status } : null,
        gst: o.customer.gst ? { amount: o.customer.gst.amount, status: o.customer.gst.status } : null,
      },
      vendor: {
        cost: o.vendor.cost ? { amount: o.vendor.cost.amount, status: o.vendor.cost.status } : null,
      },
    }));

    return Response.json({ success: true, summary, transactions });
  } catch (error: unknown) {
    console.error("admin gorobo wallet GET error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

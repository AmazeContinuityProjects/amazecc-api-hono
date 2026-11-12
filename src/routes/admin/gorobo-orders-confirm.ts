/**
 * @openapi
 * /api/admin/gorobo/orders/[id]/confirm:
 *   post:
 *     tags:
 *       - GoRoBo Admin
 *     summary: Confirm a quoted order (admin)
 *     description: Moves an order from pending to confirmed. The quote must have been saved first.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Order confirmed
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Order not found
 *       409:
 *         description: Order is not in pending status
 */

import { getDbPool, getDbErrorStatus, getDbErrorMessage } from "../../lib/db";
import { ensureGoroboSchema } from "../../lib/gorobo/schema";
import { requireGoroboAdmin } from "../../lib/gorobo/admin-auth";
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
    if (existing[0].status !== "pending") {
      return Response.json(
        { success: false, error: `Only pending orders can be confirmed (current: ${existing[0].status})` },
        { status: 409 }
      );
    }

    const { rows: updated } = await pool.query<GoroboOrderRow>(
      `UPDATE gorobo_orders SET status = 'confirmed' WHERE id = $1
       RETURNING id, user_name, phone_number, items, total, status, subtotal, discount_pct,
                 discount_amount, gst_pct, gst_amount, shipment_cost, notes, created_at`,
      [id]
    );

    return Response.json({ success: true, order: mapOrderRow(updated[0]) });
  } catch (error: unknown) {
    console.error("admin gorobo order confirm error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

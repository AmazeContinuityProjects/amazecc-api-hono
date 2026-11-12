/**
 * @openapi
 * /api/admin/gorobo/orders/[id]/archive:
 *   post:
 *     tags:
 *       - GoRoBo Admin
 *     summary: Archive (cancel) an unfinalised order (admin)
 *     description: >
 *       Marks an order as archived (cancelled). No Amaze Wallet ledger entries are
 *       created. Only orders that are not yet completed can be archived. This is a
 *       soft cancellation of an unfinalised quote/customer bill.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Order archived
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Order not found
 *       409:
 *         description: Cannot archive a completed order
 */

import { getDbPool, getDbErrorStatus, getDbErrorMessage } from "../../lib/db";
import { ensureGoroboSchema } from "../../lib/gorobo/schema";
import { requireGoroboAdmin } from "../../lib/gorobo/admin-auth";
import { ORDER_SELECT, mapOrderRow, type GoroboOrderRow } from "../../lib/gorobo/orders";


interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, context: RouteContext) {
  const auth = await requireGoroboAdmin(req);
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  let reason: string | undefined;
  try {
    const body = await (req.json() as any).catch(() => ({}));
    reason = typeof body?.reason === "string" ? body.reason : undefined;
  } catch {
    reason = undefined;
  }

  try {
    await ensureGoroboSchema();
    const pool = getDbPool();

    const { rows: existing } = await pool.query<GoroboOrderRow>(
      `SELECT status, notes FROM gorobo_orders WHERE id = $1`,
      [id]
    );
    if (existing.length === 0) {
      return Response.json({ success: false, error: "Order not found" }, { status: 404 });
    }
    if (existing[0].status === "completed") {
      return Response.json(
        { success: false, error: "Cannot archive an order that is already completed" },
        { status: 409 }
      );
    }
    if (existing[0].status === "archived") {
      const { rows } = await pool.query<GoroboOrderRow>(`${ORDER_SELECT} WHERE id = $1`, [id]);
      return Response.json({ success: true, order: mapOrderRow(rows[0]), wallet: [] });
    }

    const archiveNote = reason ? ` [ARCHIVED: ${reason}]` : " [ARCHIVED]";
    const { rows } = await pool.query<GoroboOrderRow>(
      `UPDATE gorobo_orders
       SET status = 'archived', notes = notes || $2
       WHERE id = $1
       RETURNING id, user_name, phone_number, items, total, status, subtotal, discount_pct,
                 discount_amount, gst_pct, gst_amount, shipment_cost, notes, delivery_mode, maps_url, created_at`,
      [id, archiveNote]
    );

    return Response.json({ success: true, order: mapOrderRow(rows[0]), wallet: [] });
  } catch (error: unknown) {
    console.error("admin gorobo order archive error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

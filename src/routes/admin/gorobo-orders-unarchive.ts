/**
 * @openapi
 * /api/admin/gorobo/orders/[id]/unarchive:
 *   post:
 *     tags:
 *       - GoRoBo Admin
 *     summary: Unarchive (reinstate) an archived order (admin)
 *     description: >
 *       Reverts an archived (cancelled) order back to pending so it can be edited,
 *       confirmed and completed again. Strips the [ARCHIVED] note suffix.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Order reinstated to pending
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Order not found
 *       409:
 *         description: Order is not archived
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
      `SELECT status, notes FROM gorobo_orders WHERE id = $1`,
      [id]
    );
    if (existing.length === 0) {
      return Response.json({ success: false, error: "Order not found" }, { status: 404 });
    }
    if (existing[0].status !== "archived") {
      return Response.json(
        { success: false, error: `Only archived orders can be unarchived (current: ${existing[0].status})` },
        { status: 409 }
      );
    }

    const restoredNotes = (existing[0].notes || "").replace(/\s*\[ARCHIVED(?::\s*[^\[\]]*)?\]\s*$/, "");

    const { rows } = await pool.query<GoroboOrderRow>(
      `UPDATE gorobo_orders
       SET status = 'pending', notes = $2
       WHERE id = $1
       RETURNING id, user_name, phone_number, items, total, status, subtotal, discount_pct,
                 discount_amount, gst_pct, gst_amount, shipment_cost, notes, delivery_mode, maps_url, created_at`,
      [id, restoredNotes]
    );

    return Response.json({ success: true, order: mapOrderRow(rows[0]), wallet: [] });
  } catch (error: unknown) {
    console.error("admin gorobo order unarchive error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

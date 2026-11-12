/**
 * @openapi
 * /api/admin/gorobo/wallet/orders/[id]/settle:
 *   post:
 *     tags:
 *       - GoRoBo Admin
 *     summary: Mark a party's payments settled for an order (admin)
 *     description: >
 *       Marks every wallet entry of the given order + party as settled
 *       (customer = "customer paid Amaze"; vendor = "Amaze paid vendor").
 *       Idempotent — settling twice is a no-op.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [party]
 *             properties:
 *               party:
 *                 type: string
 *                 enum: [customer, vendor]
 *     responses:
 *       200:
 *         description: Entries settled
 *       400:
 *         description: Invalid party
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Order not found
 */

import { getDbPool, getDbErrorStatus, getDbErrorMessage } from "../../lib/db";
import { ensureGoroboSchema } from "../../lib/gorobo/schema";
import { requireGoroboAdmin } from "../../lib/gorobo/admin-auth";


interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, context: RouteContext) {
  const auth = await requireGoroboAdmin(req);
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await (req.json() as any);
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const party = (body as Record<string, unknown>)?.party;
  if (party !== "customer" && party !== "vendor") {
    return Response.json(
      { success: false, error: "party must be either \"customer\" or \"vendor\"" },
      { status: 400 }
    );
  }

  try {
    await ensureGoroboSchema();
    const pool = getDbPool();

    const { rows: orderRows } = await pool.query(
      `SELECT id FROM gorobo_orders WHERE id = $1`,
      [id]
    );
    if (orderRows.length === 0) {
      return Response.json({ success: false, error: "Order not found" }, { status: 404 });
    }

    const { rows } = await pool.query(
      `UPDATE gorobo_wallet_entries
       SET status = 'settled', settled_at = COALESCE(settled_at, now())
       WHERE order_id = $1 AND party = $2 AND status = 'pending'
       RETURNING party, kind, amount::float8, status, settled_at`,
      [id, party]
    );

    return Response.json({ success: true, settled: rows.length, entries: rows });
  } catch (error: unknown) {
    console.error("admin gorobo wallet settle error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

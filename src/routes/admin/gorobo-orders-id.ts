import { getDbPool, getDbErrorStatus, getDbErrorMessage } from "../../lib/db";
import { ensureGoroboSchema, GOROBO_ORDER_STATUSES } from "../../lib/gorobo/schema";
import { requireGoroboAdmin } from "../../lib/gorobo/admin-auth";
import { computeQuote, computeWalletAmounts } from "../../lib/gorobo/quote";
import { ORDER_SELECT, mapOrderRow, parseQuoteBody, QuoteValidationError, type GoroboOrderRow } from "../../lib/gorobo/orders";
import { logAdminAction } from "../../lib/audit";
import { publicErrorMessage } from "../../lib/publicError";


interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: Request, context: RouteContext) {
  const auth = await requireGoroboAdmin(req);
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  try {
    await ensureGoroboSchema();
    const pool = getDbPool();
    const { rows } = await pool.query<GoroboOrderRow>(`${ORDER_SELECT} WHERE id = $1`, [id]);
    if (rows.length === 0) {
      return Response.json({ success: false, error: "Order not found" }, { status: 404 });
    }

    const { rows: walletRows } = await pool.query(
      `SELECT party, kind, amount::float8, status, settled_at, created_at
       FROM gorobo_wallet_entries WHERE order_id = $1 ORDER BY kind, party`,
      [id]
    );

    return Response.json({ success: true, order: mapOrderRow(rows[0]), wallet: walletRows });
  } catch (error: unknown) {
    console.error("admin gorobo order GET error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

export async function PUT(req: Request, context: RouteContext) {
  const auth = await requireGoroboAdmin(req);
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await (req.json() as any);
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

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
    if (existing[0].status === "completed") {
      return Response.json(
        { success: false, error: "Cannot edit an order that is already completed" },
        { status: 409 }
      );
    }

    const parsed = await parseQuoteBody(body, pool);
    const quote = computeQuote(parsed);

    const { rows } = await pool.query<GoroboOrderRow>(
      `UPDATE gorobo_orders
       SET items = $1::jsonb,
           subtotal = $2,
           discount_pct = $3,
           discount_amount = $4,
           gst_pct = $5,
           gst_amount = $6,
           shipment_cost = $7,
           notes = $8,
           total = $9
       WHERE id = $10
       RETURNING id, user_name, phone_number, items, total, status, subtotal, discount_pct,
                 discount_amount, gst_pct, gst_amount, shipment_cost, notes, delivery_mode, maps_url, created_at`,
      [
        JSON.stringify(parsed.lines),
        quote.subtotal,
        parsed.discountPct,
        quote.discountAmount,
        parsed.gstPct,
        quote.gstAmount,
        parsed.shipmentCost,
        parsed.notes,
        quote.total,
        id,
      ]
    );

    await logAdminAction({
      admin_user: auth.username,
      action: "Update Order Quote",
      target_resource: `/api/admin/gorobo/orders/${id}`,
      details: { orderId: id, total: quote.total, subtotal: quote.subtotal }
    });

    return Response.json({ success: true, order: mapOrderRow(rows[0]) });
  } catch (error: unknown) {
    if (error instanceof QuoteValidationError) {
      return Response.json({ success: false, error: publicErrorMessage(error) }, { status: 400 });
    }
    console.error("admin gorobo order PUT error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

/**
 * PATCH /api/admin/gorobo/orders/[id]
 * Updates order status (e.g. processing, ready, confirmed, completed) or delivery notes.
 */
export async function PATCH(req: Request, context: RouteContext) {
  const auth = await requireGoroboAdmin(req);
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await (req.json() as any);
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    await ensureGoroboSchema();
    const pool = getDbPool();

    const { rows: existing } = await pool.query<GoroboOrderRow>(
      `${ORDER_SELECT} WHERE id = $1`,
      [id]
    );
    if (existing.length === 0) {
      return Response.json({ success: false, error: "Order not found" }, { status: 404 });
    }

    const current = existing[0];
    const newStatus = (body as Record<string, unknown>).status !== undefined ? ((body as Record<string, unknown>).status as string) : current.status;
    const newNotes = (body as Record<string, unknown>).notes !== undefined ? ((body as Record<string, unknown>).notes as string) : current.notes;
    const newDeliveryMode = (body as Record<string, unknown>).deliveryMode !== undefined ? ((body as Record<string, unknown>).deliveryMode as string) : (current.delivery_mode || "normal");

    if (newStatus && !(GOROBO_ORDER_STATUSES as readonly string[]).includes(newStatus as string)) {
      return Response.json(
        { success: false, error: `Invalid status. Must be one of: ${GOROBO_ORDER_STATUSES.join(", ")}` },
        { status: 400 }
      );
    }

    // Status transition handling
    if (newStatus === "completed" && current.status !== "completed") {
      // Create wallet entries if not already present
      const lines = Array.isArray(current.items) ? current.items : [];
      const quote = {
        subtotal: Number(current.subtotal),
        discountAmount: Number(current.discount_amount),
        taxable: Number(current.subtotal) - Number(current.discount_amount),
        gstAmount: Number(current.gst_amount),
        shipmentCost: Number(current.shipment_cost),
        total: Number(current.total),
      };
      const wallet = computeWalletAmounts(quote, lines);

      await pool.query(
        `INSERT INTO gorobo_wallet_entries (order_id, party, kind, amount, status)
         VALUES ($1, 'customer', 'profit', $2, 'pending'),
                ($1, 'customer', 'gst', $3, 'pending'),
                ($1, 'vendor', 'cost', $4, 'pending')
         ON CONFLICT DO NOTHING`,
        [id, wallet.profit, wallet.gst, wallet.cost]
      );
    }

    const { rows } = await pool.query<GoroboOrderRow>(
      `UPDATE gorobo_orders
       SET status = $1, notes = $2, delivery_mode = $3
       WHERE id = $4
       RETURNING id, user_name, phone_number, items, total, status, subtotal, discount_pct,
                 discount_amount, gst_pct, gst_amount, shipment_cost, notes, delivery_mode, maps_url, created_at`,
      [newStatus, newNotes, newDeliveryMode, id]
    );

    await logAdminAction({
      admin_user: auth.username,
      action: `Change Order Status to ${newStatus}`,
      target_resource: `/api/admin/gorobo/orders/${id}`,
      details: { orderId: id, prevStatus: current.status, newStatus }
    });

    return Response.json({ success: true, order: mapOrderRow(rows[0]) });
  } catch (error: unknown) {
    console.error("admin gorobo order PATCH error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

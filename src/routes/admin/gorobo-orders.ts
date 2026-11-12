import { getDbPool, getDbErrorStatus, getDbErrorMessage } from "../../lib/db";
import { ensureGoroboSchema, GOROBO_ORDER_STATUSES } from "../../lib/gorobo/schema";
import { requireGoroboAdmin } from "../../lib/gorobo/admin-auth";
import { ORDER_SELECT, mapOrderRow, type GoroboOrderRow, parseQuoteBody, QuoteValidationError } from "../../lib/gorobo/orders";
import { computeQuote } from "../../lib/gorobo/quote";
import { logAdminAction } from "../../lib/audit";
import { publicErrorMessage } from "../../lib/publicError";


export async function GET(req: Request) {
  const auth = await requireGoroboAdmin(req);
  if (auth instanceof Response) return auth;

  try {
    await ensureGoroboSchema();
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status")?.trim() || "";
    const search = searchParams.get("search")?.trim() || "";

    const pool = getDbPool();
    const conditions: string[] = [];
    const params: string[] = [];
    if (status) {
      if (!(GOROBO_ORDER_STATUSES as readonly string[]).includes(status as string)) {
        return Response.json(
          { success: false, error: `status must be one of: ${GOROBO_ORDER_STATUSES.join(", ")}` },
          { status: 400 }
        );
      }
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(user_name ILIKE $${params.length} OR phone_number ILIKE $${params.length} OR id::text ILIKE $${params.length})`);
    }

    let query = ORDER_SELECT;
    if (conditions.length) query += ` WHERE ${conditions.join(" AND ")}`;
    query += ` ORDER BY created_at DESC LIMIT 500`;

    const { rows } = await pool.query<GoroboOrderRow>(query, params);
    const orders = rows.map(mapOrderRow);
    return Response.json({ success: true, count: orders.length, orders });
  } catch (error: unknown) {
    console.error("admin gorobo orders GET error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

/**
 * POST /api/admin/gorobo/orders
 * Creates a counter/POS order or manual customer quote from the dashboard.
 */
export async function POST(req: Request) {
  const auth = await requireGoroboAdmin(req);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await (req.json() as any);
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const userName = typeof (body as Record<string, unknown>)?.userName === "string" ? ((body as Record<string, unknown>).userName as string).trim() : "";
  const phoneNumber = typeof (body as Record<string, unknown>)?.phoneNumber === "string" ? ((body as Record<string, unknown>).phoneNumber as string).trim() : "";
  const deliveryMode = typeof (body as Record<string, unknown>)?.deliveryMode === "string" ? ((body as Record<string, unknown>).deliveryMode as string).trim() : "counter_pickup";
  const mapsUrl = typeof (body as Record<string, unknown>)?.mapsUrl === "string" ? ((body as Record<string, unknown>).mapsUrl as string).trim() : "";
  const status = typeof (body as Record<string, unknown>)?.status === "string" && (GOROBO_ORDER_STATUSES as readonly string[]).includes(((body as Record<string, unknown>).status as string))
    ? ((body as Record<string, unknown>).status as string)
    : "pending";

  if (!userName) {
    return Response.json({ success: false, error: "userName is required" }, { status: 400 });
  }
  if (!phoneNumber) {
    return Response.json({ success: false, error: "phoneNumber is required" }, { status: 400 });
  }

  try {
    await ensureGoroboSchema();
    const pool = getDbPool();

    const parsed = await parseQuoteBody(body, pool);
    const quote = computeQuote({
      lines: parsed.lines,
      discountPct: parsed.discountPct,
      gstPct: parsed.gstPct,
      shipmentCost: parsed.shipmentCost,
    });

    const { rows } = await pool.query<GoroboOrderRow>(
      `INSERT INTO gorobo_orders (
        user_name, phone_number, items, total, status, subtotal,
        discount_pct, discount_amount, gst_pct, gst_amount,
        shipment_cost, notes, delivery_mode, maps_url
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id, user_name, phone_number, items, total, status, subtotal, discount_pct,
                discount_amount, gst_pct, gst_amount, shipment_cost, notes, delivery_mode, maps_url, created_at`,
      [
        userName,
        phoneNumber,
        JSON.stringify(parsed.lines),
        quote.total,
        status,
        quote.subtotal,
        parsed.discountPct,
        quote.discountAmount,
        parsed.gstPct,
        quote.gstAmount,
        parsed.shipmentCost,
        parsed.notes,
        deliveryMode,
        mapsUrl,
      ]
    );

    // If order created with confirmed or completed status, deduct stock quantities
    if (status === "confirmed" || status === "completed" || status === "processing" || status === "ready") {
      for (const line of parsed.lines) {
        if (line.itemId && !line.custom) {
          await pool.query(
            `UPDATE gorobo_items
             SET stock_quantity = GREATEST(0, stock_quantity - $1),
                 in_stock = (GREATEST(0, stock_quantity - $1) > 0)
             WHERE id = $2`,
            [line.quantity, line.itemId]
          ).catch(() => {});
        }
      }
    }

    await logAdminAction({
      admin_user: auth.username,
      action: "Create POS Order",
      target_resource: `/api/admin/gorobo/orders/${rows[0].id}`,
      details: { orderId: rows[0].id, userName, phoneNumber, total: quote.total, status }
    });

    return Response.json({ success: true, order: mapOrderRow(rows[0]) }, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof QuoteValidationError) {
      return Response.json({ success: false, error: publicErrorMessage(error) }, { status: 400 });
    }
    console.error("admin gorobo orders POST error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

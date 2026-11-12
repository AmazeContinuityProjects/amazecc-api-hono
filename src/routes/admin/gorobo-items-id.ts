import { getDbPool, getDbErrorStatus, getDbErrorMessage } from "../../lib/db";
import { ensureGoroboSchema, type GoroboItem } from "../../lib/gorobo/schema";
import { requireGoroboAdmin } from "../../lib/gorobo/admin-auth";
import { mapItemRow, computePrice } from "../../lib/gorobo/items";
import { logAdminAction } from "../../lib/audit";


interface RouteContext {
  params: Promise<{ id: string }>;
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

    const { rows: existing } = await pool.query<GoroboItem>(
      `SELECT id, name, description, price, base_price, margin, category, in_stock, image,
              sku, stock_quantity, low_stock_threshold, location_bin, datasheet_url, tags, updated_at
       FROM gorobo_items WHERE id = $1`,
      [id]
    );
    if (existing.length === 0) {
      return Response.json({ success: false, error: "Item not found" }, { status: 404 });
    }

    const current = existing[0];
    const name = (body as Record<string, unknown>).name !== undefined ? (typeof (body as Record<string, unknown>).name === "string" ? ((body as Record<string, unknown>).name as string).trim() : null) : current.name;
    const category = (body as Record<string, unknown>).category !== undefined ? (typeof (body as Record<string, unknown>).category === "string" ? ((body as Record<string, unknown>).category as string).trim() : null) : current.category;
    const basePrice = (body as Record<string, unknown>).basePrice !== undefined ? Number((body as Record<string, unknown>).basePrice) : Number(current.base_price);
    const margin = (body as Record<string, unknown>).margin !== undefined ? Number((body as Record<string, unknown>).margin) : Number(current.margin);
    const description = (body as Record<string, unknown>).description !== undefined ? (typeof (body as Record<string, unknown>).description === "string" ? ((body as Record<string, unknown>).description as string).trim() : current.description) : current.description;
    const image = (body as Record<string, unknown>).image !== undefined ? (typeof (body as Record<string, unknown>).image === "string" ? ((body as Record<string, unknown>).image as string).trim() : current.image) : current.image;
    const sku = (body as Record<string, unknown>).sku !== undefined ? (typeof (body as Record<string, unknown>).sku === "string" ? ((body as Record<string, unknown>).sku as string).trim() : "") : (current.sku || "");
    const stockQuantity = (body as Record<string, unknown>).stockQuantity !== undefined ? Math.max(0, parseInt(String((body as Record<string, unknown>).stockQuantity), 10) || 0) : Number(current.stock_quantity ?? 0);
    const lowStockThreshold = (body as Record<string, unknown>).lowStockThreshold !== undefined ? Math.max(0, parseInt(String((body as Record<string, unknown>).lowStockThreshold), 10) || 5) : Number(current.low_stock_threshold ?? 5);
    const locationBin = (body as Record<string, unknown>).locationBin !== undefined ? (typeof (body as Record<string, unknown>).locationBin === "string" ? ((body as Record<string, unknown>).locationBin as string).trim() : "") : (current.location_bin || "");
    const datasheetUrl = (body as Record<string, unknown>).datasheetUrl !== undefined ? (typeof (body as Record<string, unknown>).datasheetUrl === "string" ? ((body as Record<string, unknown>).datasheetUrl as string).trim() : "") : (current.datasheet_url || "");
    const tags = (body as Record<string, unknown>).tags !== undefined ? (Array.isArray((body as Record<string, unknown>).tags) ? (body as Record<string, unknown>).tags : []) : (Array.isArray(current.tags) ? current.tags : []);
    const inStock = (body as Record<string, unknown>).inStock !== undefined ? (body as Record<string, unknown>).inStock !== false && stockQuantity > 0 : current.in_stock && stockQuantity > 0;

    if (!name || name.length > 100) {
      return Response.json({ success: false, error: "name must be 1-100 characters" }, { status: 400 });
    }
    if (!category || category.length > 60) {
      return Response.json({ success: false, error: "category must be 1-60 characters" }, { status: 400 });
    }
    if (!Number.isFinite(basePrice) || basePrice < 0) {
      return Response.json({ success: false, error: "basePrice must be a number >= 0" }, { status: 400 });
    }
    if (!Number.isFinite(margin) || margin < 0) {
      return Response.json({ success: false, error: "margin must be a number >= 0" }, { status: 400 });
    }

    const base = Math.round(basePrice * 100) / 100;
    const marg = Math.round(margin * 100) / 100;
    const price = computePrice(base, marg);

    const { rows } = await pool.query<GoroboItem>(
      `UPDATE gorobo_items
       SET name = $1, description = $2, price = $3, base_price = $4, margin = $5,
           category = $6, in_stock = $7, image = $8, sku = $9, stock_quantity = $10,
           low_stock_threshold = $11, location_bin = $12, datasheet_url = $13, tags = $14,
           updated_at = now()
       WHERE id = $15
       RETURNING id, name, description, price, base_price, margin, category, in_stock, image,
                 sku, stock_quantity, low_stock_threshold, location_bin, datasheet_url, tags, updated_at`,
      [
        name, description, price, base, marg, category, inStock, image,
        sku, stockQuantity, lowStockThreshold, locationBin, datasheetUrl, JSON.stringify(tags), id
      ]
    );

    await logAdminAction({
      admin_user: auth.username,
      action: "Update GoRobo Item",
      target_resource: `/api/admin/gorobo/items/${id}`,
      details: { id, name, category, price, stockQuantity, inStock }
    });

    return Response.json({ success: true, item: mapItemRow(rows[0]) });
  } catch (error: unknown) {
    console.error("admin gorobo items PUT error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

export async function DELETE(req: Request, context: RouteContext) {
  const auth = await requireGoroboAdmin(req);
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  try {
    await ensureGoroboSchema();
    const pool = getDbPool();

    const { rowCount } = await pool.query(
      `DELETE FROM gorobo_items WHERE id = $1`,
      [id]
    );

    if (!rowCount || rowCount === 0) {
      return Response.json({ success: false, error: "Item not found" }, { status: 404 });
    }

    await logAdminAction({
      admin_user: auth.username,
      action: "Delete GoRobo Item",
      target_resource: `/api/admin/gorobo/items/${id}`,
      details: { id }
    });

    return Response.json({ success: true, message: `Item ${id} deleted successfully` });
  } catch (error: unknown) {
    console.error("admin gorobo items DELETE error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

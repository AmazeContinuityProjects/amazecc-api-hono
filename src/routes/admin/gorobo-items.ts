import { getDbPool, getDbErrorStatus, getDbErrorMessage } from "../../lib/db";
import { ensureGoroboSchema, type GoroboItem } from "../../lib/gorobo/schema";
import { requireGoroboAdmin } from "../../lib/gorobo/admin-auth";
import { mapItemRow, computePrice } from "../../lib/gorobo/items";
import { logAdminAction } from "../../lib/audit";


export async function GET(req: Request) {
  const auth = await requireGoroboAdmin(req);
  if (auth instanceof Response) return auth;

  try {
    await ensureGoroboSchema();
    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search")?.trim() || "";
    const category = searchParams.get("category")?.trim() || "";
    const lowStock = searchParams.get("lowStock") === "true";
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Math.min(1000, Math.max(1, parseInt(limitParam, 10))) : 220;

    const pool = getDbPool();
    let query = `SELECT id, name, description, price, base_price, margin, category, in_stock, image,
                        sku, stock_quantity, low_stock_threshold, location_bin, datasheet_url, tags, updated_at,
                        COUNT(*) OVER() AS total_catalog_count
                 FROM gorobo_items`;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(id ILIKE $${params.length} OR name ILIKE $${params.length} OR description ILIKE $${params.length} OR sku ILIKE $${params.length} OR location_bin ILIKE $${params.length})`);
    }
    if (category) {
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }
    if (lowStock) {
      conditions.push(`(stock_quantity <= low_stock_threshold OR in_stock = false)`);
    }

    if (conditions.length) query += ` WHERE ${conditions.join(" AND ")}`;
    query += ` ORDER BY category ASC, name ASC`;

    if (limit) {
      params.push(limit);
      query += ` LIMIT $${params.length}`;
    }

    const { rows } = await pool.query<GoroboItem & { total_catalog_count?: string | number }>(query, params);
    const totalCount = rows.length > 0 ? Number(rows[0].total_catalog_count ?? rows.length) : 0;
    const items = rows.map(mapItemRow);

    return Response.json({
      success: true,
      count: items.length,
      totalCount,
      hasMore: totalCount > items.length,
      limit,
      items
    });
  } catch (error: unknown) {
    console.error("admin gorobo items GET error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

export async function POST(req: Request) {
  const auth = await requireGoroboAdmin(req);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await (req.json() as any);
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof (body as Record<string, unknown>)?.name === "string" ? ((body as Record<string, unknown>).name as string).trim() : "";
  const category = typeof (body as Record<string, unknown>)?.category === "string" ? ((body as Record<string, unknown>).category as string).trim() : "";
  const basePrice = Number((body as Record<string, unknown>)?.basePrice);
  const margin = Number((body as Record<string, unknown>)?.margin);

  if (!name || name.length > 100) {
    return Response.json(
      { success: false, error: "name is required and must be at most 100 characters" },
      { status: 400 }
    );
  }
  if (!category || category.length > 60) {
    return Response.json(
      { success: false, error: "category is required and must be at most 60 characters" },
      { status: 400 }
    );
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
  const description = typeof (body as Record<string, unknown>)?.description === "string" ? ((body as Record<string, unknown>).description as string).trim() : "";
  const image = typeof (body as Record<string, unknown>)?.image === "string" ? ((body as Record<string, unknown>).image as string).trim() : "";
  const sku = typeof (body as Record<string, unknown>)?.sku === "string" ? ((body as Record<string, unknown>).sku as string).trim() : "";
  const stockQuantity = Math.max(0, parseInt(String((body as Record<string, unknown>)?.stockQuantity ?? 0), 10) || 0);
  const lowStockThreshold = Math.max(0, parseInt(String((body as Record<string, unknown>)?.lowStockThreshold ?? 5), 10) || 5);
  const locationBin = typeof (body as Record<string, unknown>)?.locationBin === "string" ? ((body as Record<string, unknown>).locationBin as string).trim() : "";
  const datasheetUrl = typeof (body as Record<string, unknown>)?.datasheetUrl === "string" ? ((body as Record<string, unknown>).datasheetUrl as string).trim() : "";
  const tags = Array.isArray((body as Record<string, unknown>)?.tags) ? ((body as Record<string, unknown>).tags as unknown[]) : [];
  const inStock = (body as Record<string, unknown>)?.inStock !== false && stockQuantity > 0;

  try {
    await ensureGoroboSchema();
    const pool = getDbPool();

    const { rows: maxRow } = await pool.query<{ next: number }>(
      `SELECT COALESCE(MAX(id::int), 0) + 1 AS next FROM gorobo_items WHERE id ~ '^[0-9]+$'`
    );
    const id = String(maxRow[0].next);

    const { rows } = await pool.query<GoroboItem>(
      `INSERT INTO gorobo_items (
        id, name, description, price, base_price, margin, category, in_stock, image,
        sku, stock_quantity, low_stock_threshold, location_bin, datasheet_url, tags
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id, name, description, price, base_price, margin, category, in_stock, image,
                sku, stock_quantity, low_stock_threshold, location_bin, datasheet_url, tags, updated_at`,
      [
        id, name, description, price, base, marg, category, inStock, image,
        sku, stockQuantity, lowStockThreshold, locationBin, datasheetUrl, JSON.stringify(tags)
      ]
    );

    await logAdminAction({
      admin_user: auth.username,
      action: "Create GoRobo Item",
      target_resource: `/api/admin/gorobo/items/${id}`,
      details: { id, name, category, price, stockQuantity }
    });

    return Response.json({ success: true, item: mapItemRow(rows[0]) }, { status: 201 });
  } catch (error: unknown) {
    console.error("admin gorobo items POST error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

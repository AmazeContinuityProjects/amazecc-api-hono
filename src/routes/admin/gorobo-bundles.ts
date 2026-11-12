import { getDbPool, getDbErrorStatus, getDbErrorMessage } from "../../lib/db";
import { ensureGoroboSchema, type GoroboBundle } from "../../lib/gorobo/schema";
import { requireGoroboAdmin } from "../../lib/gorobo/admin-auth";
import { logAdminAction } from "../../lib/audit";


export async function GET(req: Request) {
  const auth = await requireGoroboAdmin(req);
  if (auth instanceof Response) return auth;

  try {
    await ensureGoroboSchema();
    const pool = getDbPool();
    const { rows } = await pool.query<GoroboBundle>(
      `SELECT id, name, description, category, items, bundle_price, discount_pct, image, is_active, created_at, updated_at
       FROM gorobo_bundles
       ORDER BY category ASC, name ASC`
    );

    const bundles = rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      category: r.category,
      items: Array.isArray(r.items) ? r.items : [],
      bundlePrice: Number(r.bundle_price),
      discountPct: Number(r.discount_pct),
      image: r.image,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return Response.json({ success: true, count: bundles.length, bundles });
  } catch (error: unknown) {
    console.error("admin gorobo bundles GET error:", (error instanceof Error ? error.message : String(error)));
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
  const description = typeof (body as Record<string, unknown>)?.description === "string" ? ((body as Record<string, unknown>).description as string).trim() : "";
  const category = typeof (body as Record<string, unknown>)?.category === "string" ? ((body as Record<string, unknown>).category as string).trim() : "Project Kits";
  const items = Array.isArray((body as Record<string, unknown>)?.items) ? ((body as Record<string, unknown>).items as unknown[]) : [];
  const bundlePrice = Number((body as Record<string, unknown>)?.bundlePrice ?? 0);
  const discountPct = Number((body as Record<string, unknown>)?.discountPct ?? 0);
  const image = typeof (body as Record<string, unknown>)?.image === "string" ? ((body as Record<string, unknown>).image as string).trim() : "";
  const isActive = (body as Record<string, unknown>)?.isActive !== false;

  if (!name) {
    return Response.json({ success: false, error: "name is required" }, { status: 400 });
  }

  try {
    await ensureGoroboSchema();
    const pool = getDbPool();

    const { rows } = await pool.query<GoroboBundle>(
      `INSERT INTO gorobo_bundles (name, description, category, items, bundle_price, discount_pct, image, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, description, category, items, bundle_price, discount_pct, image, is_active, created_at, updated_at`,
      [name, description, category, JSON.stringify(items), bundlePrice, discountPct, image, isActive]
    );

    await logAdminAction({
      admin_user: auth.username,
      action: "Create Project Kit Bundle",
      target_resource: `/api/admin/gorobo/bundles/${rows[0].id}`,
      details: { id: rows[0].id, name, bundlePrice, itemCount: items.length }
    });

    const created = rows[0];
    return Response.json({
      success: true,
      bundle: {
        id: created.id,
        name: created.name,
        description: created.description,
        category: created.category,
        items: Array.isArray(created.items) ? created.items : [],
        bundlePrice: Number(created.bundle_price),
        discountPct: Number(created.discount_pct),
        image: created.image,
        isActive: created.is_active,
        createdAt: created.created_at,
        updatedAt: created.updated_at,
      }
    }, { status: 201 });
  } catch (error: unknown) {
    console.error("admin gorobo bundles POST error:", (error instanceof Error ? error.message : String(error)));
    return Response.json({ success: false, error: getDbErrorMessage(error) }, { status: getDbErrorStatus(error) });
  }
}

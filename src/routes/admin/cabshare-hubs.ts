import { getDbPool } from "../../lib/db";
import { requireAdminAuth, hasAdminPermission } from "../../lib/auth";

export async function POST(req: Request) {
    const admin = await requireAdminAuth(req);
    if (admin instanceof Response) return admin;
    if (!hasAdminPermission(admin, 'cabshare')) {
        return Response.json({ success: false, error: 'Permission denied: cabshare permission required' }, { status: 403 });
    }
    try {
        const body = await (req.json() as any).catch(() => ({}));
        const { hub_name, city } = body;
        if (!hub_name) return Response.json({ success: false, error: "Missing hub_name" }, { status: 400 });

        const pool = getDbPool();
        const { rows } = await pool.query(
            "INSERT INTO cabshare_hubs (hub_name, city) VALUES ($1, $2) RETURNING *",
            [hub_name, city || 'Chennai']
        );
        return Response.json({ success: true, hub: rows[0] });
    } catch (err: unknown) {
        console.error("admin/cabshare/hubs error:", err);
        return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
}

export async function DELETE(req: Request) {
    const admin = await requireAdminAuth(req);
    if (admin instanceof Response) return admin;
    if (!hasAdminPermission(admin, 'cabshare')) {
        return Response.json({ success: false, error: 'Permission denied: cabshare permission required' }, { status: 403 });
    }
    try {
        const { searchParams } = new URL(req.url);
        const hub_id = searchParams.get("hub_id");
        if (!hub_id) return Response.json({ success: false, error: "Missing hub_id" }, { status: 400 });

        const pool = getDbPool();
        await pool.query("DELETE FROM cabshare_hubs WHERE hub_id = $1", [hub_id]);
        return Response.json({ success: true, message: "Hub deleted successfully" });
    } catch (err: unknown) {
        console.error("admin/cabshare/hubs error:", err);
        return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
}

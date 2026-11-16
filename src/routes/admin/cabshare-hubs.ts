import { hasAdminPermission, requireSection } from"../../lib/auth";
import { getWorkerEnv } from "../../env";
import { ensureCabshareSchema } from "../../lib/cabshare";

export async function POST(req: Request) {
    const admin = await requireSection('cabshare')(req);
    if (admin instanceof Response) return admin;
    if (!hasAdminPermission(admin, 'cabshare')) {
        return Response.json({ success: false, error: 'Permission denied: cabshare permission required' }, { status: 403 });
    }
    try {
        const body = await (req.json() as any).catch(() => ({}));
        const { hub_name, city } = body;
        if (!hub_name) return Response.json({ success: false, error: "Missing hub_name" }, { status: 400 });

        const appDb = getWorkerEnv().APP_DB;
        if (!appDb) throw new Error("APP_DB is not configured");
        await ensureCabshareSchema();
        const hub = await appDb.prepare("INSERT INTO cabshare_hubs (hub_name, city) VALUES (?, ?) RETURNING *")
            .bind(hub_name, city || 'Chennai').first();
        return Response.json({ success: true, hub });
    } catch (err: unknown) {
        console.error("admin/cabshare/hubs error:", err);
        return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
}

export async function DELETE(req: Request) {
    const admin = await requireSection('cabshare')(req);
    if (admin instanceof Response) return admin;
    if (!hasAdminPermission(admin, 'cabshare')) {
        return Response.json({ success: false, error: 'Permission denied: cabshare permission required' }, { status: 403 });
    }
    try {
        const { searchParams } = new URL(req.url);
        const hub_id = searchParams.get("hub_id");
        if (!hub_id) return Response.json({ success: false, error: "Missing hub_id" }, { status: 400 });

        const appDb = getWorkerEnv().APP_DB;
        if (!appDb) throw new Error("APP_DB is not configured");
        await ensureCabshareSchema();
        await appDb.prepare("DELETE FROM cabshare_hubs WHERE hub_id = ?").bind(hub_id).run();
        return Response.json({ success: true, message: "Hub deleted successfully" });
    } catch (err: unknown) {
        console.error("admin/cabshare/hubs error:", err);
        return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
}

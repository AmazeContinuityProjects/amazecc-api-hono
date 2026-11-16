import { hasAdminPermission, requireSection } from"../../lib/auth";
import { getWorkerEnv } from "../../env";
import { ensureCabshareSchema } from "../../lib/cabshare";

export async function GET(req: Request) {
    const admin = await requireSection('cabshare')(req);
    if (admin instanceof Response) return admin;
    if (!hasAdminPermission(admin, 'cabshare')) {
        return Response.json({ success: false, error: 'Permission denied: cabshare permission required' }, { status: 403 });
    }
    try {
        const appDb = getWorkerEnv().APP_DB;
        if (!appDb) throw new Error("APP_DB is not configured");
        await ensureCabshareSchema();
        const rows = (await appDb.prepare(`
                SELECT t.*, u.name, u.reg_number, u.phone_number, h.hub_name
                FROM cabshare_trips t
                JOIN cabshare_users u ON t.user_id = u.user_id
                JOIN cabshare_hubs h ON t.hub_id = h.hub_id
                ORDER BY t.created_at DESC
            `).all<any>()).results;

        // Fetch match requests for each trip
        for (const trip of rows) {
            const requests = (await appDb.prepare(`
                    SELECT m.id as match_id, m.status, u.name, u.reg_number, u.phone_number
                    FROM cabshare_match_events m JOIN cabshare_users u ON m.requester_id = u.user_id
                    WHERE m.trip_id = ? ORDER BY m.created_at DESC
                `).bind(trip.trip_id).all<any>()).results;
            trip.requests = requests;
        }

        return Response.json({ success: true, trips: rows });
    } catch (err: unknown) {
        console.error("admin/cabshare/trips error:", err);
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
        const trip_id = searchParams.get("trip_id");
        if (!trip_id) return Response.json({ success: false, error: "Missing trip_id" }, { status: 400 });

        const appDb = getWorkerEnv().APP_DB;
        if (!appDb) throw new Error("APP_DB is not configured");
        await ensureCabshareSchema();
        await appDb.prepare("DELETE FROM cabshare_trips WHERE trip_id = ?").bind(trip_id).run();
        return Response.json({ success: true, message: "Trip deleted successfully" });
    } catch (err: unknown) {
        console.error("admin/cabshare/trips error:", err);
        return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
}

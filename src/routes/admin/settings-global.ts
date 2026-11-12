import { getDbPool } from "../../lib/db";
import { requireAdminAuth } from "../../lib/auth";
import { publicErrorMessage } from "../../lib/publicError";

export async function PUT(req: Request) {
    const authResult = await requireAdminAuth(req);
    if (authResult instanceof Response) return authResult;

    try {
        const body = await (req.json() as any).catch(() => ({}));
        const { key, value } = body;

        if (!key) {
            return Response.json({ success: false, error: "Missing key" }, { status: 400 });
        }

        const pool = getDbPool();
        await pool.query(`
            CREATE TABLE IF NOT EXISTS app_config (
                key TEXT PRIMARY KEY,
                value JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_at TIMESTAMPTZ DEFAULT now()
            )
        `);

        await pool.query(`
            INSERT INTO app_config (key, value, updated_at)
            VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()
        `, [key, JSON.stringify(value)]);

        return Response.json({ success: true });
    } catch (err: unknown) {
        return Response.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
    }
}

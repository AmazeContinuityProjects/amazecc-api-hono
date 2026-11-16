import { writeAppConfig } from "../../lib/appConfig";
import { requireSection } from"../../lib/auth";
import { publicErrorMessage } from "../../lib/publicError";

export async function PUT(req: Request) {
    const authResult = await requireSection('settings')(req);
    if (authResult instanceof Response) return authResult;

    try {
        const body = await (req.json() as any).catch(() => ({}));
        const { key, value } = body;

        if (!key) {
            return Response.json({ success: false, error: "Missing key" }, { status: 400 });
        }

        await writeAppConfig(String(key), value);

        return Response.json({ success: true });
    } catch (err: unknown) {
        return Response.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
    }
}

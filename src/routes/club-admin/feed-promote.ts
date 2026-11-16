import { getAppDataDb } from "../../lib/sqlCompat";
import { migrateLegacyPromotions } from "../../lib/promoteHash";
import { checkRateLimit, rateLimitResponse, getClientIp } from "../../lib/rateLimit";

/** Port of src/app/api/club-admin/feed/promote/route.ts. */
export async function POST(req: Request) {
  const rl = checkRateLimit(`promote:${getClientIp(req)}`, 30, 60000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);
  try {
    const { post_id, vtop_id } = (await req.json()) as any;

    if (!post_id || !vtop_id) {
      return Response.json({ success: false, error: "post_id and vtop_id are required" }, { status: 400 });
    }

    if (typeof vtop_id !== "string" || !/^[0-9A-Za-z]{6,15}$/.test(vtop_id.trim())) {
      return Response.json({ success: false, error: "Invalid vtop_id" }, { status: 400 });
    }

    const db = getAppDataDb();
    const user_hash = await migrateLegacyPromotions(db as any, vtop_id);

    const { rowCount } = await db.query(
      "SELECT id FROM post_promotions WHERE post_id = $1 AND user_hash = $2",
      [post_id, user_hash]
    );

    if (rowCount && rowCount > 0) {
      await db.query("DELETE FROM post_promotions WHERE post_id = $1 AND user_hash = $2", [post_id, user_hash]);
      return Response.json({ success: true, promoted: false });
    }
    await db.query("INSERT INTO post_promotions (id, post_id, user_hash) VALUES ($1, $2, $3)",
      [crypto.randomUUID(), String(post_id), user_hash]);
    return Response.json({ success: true, promoted: true });
  } catch (error) {
    console.error("Failed to promote post:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

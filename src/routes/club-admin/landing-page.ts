import { requireClubAuth } from "../../lib/clubAuth";
import { getDbPool } from "../../lib/db";

/** Port of src/app/api/club-admin/landing-page/route.ts. */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const club_id = searchParams.get("club_id");

    if (!club_id) {
      return Response.json({ success: false, error: "club_id is required" }, { status: 400 });
    }

    const pool = getDbPool();
    const { rows } = await pool.query("SELECT * FROM club_landing_pages WHERE club_id = $1", [club_id]);

    return Response.json({ success: true, landingPage: rows[0] || null });
  } catch (error) {
    console.error("Failed to fetch club landing page:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requireClubAuth(req);
  if (auth instanceof Response) return auth;
  try {
    const body = (await req.json()) as any;
    let club_id = auth.club_id;
    const pool = getDbPool();

    if (body.club_id && String(body.club_id).trim() !== String(auth.club_id).trim()) {
      const requestedClubId = String(body.club_id).trim();
      if (auth.role !== "super-club-rep") {
        const { rowCount } = await pool.query(
          "SELECT 1 FROM club_representatives WHERE vtop_id = $1 AND club_id = $2",
          [auth.vtop_id, requestedClubId]
        );
        if (!rowCount) {
          return Response.json({ success: false, error: "Unauthorized for this club" }, { status: 403 });
        }
      }
      club_id = requestedClubId;
    }

    const { theme, showcase_projects, popular_events } = body;

    const { rows } = await pool.query(
      `INSERT INTO club_landing_pages (club_id, theme, showcase_projects, popular_events, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (club_id) DO UPDATE SET
         theme = EXCLUDED.theme,
         showcase_projects = EXCLUDED.showcase_projects,
         popular_events = EXCLUDED.popular_events,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        club_id,
        JSON.stringify(theme || { primary_color: "#3B82F6", mode: "light" }),
        JSON.stringify(showcase_projects || []),
        JSON.stringify(popular_events || []),
      ]
    );

    return Response.json({ success: true, landingPage: rows[0] });
  } catch (error) {
    console.error("Failed to update club landing page:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

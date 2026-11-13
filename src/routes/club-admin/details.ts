import { requireClubAuth } from "../../lib/clubAuth";
import { getDbPool } from "../../lib/db";

/** Port of src/app/api/club-admin/details/route.ts. */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const club_id = searchParams.get("club_id");

    if (!club_id) {
      return Response.json({ success: false, error: "club_id is required" }, { status: 400 });
    }

    const pool = getDbPool();
    const { rows } = await pool.query("SELECT * FROM club_details WHERE club_id = $1", [club_id]);

    if (rows.length === 0) {
      return Response.json({ success: false, error: "Club not found" }, { status: 404 });
    }
    return Response.json({ success: true, details: rows[0] });
  } catch (error) {
    console.error("Failed to fetch club details:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requireClubAuth(req);
  if (auth instanceof Response) return auth;
  try {
    const data = (await req.json()) as any;
    let club_id = auth.club_id;

    const pool = getDbPool();

    if (data.club_id && data.club_id !== auth.club_id) {
      if (auth.role !== "super-club-rep") {
        const { rowCount } = await pool.query(
          "SELECT 1 FROM club_representatives WHERE vtop_id = $1 AND club_id = $2",
          [auth.vtop_id, data.club_id]
        );
        if (!rowCount) {
          return Response.json({ success: false, error: "Unauthorized for this club" }, { status: 403 });
        }
      }
      club_id = data.club_id;
    }

    const {
      mission,
      description,
      hiring_process,
      website,
      recruitment_link,
      instagram,
      whatsapp,
      poc,
      email,
      poc_phone,
      logo_url,
    } = data;

    const { rowCount } = await pool.query("SELECT club_id FROM club_details WHERE club_id = $1", [club_id]);

    if (rowCount && rowCount > 0) {
      await pool.query(
        `UPDATE club_details
            SET mission = $1, description = $2, hiring_process = $3, website = $4, recruitment_link = $5,
                instagram = $6, whatsapp = $7, poc = $8, email = $9, poc_phone = $10, logo_url = $11,
                updated_at = CURRENT_TIMESTAMP
          WHERE club_id = $12`,
        [mission, description, hiring_process, website, recruitment_link, instagram, whatsapp, poc, email, poc_phone, logo_url || null, club_id]
      );
    } else {
      await pool.query(
        `INSERT INTO club_details (club_id, club_name, mission, description, hiring_process, website, recruitment_link, instagram, whatsapp, poc, email, poc_phone, logo_url)
         VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [club_id, mission, description, hiring_process, website, recruitment_link, instagram, whatsapp, poc, email, poc_phone, logo_url || null]
      );
    }

    return Response.json({ success: true, message: "Details updated successfully" });
  } catch (error) {
    console.error("Failed to update club details:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

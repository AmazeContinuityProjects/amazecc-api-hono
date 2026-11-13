import { requireClubAuth } from "../../lib/clubAuth";
import { getDbPool } from "../../lib/db";

/** Port of src/app/api/club-admin/reps/route.ts. */
export async function GET(req: Request) {
  const auth = await requireClubAuth(req);
  if (auth instanceof Response) return auth;
  try {
    const { searchParams } = new URL(req.url);
    let club_id = searchParams.get("club_id") || auth.club_id;
    const pool = getDbPool();

    if (String(club_id).trim() !== String(auth.club_id).trim()) {
      const requestedClubId = String(club_id).trim();
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

    const { rows } = await pool.query(
      "SELECT id, vtop_id, role, created_at FROM club_representatives WHERE club_id = $1",
      [club_id]
    );

    const isSuper =
      auth.role === "super-club-rep" ||
      auth.clubs?.some((c) => c.club_id === club_id && c.role === "super-club-rep");

    return Response.json({ success: true, reps: rows, isSuperRep: isSuper });
  } catch (error) {
    console.error("Failed to fetch club reps:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requireClubAuth(req);
  if (auth instanceof Response) return auth;
  try {
    const data = (await req.json()) as any;
    const { vtop_id, role } = data;

    if (!vtop_id) {
      return Response.json({ success: false, error: "vtop_id is required" }, { status: 400 });
    }

    let club_id = auth.club_id;
    const pool = getDbPool();

    if (data.club_id && String(data.club_id).trim() !== String(auth.club_id).trim()) {
      club_id = String(data.club_id).trim();
    }

    let isSuper =
      auth.role === "super-club-rep" ||
      auth.clubs?.some((c) => c.club_id === club_id && c.role === "super-club-rep");
    if (!isSuper) {
      const repCheck = await pool.query(
        "SELECT role FROM club_representatives WHERE vtop_id = $1 AND club_id = $2",
        [auth.vtop_id, club_id]
      );
      if (repCheck.rows.length > 0 && repCheck.rows[0].role === "super-club-rep") {
        isSuper = true;
      }
    }

    if (!isSuper) {
      return Response.json(
        { success: false, error: "Unauthorized: Only super-club-reps can add reps" },
        { status: 403 }
      );
    }

    const newRole = role === "super-club-rep" ? "super-club-rep" : "representative";
    await pool.query(
      `INSERT INTO club_representatives (club_id, vtop_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (club_id, vtop_id) DO UPDATE SET role = $3`,
      [club_id, vtop_id.toUpperCase(), newRole]
    );

    return Response.json({ success: true, message: "Representative added/updated successfully" });
  } catch (error) {
    console.error("Failed to add club rep:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const auth = await requireClubAuth(req);
  if (auth instanceof Response) return auth;
  try {
    const { searchParams } = new URL(req.url);
    const vtop_id = searchParams.get("vtop_id");
    const club_id = searchParams.get("club_id") || auth.club_id;

    if (!vtop_id) {
      return Response.json({ success: false, error: "vtop_id is required" }, { status: 400 });
    }
    if (vtop_id.toUpperCase() === auth.vtop_id.toUpperCase()) {
      return Response.json({ success: false, error: "Cannot remove yourself" }, { status: 400 });
    }

    const pool = getDbPool();

    let isSuper =
      auth.role === "super-club-rep" ||
      auth.clubs?.some((c) => c.club_id === club_id && c.role === "super-club-rep");
    if (!isSuper) {
      const repCheck = await pool.query(
        "SELECT role FROM club_representatives WHERE vtop_id = $1 AND club_id = $2",
        [auth.vtop_id, club_id]
      );
      if (repCheck.rows.length > 0 && repCheck.rows[0].role === "super-club-rep") {
        isSuper = true;
      }
    }

    if (!isSuper) {
      return Response.json(
        { success: false, error: "Unauthorized: Only super-club-reps can remove reps" },
        { status: 403 }
      );
    }

    await pool.query("DELETE FROM club_representatives WHERE club_id = $1 AND vtop_id = $2", [
      club_id,
      vtop_id.toUpperCase(),
    ]);

    return Response.json({ success: true, message: "Representative removed successfully" });
  } catch (error) {
    console.error("Failed to remove club rep:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

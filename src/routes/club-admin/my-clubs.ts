/**
 * GET /api/club-admin/my-clubs — the caller's linked VTOP reg no + the clubs
 * they represent. Used by the Club-Hub after Amaze ID sign-in to build the
 * club switcher. Requires: Amaze ID session + VTOP link; returns an empty
 * list (not an error) when the user is linked but represents no club.
 */
import { verifyAmazeSession } from "../../lib/amazeId";
import { clubUnlinked, clubUnauthorized, fetchClubRoles, isSuperClubRep } from "../../lib/clubAuth";

export async function GET(req: Request) {
  const identity = await verifyAmazeSession(req);
  if (!identity) return clubUnauthorized();
  if (!identity.vtopRegNo) return clubUnlinked();

  try {
    const clubs = await fetchClubRoles(identity.vtopRegNo);
    return Response.json({
      success: true,
      linked: true,
      vtopRegNo: identity.vtopRegNo,
      clubs,
      isSuperRep: isSuperClubRep(clubs),
    });
  } catch (error) {
    console.error("Failed to fetch club roles:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

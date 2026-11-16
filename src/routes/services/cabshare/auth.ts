/**
 * POST /api/services/cabshare/auth — ensure a cabshare user row exists for the
 * caller's Amaze ID-linked VTOP reg_no.
 *
 * Auth: Amaze ID (DPoP). The caller must have linked their Amaze ID to a VTOP
 * reg number (claim_status = 'claimed' in student_profiles).
 *
 * Returns { success, user: { user_id, name, phone_number, reg_number } }
 */
import { Hono } from "hono";
import { requireCabshareUser, ensureCabshareSchema, ensureCabshareUser } from "../../../../src/lib/cabshare";
import { publicErrorMessage } from "../../../../src/lib/publicError";

export const cabshareAuthRouter = new Hono();

cabshareAuthRouter.post("/auth", async (c) => {
  try {
    const regNo = await requireCabshareUser(c);
    if (regNo instanceof Response) return regNo;

    await ensureCabshareSchema();
    const user = await ensureCabshareUser(regNo);

    return c.json({
      success: true,
      user: {
        user_id: user.user_id,
        name: user.name,
        phone_number: user.phone_number,
        reg_number: user.reg_number,
      },
      phone_required: !user.phone_number,
    });
  } catch (err: unknown) {
    console.error("[cabshare] auth error:", err);
    return c.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
});

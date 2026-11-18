/**
 * PATCH /api/profile/phone — update the caller's phone number.
 *
 * Auth: Amaze ID (DPoP). The caller must have linked their Amaze ID to a VTOP
 * reg_no (claim_status = 'claimed' in student_profiles).
 *
 * Body: { phone_number: string | null }
 *   - Optional field — send null or "" to clear
 *   - Sanitized: all non-digits stripped, must be valid 10-digit Indian mobile
 *     (starts with 6/7/8/9)
 *
 * Returns { success, phone_number }
 */
import { Hono } from "hono";
import { verifyAmazeSession, adminUnauthorized } from "../../../lib/amazeId";
import { publicErrorMessage } from "../../../lib/publicError";
import { updatePhoneNumber, ensureStudentProfilesSchema, getStudentProfileByRegNo } from "../../../lib/student-profiles";

export const profilePhoneRouter = new Hono();

profilePhoneRouter.patch("/phone", async (c) => {
  try {
    const identity = await verifyAmazeSession(c.req.raw);
    if (!identity) return adminUnauthorized();

    if (!identity.vtopRegNo) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "profile_incomplete",
          detail: { detail: "Amaze ID is not linked to a VTOP reg number" },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }

    await ensureStudentProfilesSchema();

    const body = (await c.req.json().catch(() => ({}))) as {
      phone_number?: unknown;
    };

    // Require the field: a missing or non-string value used to clear the stored
    // number (or 500). Send `null` explicitly to clear it.
    if (body.phone_number !== null && typeof body.phone_number !== "string") {
      return c.json({ success: false, error: "invalid_phone_number", detail: { detail: "phone_number must be a string or null" } }, 400);
    }
    const phoneNumber = body.phone_number;
    const sanitized = await updatePhoneNumber(identity.vtopRegNo, phoneNumber);

    return c.json({
      success: true,
      phone_number: sanitized,
    }, 200);
  } catch (err: unknown) {
    console.error("[profile] phone update error:", err);
    return c.json(
      { success: false, error: publicErrorMessage(err) },
      500,
    );
  }
});

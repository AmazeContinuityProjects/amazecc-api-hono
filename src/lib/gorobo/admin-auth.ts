import { requireAdminAuth, type AdminGrant } from "../auth";

export type GoroboAuth = AdminGrant;

/**
 * Admin auth for the GoRoBo back-office. Requires a valid admin token that
 * carries the `gorobo` permission. Superadmins are granted it at login.
 */
export async function requireGoroboAdmin(req: Request): Promise<GoroboAuth | Response> {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes("gorobo")) {
    return Response.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
  return auth;
}

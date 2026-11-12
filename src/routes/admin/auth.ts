/**
 * POST /api/admin/auth — admin sign-in via VTOP credentials.
 *
 * VTOP credentials are verified with the same flow as /api/remote/login
 * (captcha + dashboard markers). Admin status comes from ADMIN_VTOP_IDS
 * (superadmins) or the `admin_users` table; superadmins are auto-provisioned
 * in that table on first login. Successful sign-ins are audit-logged and
 * return an HMAC bearer token (typ "admin", 7-day TTL).
 */
import { Hono } from "hono";
import { attemptVtopLogin } from "../../lib/vtopLogin";
import { signAdminToken, SUPERADMIN_PERMISSIONS } from "../../lib/auth";
import { getDbPool } from "../../lib/db";
import { getWorkerEnv } from "../../env";
import { checkRateLimit, rateLimitResponse, getClientIp } from "../../lib/rateLimit";
import { logAdminAction } from "../../lib/audit";

export const adminAuthRoute = new Hono();

adminAuthRoute.post("/auth", async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = checkRateLimit(`admin-auth:${ip}`, 5, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string };
    const { username, password } = body;

    if (!username || !password) {
      return c.json({ error: "Username and password required" }, 400);
    }

    const outcome = await attemptVtopLogin(String(username), String(password));
    if (!outcome.ok) {
      return c.json({ error: "Invalid VTOP Credentials or VTOP is down" }, 401);
    }

    const normalizedUsername = String(username).toUpperCase().trim();

    const adminIdsEnv = getWorkerEnv().ADMIN_VTOP_IDS || "";
    const adminIds = adminIdsEnv
      .split(",")
      .map((id) => id.trim().toUpperCase());
    const isSuperadmin = adminIds.includes(normalizedUsername);

    let role: "superadmin" | "admin";
    let permissions: string[];

    if (isSuperadmin) {
      role = "superadmin";
      permissions = [...SUPERADMIN_PERMISSIONS];

      try {
        const pool = getDbPool();
        const { rows: existing } = await pool.query(
          "SELECT username, role FROM admin_users WHERE username = $1",
          [normalizedUsername]
        );

        if (existing.length === 0) {
          await pool.query(
            `INSERT INTO admin_users (username, role, permissions, added_by)
             VALUES ($1, 'superadmin', $2, 'SYSTEM')`,
            [normalizedUsername, JSON.stringify(permissions)]
          );
        } else if (existing[0]!.role !== "superadmin") {
          await pool.query(
            `UPDATE admin_users SET role = $1, permissions = $2 WHERE username = $3`,
            ["superadmin", JSON.stringify(permissions), normalizedUsername]
          );
        }
      } catch (dbError) {
        console.warn("Could not check admin_users table:", dbError);
      }
    } else {
      try {
        const pool = getDbPool();
        const { rows } = await pool.query(
          "SELECT role, permissions, is_active FROM admin_users WHERE username = $1",
          [normalizedUsername]
        );

        if (rows.length === 0) {
          return c.json(
            { error: "Access Denied: You are not an authorized administrator." },
            403
          );
        }

        const user = rows[0]!;
        if (!user.is_active) {
          return c.json(
            { error: "Access Denied: Your account has been deactivated." },
            403
          );
        }

        role = user.role === "superadmin" ? "superadmin" : "admin";
        permissions = Array.isArray(user.permissions)
          ? user.permissions
          : typeof user.permissions === "string"
            ? JSON.parse(user.permissions)
            : [];
      } catch (dbError) {
        console.error("Database error checking admin status:", dbError);
        return c.json(
          { error: "Access Denied: Unable to verify admin status." },
          403
        );
      }
    }

    await logAdminAction({
      admin_user: normalizedUsername,
      action: "Admin Login",
      target_resource: "/api/admin/auth",
      details: {
        role,
        permissions,
        auth_method: isSuperadmin ? "ENV_SUPERADMIN" : "DB_ADMIN",
        login_timestamp: new Date().toISOString(),
      },
      ip_address: ip,
      user_agent: c.req.raw.headers.get("user-agent") || "",
    });

    const token = await signAdminToken(normalizedUsername, role, permissions);

    return c.json({
      success: true,
      username: normalizedUsername,
      role,
      permissions,
      token,
    });
  } catch (err: unknown) {
    console.error("Admin auth error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

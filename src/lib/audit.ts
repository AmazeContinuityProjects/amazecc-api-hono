import { getAppDataDb } from "./sqlCompat";
import { getWorkerEnv } from "../env";

export interface AuditLogEntry {
  admin_user: string;
  action: string;
  target_resource?: string;
  details?: Record<string, unknown>;
  ip_address?: string;
  user_agent?: string;
}

/** The D1 table is created by migrations/0011_postgres_schema_alignment.sql. */
export async function ensureAuditLogsTable() {
  if (!getWorkerEnv().APP_DB) throw new Error("APP_DB is not configured");
}

/**
 * Logs an administrative action to the database. Never throws.
 */
export async function logAdminAction({
  admin_user,
  action,
  target_resource = "",
  details = {},
  ip_address = "",
  user_agent = "",
}: AuditLogEntry) {
  try {
    await ensureAuditLogsTable();
    const db = getAppDataDb();
    await db.query(
      `INSERT INTO admin_audit_logs (admin_user, action, target_resource, details, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        admin_user.toUpperCase().trim(),
        action,
        target_resource,
        JSON.stringify(details),
        ip_address,
        user_agent,
      ]
    );
  } catch (err) {
    console.error("Failed to write admin audit log:", err);
  }
}

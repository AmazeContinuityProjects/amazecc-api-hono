import { getDbPool } from "./db";

export interface AuditLogEntry {
  admin_user: string;
  action: string;
  target_resource?: string;
  details?: Record<string, unknown>;
  ip_address?: string;
  user_agent?: string;
}

/**
 * Creates the admin_audit_logs table if it does not already exist.
 */
export async function ensureAuditLogsTable() {
  try {
    const pool = getDbPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id SERIAL PRIMARY KEY,
        admin_user TEXT NOT NULL,
        action TEXT NOT NULL,
        target_resource TEXT DEFAULT '',
        details JSONB DEFAULT '{}'::jsonb,
        ip_address TEXT DEFAULT '',
        user_agent TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_admin_user ON admin_audit_logs (admin_user);
    `);
  } catch (err) {
    console.error("Failed to ensure admin_audit_logs table:", err);
  }
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
    const pool = getDbPool();
    await pool.query(
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

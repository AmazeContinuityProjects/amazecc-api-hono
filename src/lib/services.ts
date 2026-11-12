/**
 * Unified enrollment for everything under /api/services/*.
 *
 * One endpoint family (`POST|GET|DELETE /api/services/enroll`) opts a student
 * into the service layer built atop remote scraping. Identity is always
 * resolved server-side:
 *
 *   - Bearer `serviceToken` minted by this module (typ "service", 24h TTL), or
 *   - VTOP session in the request body/query (cookies + authorizedID + csrf);
 *     the REGISTER NO is read from VTOP's own profile response, never from the
 *     body, then pseudonymized with ID_SALT before touching the database.
 *
 * The service registry below is the single source of truth for which services
 * exist. Enrolling in "all" means every id in the registry, so future services
 * are covered by the same call without a new endpoint.
 */
import { getDbPool } from "./db";
import { vtopPostMenu, readText, type VtopCreds } from "./vtop";
import { parseStudentProfile } from "./parsers/student-profile";
import { ownerKeyFor } from "./marksStats";

export interface ServiceDefinition {
  id: string;
  name: string;
  description: string;
}

export const SERVICE_REGISTRY: readonly ServiceDefinition[] = [
  {
    id: "marks-stats",
    name: "Marks cohort statistics",
    description:
      "Contribute your marks to class-level running statistics. Individual marks are never stored — only Welford accumulators and HMAC tokens.",
  },
];

export const SERVICE_IDS: readonly string[] = SERVICE_REGISTRY.map((s) => s.id);

export interface EnrollmentState {
  service: string;
  enrolled: boolean;
  enrolledAt: string | null;
  revokedAt: string | null;
}

export interface ResolvedCaller {
  /** Pseudonymous owner key — never the raw REGISTER NO. */
  ownerKey: string;
  via: "bearer" | "vtop";
}

/* ── schema ─────────────────────────────────────────────────────────────── */

let schemaEnsured: Promise<void> | null = null;

export function ensureServiceEnrollmentSchema(): Promise<void> {
  if (!schemaEnsured) {
    schemaEnsured = (async () => {
      await getDbPool().query(`
        CREATE TABLE IF NOT EXISTS service_enrollments (
          owner_key TEXT NOT NULL,
          service TEXT NOT NULL,
          enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          revoked_at TIMESTAMPTZ,
          PRIMARY KEY (owner_key, service)
        );
        CREATE INDEX IF NOT EXISTS idx_service_enrollments_owner
          ON service_enrollments (owner_key);
      `);
    })().catch((err) => {
      // Allow a retry on the next call if the DB was briefly unavailable.
      schemaEnsured = null;
      throw err;
    });
  }
  return schemaEnsured;
}

/* ── caller resolution ──────────────────────────────────────────────────── */

/** Resolve the caller from VTOP credentials (body JSON or query params). */
export async function resolveCallerFromVtop(creds: VtopCreds): Promise<ResolvedCaller | null> {
  const { authorizedID, csrf } = creds;
  if (!csrf || !authorizedID) return null;
  const cookieHeader = Array.isArray(creds.cookies) ? creds.cookies.join("; ") : creds.cookies;
  if (!cookieHeader) return null;

  const res = await vtopPostMenu("/vtop/studentsRecord/StudentProfileAllView", {
    cookies: cookieHeader,
    authorizedID,
    csrf,
  });
  const html = await readText(res);
  const profile = parseStudentProfile(html);
  const regNumber = profile.registerNo || profile.applicationNumber;
  if (!regNumber) return null;
  return { ownerKey: await ownerKeyFor(regNumber), via: "vtop" };
}

/* ── enrollment operations ──────────────────────────────────────────────── */

/** Unknown service ids are rejected, never silently dropped. */
export function pickServices(requested: unknown): string[] {
  if (requested === undefined || requested === null) return [...SERVICE_IDS];
  if (!Array.isArray(requested)) return [];
  const picked = requested.filter((s): s is string => typeof s === "string" && SERVICE_IDS.includes(s));
  return [...new Set(picked)];
}

export async function listEnrollmentState(ownerKey: string): Promise<EnrollmentState[]> {
  await ensureServiceEnrollmentSchema();
  const { rows } = await getDbPool().query(
    `SELECT service, enrolled_at, revoked_at FROM service_enrollments WHERE owner_key = $1`,
    [ownerKey]
  );
  const byService = new Map<string, { enrolled_at: string | null; revoked_at: string | null }>();
  for (const row of rows) {
    byService.set(row.service, row);
  }
  return SERVICE_IDS.map((id) => {
    const row = byService.get(id);
    const enrolledAt = row?.enrolled_at ?? null;
    const revokedAt = row?.revoked_at ?? null;
    return {
      service: id,
      enrolled: !!enrolledAt && !revokedAt,
      enrolledAt,
      revokedAt,
    };
  });
}

export async function enroll(ownerKey: string, serviceIds: string[]): Promise<void> {
  if (serviceIds.length === 0) return;
  await ensureServiceEnrollmentSchema();
  const pool = getDbPool();
  for (const service of serviceIds) {
    await pool.query(
      `INSERT INTO service_enrollments (owner_key, service, enrolled_at, revoked_at)
       VALUES ($1, $2, now(), NULL)
       ON CONFLICT (owner_key, service)
         DO UPDATE SET enrolled_at = now(), revoked_at = NULL`,
      [ownerKey, service]
    );
  }
}

export async function revoke(ownerKey: string, serviceIds: string[]): Promise<void> {
  if (serviceIds.length === 0) return;
  await ensureServiceEnrollmentSchema();
  await getDbPool().query(
    `UPDATE service_enrollments SET revoked_at = now()
     WHERE owner_key = $1 AND service = ANY($2) AND revoked_at IS NULL`,
    [ownerKey, serviceIds]
  );
}

export async function isEnrolled(ownerKey: string, service: string): Promise<boolean> {
  await ensureServiceEnrollmentSchema();
  const { rows } = await getDbPool().query(
    `SELECT 1 FROM service_enrollments
     WHERE owner_key = $1 AND service = $2 AND revoked_at IS NULL`,
    [ownerKey, service]
  );
  return rows.length > 0;
}

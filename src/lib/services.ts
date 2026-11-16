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
 *     body, then pseudonymized with GENERATOR_KEY before touching the database.
 *
 * The service registry below is the single source of truth for which services
 * exist. Enrolling in "all" means every id in the registry, so future services
 * are covered by the same call without a new endpoint.
 */
import { getWorkerEnv } from "../env";
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

async function requireServiceEnrollmentsDb(): Promise<D1Database> {
  const db = getWorkerEnv().APP_DB;
  if (!db) throw new Error("APP_DB is not configured");
  return db;
}

export async function ensureServiceEnrollmentSchema(): Promise<void> {
  await requireServiceEnrollmentsDb();
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
  const db = await requireServiceEnrollmentsDb();
  const { results } = await db.prepare(`SELECT service, enrolled_at, revoked_at
    FROM service_enrollments WHERE owner_key = ?`).bind(ownerKey)
    .all<{ service: string; enrolled_at: string | null; revoked_at: string | null }>();
  const byService = new Map(results.map((row) => [row.service, row]));
  return SERVICE_IDS.map((id) => {
    const row = byService.get(id);
    const enrolledAt = row?.enrolled_at ?? null;
    const revokedAt = row?.revoked_at ?? null;
    return { service: id, enrolled: Boolean(enrolledAt) && !revokedAt, enrolledAt, revokedAt };
  });
}

export async function enroll(ownerKey: string, serviceIds: string[]): Promise<void> {
  if (!serviceIds.length) return;
  const db = await requireServiceEnrollmentsDb();
  const statements = serviceIds.map((service) => db.prepare(`INSERT INTO service_enrollments
      (owner_key, service, enrolled_at, revoked_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)
    ON CONFLICT (owner_key, service) DO UPDATE SET
      enrolled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoked_at = NULL`)
    .bind(ownerKey, service));
  for (let index = 0; index < statements.length; index += 80) {
    await db.batch(statements.slice(index, index + 80));
  }
}

export async function revoke(ownerKey: string, serviceIds: string[]): Promise<void> {
  if (!serviceIds.length) return;
  const db = await requireServiceEnrollmentsDb();
  const placeholders = serviceIds.map(() => "?").join(", ");
  await db.prepare(`UPDATE service_enrollments
    SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE owner_key = ? AND service IN (${placeholders}) AND revoked_at IS NULL`)
    .bind(ownerKey, ...serviceIds).run();
}

export async function isEnrolled(ownerKey: string, service: string): Promise<boolean> {
  const db = await requireServiceEnrollmentsDb();
  const row = await db.prepare(`SELECT 1 AS enrolled FROM service_enrollments
    WHERE owner_key = ? AND service = ? AND revoked_at IS NULL`)
    .bind(ownerKey, service).first();
  return Boolean(row);
}

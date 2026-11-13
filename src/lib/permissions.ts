/**
 * Granular admin RBAC for the AmazeCC API.
 *
 * One Amaze ID, three roles: `superadmin` (full access, bypasses everything),
 * `admin` (only the sections listed in its `permissions`), `user` (no admin).
 * The `permissions` field on the Amaze ID user is a comma-separated list of
 * the section keys below, enforced on every admin request via the shared D1.
 */
export const SECTION_KEYS = [
  "dashboard",
  "qbank",
  "buses",
  "transport",
  "gorobo",
  "clubs",
  "cabshare",
  "fresher-resources",
  "faculty-directories",
  "push",
  "settings",
  "storage",
  "users", // manage admin users (superadmin-only in practice; the key gates the tab)
  "ocr",
  "migrate",
  "audit-logs",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

/** All sections, granted to superadmins. */
export const SUPERADMIN_PERMISSIONS = [...SECTION_KEYS];

export function parsePermissions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => (SECTION_KEYS as readonly string[]).includes(p));
}

export function isValidPermission(value: string): boolean {
  return (SECTION_KEYS as readonly string[]).includes(value);
}

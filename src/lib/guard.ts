/**
 * First-party service guard - runs BEFORE routers/proxy.
 *
 * AmazeCC's own services must never be reachable anonymously on
 * hono.amazecc.com. Authentication is any valid Amaze ID (session or OAuth
 * access token verified against the shared D1).
 *
 * Every prefix not listed here is passed through unchanged.
 */
import { verifyAmazeSession, adminUnauthorized } from "./amazeId";

export type Guard = "amazeId" | { section: string };

interface GuardedPath {
  test: (path: string) => boolean;
  guard: Guard;
}

const GUARDED: GuardedPath[] = [
  // QBank upload - any Amaze ID (read/download stay public)
  { test: (p) => p === "/api/qbank/upload" || p === "/api/qbank/upload/", guard: "amazeId" },
  // Social - any Amaze ID
  { test: (p) => p === "/api/social" || p.startsWith("/api/social/"), guard: "amazeId" },
  // Profile - any Amaze ID
  { test: (p) => p === "/api/profile" || p.startsWith("/api/profile/"), guard: "amazeId" },
  // Cabshare - any Amaze ID
  { test: (p) => p === "/api/cabshare" || p.startsWith("/api/cabshare/"), guard: "amazeId" },
  // Gorobo orders - any Amaze ID; gorobo seed - section gorobo
  { test: (p) => p === "/api/services/gorobo/orders" || p.startsWith("/api/services/gorobo/orders/"), guard: "amazeId" },
  { test: (p) => p === "/api/services/gorobo/seed" || p.startsWith("/api/services/gorobo/seed/"), guard: { section: "gorobo" } },
  // Notifications - subscribe/unsubscribe are per-user (Amaze ID); status is public-by-endpoint; config/test are push admin
  { test: (p) => p === "/api/notifications/subscribe" || p === "/api/notifications/unsubscribe", guard: "amazeId" },
  // Koha - library patron lookup is personal data, not the public catalog
  { test: (p) => p === "/api/koha/patron" || p.startsWith("/api/koha/patron/"), guard: "amazeId" },
  // Faculty scrape - section faculty-directories
  { test: (p) => p === "/api/faculty/scrape" || p.startsWith("/api/faculty/scrape/"), guard: { section: "faculty-directories" } },
];

export function guardFor(path: string): Guard | null {
  const normalized = path.replace(/\/+$/, "") || "/";
  for (const g of GUARDED) {
    if (g.test(normalized)) return g.guard;
  }
  return null;
}

export async function guardRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  // FFCS Friend Finder supports VTOP-session-only sign-in for enrollment and
  // returning users. Its route verifies Amaze ID when present, or validates
  // the supplied VTOP session itself before reading or changing any state.
  if (path.replace(/\/+$/, "") === "/api/social/ffcs-match" && req.method === "POST") return null;
  const guard = guardFor(path);
  if (!guard) return null; // not guarded

  const identity = await verifyAmazeSession(req);
  if (!identity) return adminUnauthorized();

  if (typeof guard === "object" && "section" in guard) {
    // Section-based authorization: superadmins always pass; admins check permission list
    const isSuperadmin = identity.role === "superadmin";
    if (!isSuperadmin) {
      const required = guard.section;
      const perms = Array.isArray(identity.permissions) ? identity.permissions : [];
      if (!perms.includes(required)) {
        return new Response(
          JSON.stringify({ success: false, error: "forbidden", detail: { detail: `Section '${required}' required` } }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
    }
  }

  return null; // allowed
}

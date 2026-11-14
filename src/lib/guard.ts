/**
 * First-party service guard - runs BEFORE the public proxy/routers.
 *
 * AmazeCC's own services (social, cabshare, gorobo, notifications, koha
 * patron functions, faculty scrapes, catalog seeds) must never be reachable
 * anonymously on hono.amazecc.com, even while they are still served by the
 * legacy backend behind the proxy. Authentication is any valid Amaze ID;
 * authorization is the admin RBAC section where applicable.
 *
 * Every prefix not listed here is passed through unchanged.
 */
import {
  verifyAmazeSession,
  requireSection,
  adminUnauthorized,
} from "./amazeId";

export type Guard = "amazeId" | { section: string };

interface GuardedPath {
  test: (path: string) => boolean;
  guard: Guard;
}

const GUARDED: GuardedPath[] = [
  // QBank upload - any Amaze ID (read/download stay public)
  { test: (p) => p === "/api/qbank/upload" || p === "/api/qbank/upload/", guard: "amazeId" },
  // Social (friend finder / FFCS match) - any Amaze ID
  { test: (p) => p === "/api/social" || p.startsWith("/api/social/"), guard: "amazeId" },
  // CabShare (rideshare) - any Amaze ID
  { test: (p) => p === "/api/cabshare" || p.startsWith("/api/cabshare/"), guard: "amazeId" },
  // GoRoBo orders - any Amaze ID; catalog seed - gorobo section
  { test: (p) => p === "/api/gorobo/orders" || p.startsWith("/api/gorobo/orders/"), guard: "amazeId" },
  { test: (p) => p === "/api/gorobo/seed" || p.startsWith("/api/gorobo/seed/"), guard: { section: "gorobo" } },
  // Notifications - subscribe/unsubscribe are per-user (Amaze ID); status is
  // public-by-endpoint (the endpoint itself is the device-level secret);
  // config/test are push admin.
  { test: (p) => p === "/api/notifications/subscribe" || p === "/api/notifications/unsubscribe", guard: "amazeId" },
  { test: (p) => p === "/api/notifications/config" || p === "/api/notifications/test", guard: { section: "push" } },
  // Koha - library patron lookup is personal data, not the public catalog
  { test: (p) => p.startsWith("/api/koha/patron"), guard: "amazeId" },
  // Faculty scraping - faculty directories section
  { test: (p) => p.startsWith("/api/faculty/scrape"), guard: { section: "faculty-directories" } },
];

/** Decide whether a path requires auth, and which. */
export function guardFor(path: string): Guard | null {
  const p = path.replace(/\/+$/, "");
  for (const g of GUARDED) if (g.test(p)) return g.guard;
  return null;
}

/**
 * Enforce the guard for one request. Returns null when allowed (caller
 * proceeds), or a 401/403 Response to short-circuit.
 */
export async function guardRequest(req: Request): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  const guard = guardFor(path);
  if (!guard) return null;

  if (guard === "amazeId") {
    const identity = await verifyAmazeSession(req);
    return identity ? null : adminUnauthorized();
  }

  const check = await requireSection(guard.section)(req);
  if (check instanceof Response) return check;
  return null;
}

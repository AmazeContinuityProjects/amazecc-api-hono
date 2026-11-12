/**
 * Unified enrollment for /api/services/* — one endpoint family opts the
 * caller into every service built atop remote scraping.
 *
 *   POST   /api/services/enroll   — enroll in all (or listed) services
 *   GET    /api/services/enroll   — current enrollment state
 *   DELETE /api/services/enroll   — un-enroll from all (or listed) services
 *
 * Auth (same contract on all three):
 *   1. `Authorization: Bearer <serviceToken>` — minted by this route for
 *      VTOP-authenticated callers (24 h TTL, re-minted on each VTOP-auth call), or
 *   2. VTOP session — `{ cookies, authorizedID, csrf }` in the JSON body
 *      (POST/DELETE) or as query params (GET). Identity is resolved from
 *      VTOP's own profile response, never from the body.
 */
import { Hono } from "hono";
import {
  SERVICE_IDS,
  SERVICE_REGISTRY,
  enroll,
  revoke,
  listEnrollmentState,
  pickServices,
  resolveCallerFromVtop,
  ensureServiceEnrollmentSchema,
} from "../../lib/services";
import {
  getBearerToken,
  signServiceToken,
  verifyServiceToken,
  serviceUnauthorized,
} from "../../lib/auth";
import { getClientIp, checkRateLimit, rateLimitResponse } from "../../lib/rateLimit";
import type { VtopCreds } from "../../lib/vtop";

export const enrollRoute = new Hono();

type Caller = { ownerKey: string; via: "bearer" | "vtop" };

/** Bearer wins when present; otherwise VTOP creds are verified against VTOP. */
async function resolveFromBodyOrBearer(
  body: VtopCreds,
  raw: Request
): Promise<Caller | Response> {
  const bearer = getBearerToken(raw);
  if (bearer) {
    const payload = await verifyServiceToken(bearer);
    if (!payload) return serviceUnauthorized();
    return { ownerKey: payload.sub, via: "bearer" };
  }
  if (!body.csrf || !body.authorizedID || !body.cookies) {
    return Response.json(
      {
        success: false,
        error: "missing_credentials",
        message:
          "Provide a Bearer serviceToken, or VTOP session credentials (cookies, authorizedID, csrf) in the body (POST/DELETE) or query string (GET).",
      },
      { status: 400 }
    );
  }
  const resolved = await resolveCallerFromVtop(body);
  if (!resolved) {
    return Response.json(
      {
        success: false,
        error: "vtop_identity_unresolved",
        message:
          "VTOP returned no REGISTER NO for these cookies. The session is not this student's, or has expired.",
      },
      { status: 401 }
    );
  }
  return resolved;
}

function invalidServicesResponse() {
  return Response.json(
    {
      success: false,
      error: "invalid_services",
      message: `Unknown services. Known ids: ${SERVICE_IDS.join(", ")}`,
    },
    { status: 400 }
  );
}

enrollRoute.post("/enroll", async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = checkRateLimit(`services-enroll:${ip}`, 30, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const body = (await c.req.json().catch(() => ({}))) as VtopCreds & { services?: unknown };
    const hadRequest = Array.isArray(body.services);

    const caller = await resolveFromBodyOrBearer(body, c.req.raw);
    if (caller instanceof Response) return caller;

    const ids = pickServices(hadRequest ? (body.services as string[]) : undefined);
    if (hadRequest && Array.isArray(body.services) && body.services.length > 0 && ids.length === 0) {
      return invalidServicesResponse();
    }

    await ensureServiceEnrollmentSchema();
    await enroll(caller.ownerKey, ids);
    const enrollments = await listEnrollmentState(caller.ownerKey);

    return c.json({
      success: true,
      services: SERVICE_REGISTRY,
      enrollments,
      // Mint a service token for VTOP-authenticated callers so the client can
      // switch to Bearer for subsequent calls (24h TTL, re-minted on each use).
      ...(caller.via === "vtop" ? { serviceToken: await signServiceToken(caller.ownerKey) } : {}),
    });
  } catch (err: unknown) {
    console.error("enroll error:", err);
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

enrollRoute.get("/enroll", async (c) => {
  const rl = checkRateLimit(`services-enroll:${getClientIp(c.req.raw)}`, 30, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const url = new URL(c.req.raw.url);
    const creds: VtopCreds = {
      cookies: url.searchParams.get("cookies") ?? undefined,
      authorizedID: url.searchParams.get("authorizedID") ?? undefined,
      csrf: url.searchParams.get("csrf") ?? undefined,
    };

    const caller = await resolveFromBodyOrBearer(creds, c.req.raw);
    if (caller instanceof Response) return caller;

    await ensureServiceEnrollmentSchema();
    const enrollments = await listEnrollmentState(caller.ownerKey);
    return c.json({
      success: true,
      services: SERVICE_REGISTRY,
      enrollments,
    });
  } catch (err: unknown) {
    console.error("enroll(get) error:", err);
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

enrollRoute.delete("/enroll", async (c) => {
  const rl = checkRateLimit(`services-enroll:${getClientIp(c.req.raw)}`, 30, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const body = (await c.req.json().catch(() => ({}))) as VtopCreds & { services?: unknown };

    const caller = await resolveFromBodyOrBearer(body, c.req.raw);
    if (caller instanceof Response) return caller;

    const requested = Array.isArray(body.services) ? (body.services as string[]) : undefined;
    const ids = pickServices(requested);

    await ensureServiceEnrollmentSchema();
    await revoke(caller.ownerKey, ids);
    const enrollments = await listEnrollmentState(caller.ownerKey);

    return c.json({
      success: true,
      services: SERVICE_REGISTRY,
      enrollments,
    });
  } catch (err: unknown) {
    console.error("enroll(delete) error:", err);
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

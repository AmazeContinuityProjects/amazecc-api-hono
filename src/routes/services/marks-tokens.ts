/**
 * POST /api/services/marks/tokens — the HMAC tokens the server currently holds
 * for the caller (presence/continuity, never values), plus any old-scheme
 * legacy-held classes plausibly theirs.
 */
import { Hono } from "hono";
import { vtopPostForm, readText, cookieHeader, formParams } from "../../lib/vtop";
import { parseStudentProfile } from "../../lib/parsers/student-profile";
import { getClientIp, checkRateLimit, rateLimitResponse } from "../../lib/rateLimit";
import { getDbErrorStatus, getDbErrorMessage } from "../../lib/db";
import {
  ensureSchema,
  legacyAssociations,
  ownerKeyFor,
  tokensForOwner,
} from "../../lib/marksStats";

export const marksTokensRoute = new Hono();

function fail(status: number, error: string, extra?: Record<string, unknown>) {
  return Response.json({ success: false, error, ...extra }, { status });
}

marksTokensRoute.post("/marks/tokens", async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = checkRateLimit(`marks-tokens:${ip}`, 60, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const { cookies, authorizedID, csrf } = (await c.req.json().catch(() => ({}))) as {
    cookies?: string | string[];
    authorizedID?: string;
    csrf?: string;
  };

  const cookieHeaderValue = cookieHeader({ cookies });
  if (!cookieHeaderValue || !authorizedID || !csrf) {
    return fail(400, "missing_credentials", {
      detail: "Missing cookies, csrf or authorizedID",
    });
  }

  try {
    const identityRes = await vtopPostForm(
      "/vtop/studentsRecord/StudentProfileAllView",
      formParams({
        verifyMenu: "true",
        authorizedID: String(authorizedID),
        _csrf: String(csrf),
        nocache: Date.now().toString(),
      }),
      { cookies: cookieHeaderValue, timeoutMs: 20_000 }
    );

    const profile = parseStudentProfile(await readText(identityRes));
    const regNumber = profile.registerNo || profile.applicationNumber;
    if (!regNumber) {
      return fail(401, "vtop_identity_unresolved", {
        detail:
          "VTOP returned no REGISTER NO for these cookies. The session is not this student's, or has expired.",
      });
    }

    await ensureSchema();
    const ownerKey = await ownerKeyFor(regNumber);
    const [tokens, legacy] = await Promise.all([
      tokensForOwner(ownerKey),
      legacyAssociations(String(authorizedID), regNumber),
    ]);

    return c.json({ success: true, tokens, legacy });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\b401\b|unauthor|\bsession\b|invalid\s*csrf/i.test(message)) {
      return fail(401, "vtop_session_expired", { detail: message });
    }
    if (/relation "[^"]+" does not exist/i.test(message)) {
      return c.json({ success: true, tokens: [], legacy: [] });
    }
    console.error("marks/tokens error:", message);
    return fail(getDbErrorStatus(err), "tokens_read_failed", {
      detail: getDbErrorMessage(err),
    });
  }
});

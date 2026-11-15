/**
 * EventHub (VITE campus events portal) session handling.
 *
 * AmazeCC never stores EventHub credentials - callers either send their
 * VIT username/password (in which case we log in once per request and
 * return the compound session cookie) or reuse a cached `jsessionid`
 * previously issued by /api/events/login.
 *
 * NOTE on TLS: the legacy (Node.js) implementation disabled certificate
 * verification process-wide for eventhubcc.vit.ac.in because it serves a
 * broken chain. Cloudflare's egress verifies VIT hosts fine (same as VTOP),
 * so the Workers implementation deliberately does NOT weaken TLS.
 */
const EVENTHUB_BASE = "https://eventhubcc.vit.ac.in";
const EVENTHUB_LOGIN = `${EVENTHUB_BASE}/EventHub/mainDashboard`;

export type EventHubCredentials = {
  username?: string;
  password?: string;
  /**
   * A cached session, in the compound form `/api/events/login` returns:
   * `"<id>"` or `"<id>; cookiesession1=<c>"`.
   */
  jsessionid?: string;
  /** Also accepted separately, for callers that do not send a compound value. */
  cookiesession1?: string;
};

/** True when the response HTML is EventHub's login page rather than a real page. */
export function looksLikeLoginPage(html: string): boolean {
  return /action=["']\/EventHub\/mainDashboard["']/i.test(html);
}

/** Extract JSESSIONID (+ cookiesession1 if present) from a response's Set-Cookie headers. */
export function extractCookies(headers: Headers): string {
  const raw: string[] =
    typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : (headers.get("set-cookie")?.split(/,(?=[^;]+=[^;]+;)/) ?? []);
  let j: string | null = null;
  let c: string | null = null;
  for (const cookie of raw) {
    const jm = cookie.match(/JSESSIONID=([^;,\s]+)/);
    if (jm) j = jm[1];
    const cm = cookie.match(/cookiesession1=([^;,\s]+)/);
    if (cm) c = cm[1];
  }
  if (!j) return "";
  return c ? `${j}; cookiesession1=${c}` : j;
}

/**
 * Build a `Cookie` header for EventHub.
 *
 * A cached `jsessionid` is NOT validated here - EventHub sessions expire
 * server-side with no signal to the client. Callers that want a session
 * proven good must check the response for a login form (see
 * `looksLikeLoginPage`), which is what the profile/register routes do.
 */
export async function getEventHubCookie(
  params: EventHubCredentials,
): Promise<string | null> {
  if (params.jsessionid) {
    // The compound form is already a cookie fragment.
    if (params.jsessionid.includes("cookiesession1")) {
      return `JSESSIONID=${params.jsessionid}`;
    }
    const extra = params.cookiesession1 ? `; cookiesession1=${params.cookiesession1}` : "";
    return `JSESSIONID=${params.jsessionid}${extra}`;
  }

  if (!params.username || !params.password) return null;

  const loginParams = new URLSearchParams({
    username: params.username,
    password: params.password,
    validateVitian: "1",
  });

  const loginRes = await fetch(EVENTHUB_LOGIN, {
    method: "POST",
    body: loginParams,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });

  // EventHub sets JSESSIONID + cookiesession1 even for REJECTED credentials
  // (HTTP 200 + login form), so a Set-Cookie header alone proves nothing.
  // The only distinguisher is the body.
  const jsessionid = extractCookies(loginRes.headers);
  if (!jsessionid) return null;

  const body = await loginRes.text();
  if (looksLikeLoginPage(body)) return null;

  return `JSESSIONID=${jsessionid}`;
}

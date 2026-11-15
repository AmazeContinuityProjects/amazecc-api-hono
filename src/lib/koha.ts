/**
 * Koha OPAC (webopaccc.vit.ac.in) shared helpers.
 *
 * NOTE: webopaccc.vit.ac.in does not answer Cloudflare's egress IPs
 * (verified 2026-11-14 — connection blackhole, result was expressed as a fetch
 * TimeoutError). Native mounts must stay OFF until the origin opens egress
 * or serves a complete certificate chain. The legacy host on Render
 * (api.amazecc.com) reaches Koha fine with the Sectigo DV R36 intermediate
 * pinned (see AmazeCC-API/lib/vitTls.ts), so these routes are currently
 * proxied there by routes/proxy/.
 *
 * Response cookies are round-tripped by hand (Set-Cookie parsing + a
 * cookie jar threaded through the OPAC login flow), matching what Koha's
 * opac-*.pl endpoints expect.
 */
const KOHA_ORIGIN = "https://webopaccc.vit.ac.in";
const KOHA_OPAC_DIR = "/cgi-bin/koha/";

export function kohaPath(path: string): string {
  if (/^https:\/\/webopaccc\.vit\.ac\.in\//i.test(path)) {
    const u = new URL(path);
    return u.pathname + u.search;
  }
  if (path.startsWith("/")) return path;
  return `${KOHA_OPAC_DIR}${path}`;
}

export function kohaAbs(path: string): string {
  return `${KOHA_ORIGIN}${kohaPath(path)}`;
}
export function kohaOrigin(): string {
  return KOHA_ORIGIN;
}

export interface KohaResponse {
  status: number;
  body: string;
  cookies: string;
}

/** Merge Set-Cookie headers from a response into a `a=b; c=d` jar fragment. */
export function setCookieJar(headers: Headers, previous?: string): string {
  const raw: string[] =
    typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : (headers.get("set-cookie")?.split(/,(?=[^;]+=[^;]+;)/) ?? []);
  const jar = new Map<string, string>();
  if (previous) {
    for (const part of previous.split(";")) {
      const p = part.trim();
      if (p && p.includes("=")) jar.set(p.split("=")[0].trim(), p);
    }
  }
  for (const cookie of raw) {
    const fragment = cookie.split(";")[0].trim();
    if (!fragment || !fragment.includes("=")) continue;
    jar.set(fragment.split("=")[0].trim(), fragment);
  }
  return [...jar.values()].join("; ");
}

/**
 * Single Koha OPAC request, following one redirect hop (relative Location
 * resolved against /cgi-bin/koha/). `path` is always pinned to the Koha host
 * — never an arbitrary caller-supplied URL.
 */
export async function kohaFetch(
  method: "GET" | "POST",
  path: string,
  cookies: string,
  postData?: string,
  depth = 0,
): Promise<KohaResponse> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (compatible; AmazeCC/1.0)",
  };
  if (cookies) headers.Cookie = cookies;
  if (postData) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const res = await fetch(`${KOHA_ORIGIN}${kohaPath(path)}`, {
    method,
    headers,
    body: postData,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });

  const setCookies = setCookieJar(res.headers, cookies);

  if (res.status >= 300 && res.status < 400 && res.headers.get("location") && depth < 1) {
    const loc = res.headers.get("location") ?? "";
    const next = loc.startsWith("/")
      ? loc
      : new URL(loc, kohaAbs(path)).pathname + new URL(loc, kohaAbs(path)).search;
    return kohaFetch("GET", next, setCookies, undefined, depth + 1);
  }

  return { status: res.status, body: await res.text(), cookies: setCookies };
}

/**
 * Fetch-based VTOP client.
 *
 * The original ran axios over Node's https with a hand-pinned Sectigo
 * intermediate (VIT's servers omit it). Cloudflare's egress TLS stack verifies
 * VTOP fine (probed: GET /vtop/open/page → 200, set-cookie present), so Workers
 * needs no custom CA handling at all. Timeouts are enforced with
 * AbortSignal.timeout; networking time does not count against the 10 ms CPU
 * budget.
 */
import { getWorkerEnv } from "../env";

export interface VtopCreds {
  cookies?: string | string[];
  authorizedID?: string;
  csrf?: string;
}

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};

const DEFAULT_TIMEOUT_MS = 20_000;

export function getVtopBaseUrl(): string {
  const raw = getWorkerEnv().VTOP_BASE_URL || "https://vtopcc.vit.ac.in";
  return raw.replace(/\/+$/, "");
}

export function getVtopReferer(): string {
  return `${getVtopBaseUrl()}/vtop/open/page`;
}

/**
 * Build an outbound Cookie header. Accepts either:
 *  - an array of raw Set-Cookie strings (full attributes tolerated; the
 *    attribute tail is stripped so only name=value pairs reach VTOP), or
 *  - a pre-joined cookie string (passed through verbatim).
 */
export function cookieHeader(creds: VtopCreds | { cookies?: string | string[] }): string {
  const c = creds.cookies;
  if (Array.isArray(c)) {
    return c
      .map((s) => s.split(";")[0]?.trim() ?? "")
      .filter(Boolean)
      .join("; ");
  }
  return c ?? "";
}

export function formParams(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export function formHeaders(cookieHeaderValue: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Cookie: cookieHeaderValue,
    "Content-Type": "application/x-www-form-urlencoded",
    Referer: getVtopReferer(),
    ...extra,
  };
}

export interface VtopRequestOptions {
  cookies?: string;
  timeoutMs?: number;
  redirect?: "follow" | "manual" | "error";
  headers?: Record<string, string>;
}

/** GET a VTOP page (HTML). */
export function vtopGet(
  path: string,
  opts: VtopRequestOptions = {}
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${getVtopBaseUrl()}${path}`;
  return fetch(url, {
    method: "GET",
    redirect: opts.redirect ?? "follow",
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    headers: {
      ...DEFAULT_HEADERS,
      ...(opts.cookies ? { Cookie: opts.cookies } : {}),
      ...opts.headers,
    },
  });
}

/** POST application/x-www-form-urlencoded to a VTOP page. */
export function vtopPostForm(
  path: string,
  body: string | URLSearchParams | Record<string, string>,
  opts: VtopRequestOptions = {}
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${getVtopBaseUrl()}${path}`;
  const encoded =
    typeof body === "string"
      ? body
      : body instanceof URLSearchParams
        ? body.toString()
        : formParams(body);
  return fetch(url, {
    method: "POST",
    redirect: opts.redirect ?? "follow",
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    headers: {
      ...DEFAULT_HEADERS,
      ...(opts.cookies ? { Cookie: opts.cookies } : {}),
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: getVtopReferer(),
      ...opts.headers,
    },
    body: encoded,
  });
}

/** One VTOP POST with the params every menu-scoped page expects. */
export async function vtopPostMenu(
  path: string,
  creds: VtopCreds,
  extra: Record<string, string> = {}
): Promise<Response> {
  return vtopPostForm(
    path,
    formParams({
      verifyMenu: "true",
      authorizedID: String(creds.authorizedID),
      _csrf: String(creds.csrf),
      nocache: Date.now().toString(),
      ...extra,
    }),
    { cookies: cookieHeader(creds) }
  );
}

/** Read the body as text (VTOP pages are HTML/JSON strings). */
export async function readText(res: Response): Promise<string> {
  return res.text();
}

/**
 * Set-Cookie array from a response. `Headers.getSetCookie()` exists at runtime
 * on workerd but is missing from the published type definitions.
 */
export function setCookies(res: Response): string[] {
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    try {
      return h.getSetCookie();
    } catch {
      return [];
    }
  }
  const raw = res.headers.get("set-cookie");
  return raw ? [raw] : [];
}

/** Thrown when work exceeds its wall-clock budget. */
export class DeadlineError extends Error {}

/**
 * Bound a promise's wall-clock time. Network waits are not CPU time, but the
 * client still deserves a hard answer instead of a hang.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

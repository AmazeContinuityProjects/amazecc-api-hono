/**
 * Moodle/LMS fetch helpers — same shape as the VTOP client (fetch + manual
 * cookie jar), but for lms.vit.ac.in. No custom TLS needed on Workers.
 */
const LMS_BASE = "https://lms.vit.ac.in";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Merge Set-Cookie arrays into "a=1; b=2" form. Later cookies win. */
export function mergeCookies(prev: string, incoming: string[] | null | undefined): string {
  const jar = new Map<string, string>();
  const addPairs = (pairs: string) => {
    for (const pair of pairs.split(";")) {
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (name) jar.set(name, value);
    }
  };
  addPairs(prev);
  if (incoming) {
    for (const raw of incoming) {
      addPairs(raw);
    }
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export async function lmsGet(path: string, cookie?: string): Promise<Response> {
  const url = path.startsWith("http") ? path : `${LMS_BASE}${path}`;
  return fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
}

export async function lmsPostForm(
  path: string,
  body: string,
  cookie?: string,
  opts: { redirect?: "follow" | "manual" } = {}
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${LMS_BASE}${path}`;
  return fetch(url, {
    method: "POST",
    redirect: opts.redirect ?? "follow",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  });
}

export function lmsUrl(relativeOrAbsolute: string): string {
  try {
    return new URL(relativeOrAbsolute, LMS_BASE).toString();
  } catch {
    return relativeOrAbsolute;
  }
}

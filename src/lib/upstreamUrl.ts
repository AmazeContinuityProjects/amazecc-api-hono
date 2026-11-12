/**
 * Guards for outgoing server-side requests (CWE-918 / "request forgery").
 *
 * Several routes accept a URL from the request body, from a `Location` header,
 * or from a database row and then fetch it. If that value is not constrained,
 * the caller can aim the server at internal services -- cloud metadata, a
 * cluster-internal admin API -- and any credential attached to the request
 * (a session cookie) is delivered to whatever host was chosen.
 *
 * The rule applied here: a URL that came from outside this process is only ever
 * used after its host has been checked against an explicit allow-list, and only
 * over HTTPS so a validated host cannot be downgraded to a cleartext listener.
 */

/** The Event Hub host this app integrates with. */
export const EVENTHUB_HOST = "eventhubcc.vit.ac.in";

/** Thrown when a URL points somewhere we refuse to send a request. */
export class DisallowedUrlError extends Error {
  constructor(host: string) {
    super(`Refusing to request disallowed host: ${host || "(none)"}`);
    this.name = "DisallowedUrlError";
  }
}

/**
 * Exact host match, unless the entry starts with a dot, in which case it is a
 * suffix match covering subdomains. `.vit.ac.in` therefore allows
 * `directorycc.vit.ac.in` but not `notvit.ac.in`.
 */
function isHostAllowed(host: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((entry) =>
    entry.startsWith(".")
      ? host === entry.slice(1) || host.endsWith(entry)
      : host === entry
  );
}

/**
 * Resolves a relative or absolute candidate URL against `base` and returns it
 * only if the result is an HTTPS URL on an allowed host.
 */
export function resolveUpstreamUrl(
  candidate: unknown,
  allowedHosts: string[],
  base: string
): string {
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new DisallowedUrlError("");
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate.trim(), base);
  } catch {
    throw new DisallowedUrlError(candidate);
  }

  if (parsed.protocol !== "https:") {
    throw new DisallowedUrlError(parsed.hostname);
  }

  const host = parsed.hostname.toLowerCase();
  if (!isHostAllowed(host, allowedHosts)) {
    throw new DisallowedUrlError(host);
  }

  return parsed.toString();
}

/** Restricts a URL to Event Hub. Use for anything derived from Event Hub. */
export function eventHubUrl(candidate: unknown): string {
  return resolveUpstreamUrl(candidate, [EVENTHUB_HOST], `https://${EVENTHUB_HOST}`);
}

/** Restricts a URL to any VIT host. Use for university directory scraping. */
export function vitUrl(candidate: unknown): string {
  return resolveUpstreamUrl(candidate, [".vit.ac.in"], `https://${EVENTHUB_HOST}`);
}

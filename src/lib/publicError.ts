/**
 * Message that is safe to put in an API response. Messages from errors the
 * route threw on purpose ("Invalid credentials", "Semester not found") pass
 * through; anything that looks like a database, network, TLS or upstream-HTTP
 * error is replaced with a generic message and logged in full server-side,
 * so table names, SQL, hostnames and stack details never reach clients.
 */
const INTERNAL_PATTERN =
  /relation |column |syntax error|violates|duplicate key|constraint|permission denied for|password authentication|database|pg_|\bSQL\b|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|getaddrinfo|socket|certificate|\bSSL\b|\bTLS\b|Request failed with status|timeout of \d+ms|ADMIN_SECRET|ID_SALT|environment variable|_KEY\b|\/home\/|\/var\/|node_modules/i;

export function publicErrorMessage(err: unknown, fallback = "Internal server error"): string {
  if (!(err instanceof Error)) {
    console.error("[api] non-Error thrown:", err);
    return fallback;
  }
  const e = err as Error & { code?: unknown; isAxiosError?: boolean; severity?: unknown; routine?: unknown };
  const looksInternal =
    e.isAxiosError === true ||
    e.severity !== undefined || // node-postgres DatabaseError
    e.routine !== undefined ||
    (typeof e.code === "string" && e.code.length > 0) || // pg SQLSTATE / system errors
    INTERNAL_PATTERN.test(e.message) ||
    e.message.length > 300;
  if (looksInternal) {
    console.error("[api] internal error hidden from client:", err);
    return fallback;
  }
  return e.message;
}

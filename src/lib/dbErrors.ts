/** Low-level database errors mapped to stable API responses. */
export function isCircuitBreakerError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return (
    msg.includes("ECIRCUITBREAKER") ||
    msg.includes("too many authentication failures") ||
    msg.includes("too many connections")
  );
}

export function getDbErrorStatus(error: unknown): number {
  return isCircuitBreakerError(error) ? 503 : 500;
}

export function getDbErrorMessage(error: unknown): string {
  // Client-facing: never echo driver details such as table names or SQL.
  if (isCircuitBreakerError(error)) {
    console.error("[db] circuit breaker: verify database credentials and wait ~60s", error);
    return "Database temporarily unavailable. Please try again in a minute.";
  }
  console.error("[db] error hidden from client:", error);
  return "Internal database error";
}

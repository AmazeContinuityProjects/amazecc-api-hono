/**
 * Shared bits for the authenticated EventHub routes.
 */
export function credentialsRejected(noCredentials: boolean): Response {
  const noCreds = noCredentials;
  return Response.json(
    {
      error: noCreds
        ? "No Event Hub credentials were supplied."
        : "Event Hub authentication failed. Please check your credentials.",
      reason: noCreds ? "missing_credentials" : "invalid_credentials",
    },
    { status: 401 },
  );
}

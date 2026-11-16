import { getWorkerEnv } from "../env";

/** Return the service-data D1 binding; migrations own the transport schema. */
export async function ensureTransportInD1(): Promise<D1Database> {
  const db = getWorkerEnv().APP_DB;
  if (!db) throw new Error("APP_DB is not configured");
  return db;
}

export function decodeTransportRoute<T extends Record<string, unknown>>(route: T): T {
  const decode = (value: unknown) => {
    if (typeof value !== "string") return value ?? [];
    try { return JSON.parse(value); } catch { return []; }
  };
  return { ...route, stops: decode(route.stops), placements: decode(route.placements) };
}

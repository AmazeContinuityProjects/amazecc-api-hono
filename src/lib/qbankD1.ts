import { getWorkerEnv } from "../env";

/** Return the service-data D1 binding; migrations own the QBank schema. */
export async function ensureQbankInD1(): Promise<D1Database> {
  const db = getWorkerEnv().APP_DB;
  if (!db) throw new Error("APP_DB is not configured");
  return db;
}

export function decodeQbankQuestions<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => {
    const value = row.options;
    if (typeof value !== "string") return row;
    try {
      return { ...row, options: JSON.parse(value) };
    } catch {
      return row;
    }
  });
}

export async function nextQbankId(): Promise<string> {
  return crypto.randomUUID();
}


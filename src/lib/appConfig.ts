import { getWorkerEnv } from "../env";

function requireAppConfigDb(): NonNullable<ReturnType<typeof getWorkerEnv>["APP_DB"]> {
  const db = getWorkerEnv().APP_DB;
  if (!db) throw new Error("APP_DB is not configured");
  return db;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const CONFIG_CACHE_TTL_MS = 60_000;
const configMemoryCache = new Map<string, { value: unknown; expiresAt: number }>();

/** Read application configuration from the verified service-data D1 database. */
export async function readAppConfig<T = unknown>(key: string): Promise<T | null> {
  const now = Date.now();
  const cached = configMemoryCache.get(key);
  if (cached && now < cached.expiresAt) {
    return cached.value as T;
  }

  const db = requireAppConfigDb();
  const row = await db.prepare("SELECT value FROM app_config WHERE key = ?")
    .bind(key).first<{ value: string }>();
  const parsed = row ? parseJsonValue(row.value) as T : null;

  configMemoryCache.set(key, { value: parsed, expiresAt: now + CONFIG_CACHE_TTL_MS });
  return parsed;
}

/** Write application configuration to the verified service-data D1 database. */
export async function writeAppConfig(key: string, value: unknown): Promise<void> {
  configMemoryCache.delete(key);
  const serialized = JSON.stringify(value ?? null);
  const db = requireAppConfigDb();
  await db.prepare(`
      INSERT INTO app_config (key, value, updated_at)
      VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).bind(key, serialized).run();
}

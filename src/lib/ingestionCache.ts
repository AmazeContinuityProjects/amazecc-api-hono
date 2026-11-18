/**
 * Ingestion Cache — write-buffer and deduplication for student marks and class syncs.
 *
 * Avoids redundant D1 reads, curve recalculations, and row rewrites on repeated
 * attendance fetches when marks or course registrations have not changed.
 *
 * Two-tier cache:
 *   - L1: Worker isolate memory (0ms)
 *   - L2: Cloudflare Cache API (caches.default, edge-wide, 24h TTL, free/unlimited)
 */
import { hash } from "./generator";
import type { Contribution } from "./marksStats";
import type { courseItem } from "../types/data/attendance";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_MEMORY_ENTRIES = 5000;

interface CacheEntry {
  fingerprint: string;
  expiresAt: number;
}

const marksMemoryCache = new Map<string, CacheEntry>();
const classesMemoryCache = new Map<string, CacheEntry>();

function getEdgeCache(): Cache | null {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

/** Compute a deterministic SHA-256 fingerprint for a student's marks contributions. */
export function computeMarksFingerprint(contributions: Contribution[]): string {
  const normalized = contributions
    .map(
      (c) =>
        `${c.classId}:${c.scope}:${c.component?.trim().toLowerCase() ?? ""}:${
          c.title?.trim().toLowerCase() ?? ""
        }:${c.mark.toFixed(4)}`
    )
    .sort()
    .join("|");
  return hash(`marks-fp::${normalized}`);
}

/** Compute a deterministic fingerprint for a student's enrolled courses. */
export function computeClassesFingerprint(courses: courseItem[]): string {
  const normalized = courses
    .map(
      (c) =>
        `${(c.classId ?? "").trim().toUpperCase()}:${(c.courseCode ?? "").trim().toUpperCase()}:${(c.slotVenue ?? "").trim()}`
    )
    .sort()
    .join("|");
  return hash(`classes-fp::${normalized}`);
}

/** Check if marks ingestion for this student and semester can be skipped. */
export async function shouldSkipMarksIngestion(
  regNo: string,
  semesterId: string,
  fingerprint: string
): Promise<boolean> {
  const key = `${regNo.trim().toUpperCase()}::${semesterId.trim().toUpperCase()}`;
  const now = Date.now();

  // 1. L1 memory check
  const mem = marksMemoryCache.get(key);
  if (mem && now < mem.expiresAt) {
    return mem.fingerprint === fingerprint;
  }

  // 2. L2 Cache API check
  const edge = getEdgeCache();
  if (edge) {
    try {
      const cacheReq = new Request(`https://ingestion-cache.internal/marks/${encodeURIComponent(key)}`);
      const cached = await edge.match(cacheReq);
      if (cached) {
        const cachedFp = await cached.text();
        if (cachedFp === fingerprint) {
          // Promote to L1
          marksMemoryCache.set(key, { fingerprint, expiresAt: now + DAY_MS });
          return true;
        }
      }
    } catch {
      // Non-blocking; proceed to ingest on any cache lookup error
    }
  }

  return false;
}

/** Record that marks for this student and semester were ingested. */
export async function recordMarksIngested(
  regNo: string,
  semesterId: string,
  fingerprint: string
): Promise<void> {
  const key = `${regNo.trim().toUpperCase()}::${semesterId.trim().toUpperCase()}`;
  const now = Date.now();

  // Update L1
  if (marksMemoryCache.size >= MAX_MEMORY_ENTRIES) marksMemoryCache.clear();
  marksMemoryCache.set(key, { fingerprint, expiresAt: now + DAY_MS });

  // Update L2
  const edge = getEdgeCache();
  if (edge) {
    try {
      const cacheReq = new Request(`https://ingestion-cache.internal/marks/${encodeURIComponent(key)}`);
      const response = new Response(fingerprint, {
        headers: {
          "Cache-Control": "public, max-age=86400",
        },
      });
      await edge.put(cacheReq, response);
    } catch {
      // Non-blocking
    }
  }
}

/** Check if class registration sync for this student and semester can be skipped. */
export async function shouldSkipClassesSync(
  regNo: string,
  semesterId: string,
  fingerprint: string
): Promise<boolean> {
  const key = `${regNo.trim().toUpperCase()}::${semesterId.trim().toUpperCase()}`;
  const now = Date.now();

  const mem = classesMemoryCache.get(key);
  if (mem && now < mem.expiresAt) {
    return mem.fingerprint === fingerprint;
  }

  const edge = getEdgeCache();
  if (edge) {
    try {
      const cacheReq = new Request(`https://ingestion-cache.internal/classes/${encodeURIComponent(key)}`);
      const cached = await edge.match(cacheReq);
      if (cached) {
        const cachedFp = await cached.text();
        if (cachedFp === fingerprint) {
          classesMemoryCache.set(key, { fingerprint, expiresAt: now + DAY_MS });
          return true;
        }
      }
    } catch {
      // Non-blocking
    }
  }

  return false;
}

/** Record that classes for this student and semester were synced. */
export async function recordClassesSynced(
  regNo: string,
  semesterId: string,
  fingerprint: string
): Promise<void> {
  const key = `${regNo.trim().toUpperCase()}::${semesterId.trim().toUpperCase()}`;
  const now = Date.now();

  if (classesMemoryCache.size >= MAX_MEMORY_ENTRIES) classesMemoryCache.clear();
  classesMemoryCache.set(key, { fingerprint, expiresAt: now + DAY_MS });

  const edge = getEdgeCache();
  if (edge) {
    try {
      const cacheReq = new Request(`https://ingestion-cache.internal/classes/${encodeURIComponent(key)}`);
      const response = new Response(fingerprint, {
        headers: {
          "Cache-Control": "public, max-age=86400",
        },
      });
      await edge.put(cacheReq, response);
    } catch {
      // Non-blocking
    }
  }
}

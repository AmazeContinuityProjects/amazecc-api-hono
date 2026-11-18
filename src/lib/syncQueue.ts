/**
 * Asynchronous sync queue definitions for Cloudflare Queues.
 * Offloads heavy D1 writes and aggregations from user-facing HTTP requests.
 */
import { getWorkerEnv, type WorkerEnv } from "../env";
import type { Contribution } from "./marksStats";
import {
  ensureSchema,
  buildContributionStatements,
  buildSetRegisterNumberStatement,
  invalidateClassStatsCache,
} from "./marksStats";
import { upsertStudentProfile } from "./student-profiles";
import { ensureFfcsSemesterInD1, upsertD1RegisteredClasses } from "./socialD1";
import { generateHandle } from "./social";
import { recordMarksIngested, recordClassesSynced } from "./ingestionCache";

export type IngestMarksJob = {
  type: "INGEST_MARKS";
  regNo: string;
  semesterId: string;
  contributions: Contribution[];
  fingerprint: string;
  ownerKey: string;
  timestamp: number;
};

export type SyncClassesJob = {
  type: "SYNC_CLASSES";
  regNo: string;
  semesterId: string;
  fingerprint: string;
  ownerKey: string;
  courses: Array<{
    classId: string;
    courseCode: string;
    courseTitle: string;
    courseType: string;
    slot: string;
    faculty: string;
    credits: string;
    room: string;
  }>;
  timestamp: number;
};

export type SyncQueueMessage = IngestMarksJob | SyncClassesJob;

/**
 * Enqueue a background sync job.
 * Sends directly to Cloudflare Queue (amazecc-sync) to avoid blocking HTTP requests.
 * If not bound or queue fails, gracefully falls back to ctx.waitUntil or direct async execution.
 */
export async function enqueueSyncJob(
  job: SyncQueueMessage,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<void> {
  const env = getWorkerEnv();
  if (env.SYNC_QUEUE) {
    try {
      await env.SYNC_QUEUE.send(job);
      return;
    } catch (err) {
      console.warn("[syncQueue] queue send failed, falling back to background execution:", err);
    }
  }

  // Fallback: run in background via executionCtx or unawaited promise
  const work = processSyncJob(job).catch((err) => {
    console.error("[syncQueue] background job execution failed:", err);
  });

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(work);
  }
}

/** Process a single background job (runs inside fallback when queue binding is unset) */
export async function processSyncJob(job: SyncQueueMessage): Promise<void> {
  const db = getWorkerEnv().APP_DB;
  if (!db) return;
  const now = job.timestamp || Date.now();

  switch (job.type) {
    case "INGEST_MARKS": {
      const { regNo, semesterId, contributions, fingerprint, ownerKey } = job;
      await ensureSchema();
      const statements: D1PreparedStatement[] = [];
      const regStmt = buildSetRegisterNumberStatement(ownerKey, regNo);
      if (regStmt) statements.push(regStmt);

      for (const contribution of contributions) {
        const stmts = await buildContributionStatements(ownerKey, regNo, contribution, now);
        statements.push(...stmts);
      }

      const BATCH_CHUNK_SIZE = 100;
      for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
        await db.batch(statements.slice(i, i + BATCH_CHUNK_SIZE));
      }

      for (const c of contributions) {
        if (c.classId) invalidateClassStatsCache(c.classId);
      }
      await recordMarksIngested(regNo, semesterId, fingerprint);
      break;
    }

    case "SYNC_CLASSES": {
      const { regNo, semesterId, courses, fingerprint, ownerKey } = job;
      await upsertStudentProfile(regNo, { semester_id: semesterId });
      await ensureFfcsSemesterInD1(semesterId);
      await upsertD1RegisteredClasses({
        semesterId,
        ownerKey,
        registerNo: regNo,
        displayName: "",
        handle: generateHandle(regNo),
        courses,
      });
      await recordClassesSynced(regNo, semesterId, fingerprint);
      break;
    }

    default:
      console.warn("[syncQueue] unrecognized job type:", (job as any)?.type);
  }
}

/**
 * Cloudflare Worker Queue consumer entry point.
 * Micro-batches operations across up to 100 messages into bulk D1 transactions,
 * then performs a single cache refresh/invalidation at the end of the batch.
 */
export async function handleQueueBatch(
  batch: MessageBatch<SyncQueueMessage>,
  _env: WorkerEnv
): Promise<void> {
  const db = getWorkerEnv().APP_DB;
  if (!db) {
    console.error("[syncQueue] APP_DB not available during queue processing");
    return;
  }

  console.log(`[syncQueue] micro-batching ${batch.messages.length} messages`);
  await ensureSchema();

  const affectedClassIds = new Set<string>();
  const marksStatements: D1PreparedStatement[] = [];

  // 1. Process and coalesce messages across the entire batch
  for (const message of batch.messages) {
    try {
      if (message.body?.type === "INGEST_MARKS") {
        const { regNo, semesterId, contributions, fingerprint, ownerKey, timestamp } = message.body;
        const now = timestamp || Date.now();

        const regStmt = buildSetRegisterNumberStatement(ownerKey, regNo);
        if (regStmt) marksStatements.push(regStmt);

        for (const contribution of contributions) {
          if (contribution.classId) affectedClassIds.add(contribution.classId);
          const stmts = await buildContributionStatements(ownerKey, regNo, contribution, now);
          marksStatements.push(...stmts);
        }

        await recordMarksIngested(regNo, semesterId, fingerprint);
        message.ack();
      } else if (message.body?.type === "SYNC_CLASSES") {
        const { regNo, semesterId, courses, fingerprint, ownerKey } = message.body;
        await upsertStudentProfile(regNo, { semester_id: semesterId });
        await ensureFfcsSemesterInD1(semesterId);
        await upsertD1RegisteredClasses({
          semesterId,
          ownerKey,
          registerNo: regNo,
          displayName: "",
          handle: generateHandle(regNo),
          courses,
        });
        await recordClassesSynced(regNo, semesterId, fingerprint);
        message.ack();
      } else {
        message.ack();
      }
    } catch (err) {
      console.error(`[syncQueue] error processing message ${message.id}:`, err);
      message.retry();
    }
  }

  // 2. Execute coalesced statements in D1 bulk batches (up to 100 statements per round-trip)
  const BATCH_CHUNK_SIZE = 100;
  for (let i = 0; i < marksStatements.length; i += BATCH_CHUNK_SIZE) {
    const chunk = marksStatements.slice(i, i + BATCH_CHUNK_SIZE);
    try {
      await db.batch(chunk);
    } catch (err) {
      console.error(`[syncQueue] D1 batch execute failed on chunk of ${chunk.length} statements:`, err);
    }
  }

  // 3. Single cache invalidation/refresh for all modified classes at the end of the batch!
  for (const classId of affectedClassIds) {
    invalidateClassStatsCache(classId);
  }
  console.log(
    `[syncQueue] batch complete: executed ${marksStatements.length} SQL statements in bulk, refreshed stats for ${affectedClassIds.size} classes`
  );
}

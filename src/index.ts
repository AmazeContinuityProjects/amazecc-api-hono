/**
 * Worker entry. Bindings (Hyperdrive, queues, secrets) arrive per-request and
 * are stashed in module scope for the shared libs (db/auth/mask read them from
 * there); the route handlers additionally see them via Hono's `c.env`.
 *
 * The `queue` handler consumes background jobs pushed by routes that must
 * stay off the 10 ms CPU hot path (currently: the daily club sync enqueued
 * by /api/remote/login). Unknown job types are acked so they can't poison
 * the queue; transient failures are retried.
 */
import { app } from "./app";
import { setWorkerEnv, type WorkerEnv } from "./env";
import { syncClubsFromVtop, type ClubsSyncJob } from "./lib/syncClubs";

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext
  ): Promise<Response> {
    setWorkerEnv(env);
    return app.fetch(request, env, ctx);
  },

  async queue(
    batch: MessageBatch<unknown>,
    env: WorkerEnv,
    _ctx: ExecutionContext
  ): Promise<void> {
    setWorkerEnv(env);
    for (const message of batch.messages) {
      const body = message.body as Partial<ClubsSyncJob> | undefined;
      try {
        if (body?.type === "clubs-sync") {
          const { cookies, csrf, authorizedID } = body as ClubsSyncJob;
          if (cookies && csrf && authorizedID) {
            await syncClubsFromVtop({ cookies, csrf, authorizedID });
          }
          message.ack();
          continue;
        }
        console.warn("[queue] unknown job type, acking:", body?.type);
        message.ack();
      } catch (err) {
        console.error("[queue] job failed, retrying:", err);
        message.retry();
      }
    }
  },
};

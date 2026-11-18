/**
 * Worker entry. Bindings (D1, storage, secrets) arrive per-request and
 * are stashed in module scope for shared libraries that read them from
 * there); the route handlers additionally see them via Hono's `c.env`.
 */
import { app } from "./app";
import { setWorkerEnv, type WorkerEnv } from "./env";
import { handleQueueBatch, type SyncQueueMessage } from "./lib/syncQueue";

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
    batch: MessageBatch<SyncQueueMessage>,
    env: WorkerEnv,
    _ctx: ExecutionContext
  ): Promise<void> {
    setWorkerEnv(env);
    await handleQueueBatch(batch, env);
  },
};

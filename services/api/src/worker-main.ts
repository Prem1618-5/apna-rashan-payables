/** Standalone worker process (process type "worker"): `node dist/worker-main.js`. Use with RUN_WORKER=false on the API. */
import { ConfigError } from "./config.js";
import { migrate } from "./migrate.js";
import { createAppWorker, createRuntime } from "./runtime.js";

try {
  const { ctx, log } = await createRuntime();
  await migrate(ctx.pool, log);
  const worker = createAppWorker(ctx, log);
  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    setTimeout(() => process.exit(1), 28_000).unref();
    await worker.stop(25_000);
    await ctx.pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  worker.start();
} catch (e) {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(e instanceof ConfigError ? 78 : 1);
}

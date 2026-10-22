/**
 * Entry point: parse config, migrate (advisory lock), create the owner on first boot, serve HTTP on
 * $PORT and, with RUN_WORKER=true, run the extraction worker in the same process.
 * SIGTERM/SIGINT: stop taking jobs and connections, finish in-flight work, release leases, close the pool,
 * exit within 30 s.
 */
import { buildApp } from "./app.js";
import { ensureOwner } from "./auth.js";
import { ConfigError } from "./config.js";
import { migrate } from "./migrate.js";
import { createAppWorker, createRuntime } from "./runtime.js";

const SHUTDOWN_DEADLINE_MS = 28_000;

async function main() {
  let runtime: Awaited<ReturnType<typeof createRuntime>>;
  try {
    runtime = await createRuntime();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(78); // EX_CONFIG
    }
    throw e;
  }
  const { ctx, log } = runtime;

  await migrate(ctx.pool, log);
  await ensureOwner(ctx.pool, ctx.config, log);

  const app = await buildApp(ctx, { loggerInstance: log });
  const worker = ctx.config.RUN_WORKER ? createAppWorker(ctx, log) : undefined;

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) {
      log.warn({ signal }, "second signal, exiting now");
      process.exit(1);
    }
    stopping = true;
    log.info({ signal }, "shutting down");
    const deadline = setTimeout(() => {
      log.error({}, "shutdown deadline reached, exiting");
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    try {
      const workerStopped = worker?.stop(20_000); // stops claiming immediately
      await app.close(); // stop accepting, wait for in-flight requests
      await workerStopped;
      await ctx.pool.end();
      log.info({}, "bye");
      process.exit(0);
    } catch (e) {
      log.error({ err: (e as Error).message }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: ctx.config.PORT, host: "0.0.0.0" });
  worker?.start();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

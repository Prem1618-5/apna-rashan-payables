/** Wires config → pool, storage, extractor. Shared by the server, the standalone worker and the seed. */
import pino, { type Logger } from "pino";
import { loadConfig, type Config } from "./config.js";
import type { AppContext } from "./context.js";
import { createPool } from "./db.js";
import { createExtractorFromEnv } from "./extraction.js";
import { createStorage } from "./storage.js";
import { loggerOptions } from "./app.js";
import { createWorker, type Worker, type WorkerOptions } from "./worker.js";
import { createExtractHandler } from "./services/extract-job.js";

export function createLogger(config: Pick<Config, "LOG_LEVEL">): Logger {
  return pino(loggerOptions(config.LOG_LEVEL));
}

export async function createRuntime(env: NodeJS.ProcessEnv = process.env, log?: Logger): Promise<{ ctx: AppContext; log: Logger }> {
  const config = loadConfig(env);
  const logger = log ?? createLogger(config);
  if (config.dataKeyDerived) logger.warn({}, "DATA_ENCRYPTION_KEY is not set; using a key derived from SESSION_SECRET (development only)");
  const pool = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  const storage = createStorage(config);
  const extractor = await createExtractorFromEnv(config, env, logger);
  return { ctx: { config, pool, storage, extractor }, log: logger };
}

export function createAppWorker(ctx: AppContext, log: Logger, opts: WorkerOptions = {}): Worker {
  return createWorker(ctx.pool, { extract: createExtractHandler(ctx) }, log.child({ component: "worker" }), opts);
}

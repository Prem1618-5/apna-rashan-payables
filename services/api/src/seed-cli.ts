/** pnpm --filter @arad/api seed [--reset]   (development data only; refuses NODE_ENV=production) */
import { ConfigError } from "./config.js";
import { migrate } from "./migrate.js";
import { createRuntime } from "./runtime.js";
import { resetDatabase, seed } from "./seed.js";

const reset = process.argv.includes("--reset");
try {
  const { ctx, log } = await createRuntime();
  if (ctx.config.isProd) {
    log.error({}, "refusing to seed when NODE_ENV=production");
    process.exit(1);
  }
  if (reset) {
    await resetDatabase(ctx.pool);
    log.info({}, "database reset");
  }
  await migrate(ctx.pool, log);
  const r = await seed(ctx, log);
  await ctx.pool.end();
  if (r.stores) {
    console.log(`Seeded ${r.stores} stores, ${r.vendors} vendors, ${r.invoices} bills.`);
    console.log("Owner: phone 9000000001, PIN 1234. Staff: 9000000011..9000000016, PIN 1111 (one per store).");
  }
} catch (e) {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
}

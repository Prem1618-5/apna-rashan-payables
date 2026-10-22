/** pnpm --filter @arad/api migrate */
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const pool = createPool(url, 1);
try {
  const applied = await migrate(pool, { info: (o) => console.log(JSON.stringify(o)) });
  console.log(applied.length ? `applied ${applied.length} migration(s)` : "database is up to date");
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

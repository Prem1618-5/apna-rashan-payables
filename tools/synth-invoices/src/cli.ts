/**
 * pnpm --filter @arad/synth-invoices gen --count 20 --seed 42 [--out dir] [--layout thermal,hindi] [--clean]
 * pnpm --filter @arad/synth-invoices samples      # rewrites the committed samples/ (6 invoices, ≤ 300 KB each)
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./generate.js";
import { LAYOUTS, type Layout } from "./model.js";

const here = fileURLToPath(new URL("..", import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const samples = flag("samples");
  const count = Number(arg("count") ?? (samples ? 6 : 20));
  const seed = Number(arg("seed") ?? 42);
  const outDir = resolve(arg("out") ?? (samples ? resolve(here, "samples") : resolve(here, "out")));
  const layouts = (arg("layout")?.split(",") ?? (samples ? ["a4-table", "thermal", "hindi", "igst", "credit-note", "a4-table"] : [])) as Layout[];
  for (const l of layouts) if (!LAYOUTS.includes(l)) throw new Error(`unknown layout ${l}; use ${LAYOUTS.join(", ")}`);
  const t0 = Date.now();
  const truths = await generate({ count, seed, outDir, layouts, clean: flag("clean"), maxBytes: samples ? 290_000 : undefined, multiPage: samples ? [5] : undefined, log: (m) => console.log(m) });
  console.log(`wrote ${truths.length} invoices to ${outDir} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

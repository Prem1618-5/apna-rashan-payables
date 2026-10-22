// Prints gzip size of every built JS/CSS chunk and checks the initial-load budget (docs/BUILD.md).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dist = new URL("../dist/", import.meta.url).pathname;
const BUDGET_INITIAL = 120 * 1024;
const BUDGET_SHELL = 250 * 1024;

const html = readFileSync(join(dist, "index.html"), "utf8");
// Initial = what index.html loads: entry script, modulepreloads, stylesheets.
const initial = new Set([...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]));

const rows = [];
for (const f of readdirSync(join(dist, "assets"))) {
  if (!/\.(js|css)$/.test(f)) continue;
  const p = join(dist, "assets", f);
  const buf = readFileSync(p);
  rows.push({ file: `assets/${f}`, raw: statSync(p).size, gz: gzipSync(buf, { level: 9 }).length });
}
rows.sort((a, b) => Number(initial.has(b.file)) - Number(initial.has(a.file)) || b.gz - a.gz);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
let initJs = 0;
let initAll = 0;
let total = 0;
console.log("\nchunk".padEnd(58) + "raw".padStart(11) + "gzip".padStart(11));
for (const r of rows) {
  const init = initial.has(r.file);
  if (init && r.file.endsWith(".js")) initJs += r.gz;
  if (init) initAll += r.gz;
  total += r.gz;
  console.log(`${init ? "* " : "  "}${r.file}`.padEnd(58) + kb(r.raw).padStart(11) + kb(r.gz).padStart(11));
}
console.log(`\n* initial JS (gzip): ${kb(initJs)}  budget ${kb(BUDGET_INITIAL)}`);
console.log(`  initial JS+CSS (gzip): ${kb(initAll)}`);
console.log(`  all chunks (gzip, incl. lazy + mock backend): ${kb(total)}  (app-shell budget ${kb(BUDGET_SHELL)} applies to non-mock code)`);
if (initJs > BUDGET_INITIAL) {
  console.error("\nInitial JS is over budget.");
  process.exit(1);
}

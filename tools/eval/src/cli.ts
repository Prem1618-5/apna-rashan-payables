/**
 * pnpm --filter @arad/eval run eval --dir <folder> [--live | --replay <cacheDir>] [options]
 *
 *   (default)          simulated readers with OCR-like mistakes; no network; tests the merger
 *   --live             real providers from env (GEMINI_API_KEY_*, TEXTRACT_ENABLED …); raw outputs cached
 *   --replay <dir>     re-score cached raw outputs (no calls) — e.g. after changing the merger
 *   --cache <dir>      where --live stores raw outputs (default <dir>/.eval-cache)
 *   --limit N          first N invoices only          --only a,b   only these ids
 *   --no-qr            do not give the e-invoice QR to the extractor
 *   --real             treat the folder as real invoices (dataClass "real": training providers blocked)
 *   --write-drafts     for invoices without truth, write <name>.draft.json to correct by hand
 *   --report <file>    markdown report path (default <dir>/eval-report.md)
 *   --title "..."      report title          --pace <ms>   pause between live invoices (default 4000)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { providersFromEnv, silentLogger } from "@arad/extraction";
import { loadCases } from "./cases.js";
import { renderReport } from "./report.js";
import { runEval, writeTruthDraft, type Mode } from "./run.js";
import { tally } from "./score.js";

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (n: string) => argv.includes(`--${n}`);

async function main() {
  const dirArg = arg("dir");
  if (!dirArg) throw new Error("usage: eval --dir <folder> [--live | --replay <cacheDir>]");
  // pnpm --filter runs inside the package folder; resolve relative paths from where the user typed the command.
  const base = process.env.INIT_CWD ?? process.cwd();
  const dir = resolve(base, dirArg);
  const replay = arg("replay");
  const mode: Mode = flag("live") ? "live" : replay ? "replay" : "sim";
  const cacheDir = resolve(base, replay ?? arg("cache") ?? resolve(dir, ".eval-cache"));
  const real = flag("real");
  let cases = loadCases(dir, { real: real ? true : undefined });
  const only = arg("only")?.split(",");
  if (only) cases = cases.filter((c) => only.includes(c.id));
  const limit = Number(arg("limit") ?? 0);
  if (limit) cases = cases.slice(0, limit);
  if (!cases.length) throw new Error(`no invoices found in ${dir}`);

  const env = process.env as Record<string, string | undefined>;
  const useQr = !flag("no-qr");
  console.log(`${cases.length} invoices from ${dir} · mode ${mode}${mode === "live" ? ` · cache ${cacheDir}` : ""}`);
  const results = await runEval(cases, {
    mode,
    env,
    cacheDir,
    useQr,
    paceMs: Number(arg("pace") ?? 4000),
    storeGstins: env.STORE_GSTINS?.split(",").map((s) => s.trim()).filter(Boolean),
    log: (m) => console.log(m),
  });

  if (flag("write-drafts")) {
    for (const r of results) {
      const c = cases.find((x) => x.id === r.id)!;
      if (!c.truth) console.log(`draft truth: ${writeTruthDraft(c, r)}`);
    }
  }

  const synthetic = cases.every((c) => c.dataClass === "synthetic");
  const models = mode === "live" ? providersFromEnv(env, { logger: silentLogger }).filter((p) => p.available()).map((p) => p.id) : mode === "sim" ? ["sim-a", "sim-b (simulated OCR mistakes)"] : [`replay of ${cacheDir}`];
  const date = new Date().toISOString().slice(0, 10);
  const md = renderReport(results, {
    title: arg("title") ?? `Extraction evaluation — ${synthetic ? "synthetic" : "real"} invoices, ${date}`,
    mode,
    dataLabel: synthetic ? "SYNTHETIC DATA: generated invoices (tools/synth-invoices), not real vendor bills. Real-world accuracy will be lower; do not quote these numbers as production accuracy." : "Real invoices (kept outside git).",
    dir: dirArg,
    date,
    models,
    useQr,
  });
  const reportPath = resolve(base, arg("report") ?? resolve(dir, "eval-report.md"));
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, md);
  const t = tally(results.flatMap((r) => r.merged));
  console.log(`merged: ${t.ok}/${t.n} correct · ${t.caught} caught · ${t.silent} silent · ${t.falseAlarms} false alarms`);
  console.log(`report: ${reportPath}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

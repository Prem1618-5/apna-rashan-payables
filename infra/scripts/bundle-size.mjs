#!/usr/bin/env node
// Gzip size report for the built PWA (apps/web/dist).
//
//   node infra/scripts/bundle-size.mjs [distDir]
//
// Budgets (docs/BUILD.md): initial JS <= 120 KB gzip, app shell <= 250 KB gzip.
// "Initial JS" = scripts and modulepreloads referenced by index.html.
// "App shell"  = initial JS + CSS referenced by index.html + index.html itself.
// Writes a Markdown table to $GITHUB_STEP_SUMMARY when set. Over budget is a
// warning, or a failure when BUNDLE_BUDGET_ENFORCE=true.
import { readFileSync, readdirSync, statSync, appendFileSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { gzipSync } from "node:zlib";

const dist = process.argv[2] ?? "apps/web/dist";
const BUDGET_INITIAL_JS = 120 * 1024;
const BUDGET_SHELL = 250 * 1024;

if (!existsSync(join(dist, "index.html"))) {
  console.error(`No ${join(dist, "index.html")} - build the web app first.`);
  process.exit(1);
}

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const gz = (p) => gzipSync(readFileSync(p), { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const html = readFileSync(join(dist, "index.html"), "utf8");
const refs = new Set();
for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']?([^"'\s>]+)["']?[^>]*>/g)) {
  const tag = m[0];
  const url = m[1];
  if (/^(https?:)?\/\//.test(url)) continue;
  const isScript = tag.startsWith("<script");
  const isPreload = /rel=["']?modulepreload/.test(tag);
  const isCss = /rel=["']?stylesheet/.test(tag);
  if (isScript || isPreload || isCss) refs.add(url.replace(/^\//, "").split("?")[0]);
}

const files = walk(dist)
  .filter((p) => [".js", ".css", ".html", ".webmanifest", ".wasm"].includes(extname(p)))
  .map((p) => ({ path: relative(dist, p), raw: statSync(p).size, gzip: gz(p) }))
  .sort((a, b) => b.gzip - a.gzip);

const initial = files.filter((f) => refs.has(f.path));
const initialJs = initial.filter((f) => f.path.endsWith(".js")).reduce((s, f) => s + f.gzip, 0);
const shell = initial.reduce((s, f) => s + f.gzip, 0) + gz(join(dist, "index.html"));
const total = files.reduce((s, f) => s + f.gzip, 0);

const okJs = initialJs <= BUDGET_INITIAL_JS;
const okShell = shell <= BUDGET_SHELL;

const lines = [
  "## Web bundle size (gzip)",
  "",
  "| Check | Size | Budget | |",
  "|---|---:|---:|---|",
  `| Initial JS | ${kb(initialJs)} | ${kb(BUDGET_INITIAL_JS)} | ${okJs ? "ok" : "OVER"} |`,
  `| App shell (initial JS + CSS + HTML) | ${kb(shell)} | ${kb(BUDGET_SHELL)} | ${okShell ? "ok" : "OVER"} |`,
  `| All JS/CSS/HTML/wasm | ${kb(total)} | | |`,
  "",
  "<details><summary>Largest files</summary>",
  "",
  "| File | Raw | Gzip | Initial |",
  "|---|---:|---:|---|",
  ...files.slice(0, 25).map((f) => `| ${f.path} | ${kb(f.raw)} | ${kb(f.gzip)} | ${refs.has(f.path) ? "yes" : ""} |`),
  "",
  "</details>",
  "",
];

console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");

if (!okJs || !okShell) {
  const msg = `Bundle over budget: initial JS ${kb(initialJs)} (budget ${kb(BUDGET_INITIAL_JS)}), shell ${kb(shell)} (budget ${kb(BUDGET_SHELL)})`;
  if (process.env.BUNDLE_BUDGET_ENFORCE === "true") {
    console.log(`::error::${msg}`);
    process.exit(1);
  }
  console.log(`::warning::${msg}`);
}

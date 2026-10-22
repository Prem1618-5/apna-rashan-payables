/** Markdown report for an evaluation run. */

import type { CaseResult } from "./run.js";
import { groupBy, tally, type FieldResult, type Tally } from "./score.js";

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");

export interface ReportMeta {
  title: string;
  mode: string;
  dataLabel: string;
  dir: string;
  date: string;
  models?: string[];
  useQr: boolean;
  extra?: string[];
}

function row(label: string, t: Tally, withCaught: boolean) {
  return withCaught
    ? `| ${label} | ${t.n} | ${pct(t.ok, t.n)} | ${t.wrong} | ${t.caught} | **${t.silent}** | ${pct(t.silent, t.n)} | ${t.falseAlarms} |`
    : `| ${label} | ${t.n} | ${pct(t.ok, t.n)} | ${t.wrong} |`;
}

export function renderReport(results: CaseResult[], meta: ReportMeta): string {
  const withTruth = results.filter((r) => r.hasTruth);
  const merged = withTruth.flatMap((r) => r.merged);
  const readerSlots = new Map<number, FieldResult[]>();
  const readerNames = new Map<number, Set<string>>();
  for (const r of withTruth) {
    r.readers.forEach((x, i) => {
      readerSlots.set(i, [...(readerSlots.get(i) ?? []), ...x.results]);
      readerNames.set(i, (readerNames.get(i) ?? new Set()).add(x.provider));
    });
  }
  const L: string[] = [];
  L.push(`# ${meta.title}`, "");
  L.push(`> **${meta.dataLabel}**`, "");
  L.push(`- Date: ${meta.date}`);
  L.push(`- Mode: \`${meta.mode}\`${meta.models?.length ? ` · readers: ${meta.models.map((m) => `\`${m}\``).join(", ")}` : ""}`);
  L.push(`- Invoices: ${results.length} (${withTruth.length} with ground truth) · pages: ${results.reduce((s, r) => s + r.pages, 0)}`);
  L.push(`- E-invoice QR given to the extractor (as the phone would decode it): ${meta.useQr ? "yes, when the invoice has one" : "no"}`);
  L.push(`- Folder: \`${meta.dir}\``);
  for (const e of meta.extra ?? []) L.push(`- ${e}`);
  L.push("");

  if (withTruth.length) {
    L.push("## Headline", "");
    const m = tally(merged);
    L.push(`- Merged draft: **${pct(m.ok, m.n)}** of ${m.n} fields correct.`);
    L.push(`- Of the ${m.wrong} wrong fields, **${m.caught} were flagged** for review and **${m.silent} were silent** (wrong but looked fine) — silent error rate **${pct(m.silent, m.n)}**.`);
    L.push(`- False alarms (correct but flagged): ${m.falseAlarms} (${pct(m.falseAlarms, m.n)} of fields) — extra review work, not errors.`);
    const silentInv = withTruth.filter((r) => r.merged.some((x) => !x.ok && !x.caught)).length;
    const perfect = withTruth.filter((r) => r.merged.every((x) => x.ok)).length;
    L.push(`- Invoices fully correct: ${perfect}/${withTruth.length}. Invoices with at least one silent error: **${silentInv}/${withTruth.length}**.`);
    L.push("");
    L.push("A field is *flagged* when the merger marks it `flagged` or gives it confidence below 0.8 (the verify screen highlights it). A missing line counts as caught when the totals no longer add up (the balance-to-zero meter shows it).", "");

    L.push("## Accuracy by reader", "");
    L.push("| Variant | Fields | Correct | Wrong |", "|---|---:|---:|---:|");
    for (const [i, rs] of [...readerSlots.entries()].sort((a, b) => a[0] - b[0])) L.push(row(`Reader ${i + 1} alone (${[...(readerNames.get(i) ?? [])].join(", ")})`, tally(rs), false));
    L.push(row("Merged", tally(merged), false));
    L.push("");

    L.push("## Merged + flags: caught vs silent", "");
    L.push("| Group | Fields | Correct | Wrong | Caught (flagged) | Silent | Silent rate | False alarms |", "|---|---:|---:|---:|---:|---:|---:|---:|");
    for (const g of ["header", "totals", "lines"]) L.push(row(g, tally(merged.filter((x) => x.group === g)), true));
    L.push(row("**all**", tally(merged), true));
    L.push("");

    L.push("## By field (merged)", "");
    L.push("| Field | Fields | Correct | Wrong | Caught | Silent | Silent rate | False alarms |", "|---|---:|---:|---:|---:|---:|---:|---:|");
    for (const [k, rs] of [...groupBy(merged, (x) => `${x.group}.${x.field}`).entries()].sort()) L.push(row(`\`${k}\``, tally(rs), true));
    L.push("");

    if (readerSlots.size) {
      L.push("## By field (each reader alone)", "");
      const fields = [...groupBy(merged, (x) => `${x.group}.${x.field}`).keys()].sort();
      L.push(`| Field | ${[...readerSlots.keys()].map((i) => `Reader ${i + 1}`).join(" | ")} | Merged |`, `|---|${[...readerSlots.keys()].map(() => "---:").join("|")}|---:|`);
      for (const f of fields) {
        const cells = [...readerSlots.entries()].sort((a, b) => a[0] - b[0]).map(([, rs]) => {
          const t = tally(rs.filter((x) => `${x.group}.${x.field}` === f));
          return pct(t.ok, t.n);
        });
        const t = tally(merged.filter((x) => `${x.group}.${x.field}` === f));
        L.push(`| \`${f}\` | ${cells.join(" | ")} | ${pct(t.ok, t.n)} |`);
      }
      L.push("");
    }

    L.push("## By layout (merged)", "");
    L.push("| Layout | Invoices | Fields | Correct | Wrong | Caught | Silent | Silent rate | False alarms |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const [k, rs] of [...groupBy(withTruth, (r) => r.layout ?? "real").entries()].sort()) {
      const t = tally(rs.flatMap((r) => r.merged));
      L.push(`| ${k} | ${rs.length} ${row("", t, true).slice(3)}`);
    }
    L.push("");

    const silent = merged.filter((x) => !x.ok && !x.caught);
    L.push("## Silent errors (the ones that matter)", "");
    if (!silent.length) L.push("None.", "");
    else {
      L.push("| Invoice | Field | Expected | Got |", "|---|---|---|---|");
      for (const s of silent) L.push(`| ${s.invoice} | ${s.group}.${s.field} | ${s.expected ?? "—"} | ${s.got ?? "—"} |`);
      L.push("");
    }
    const caught = merged.filter((x) => !x.ok && x.caught);
    if (caught.length) {
      L.push("<details><summary>Caught errors (flagged for review)</summary>", "", "| Invoice | Field | Expected | Got |", "|---|---|---|---|");
      for (const s of caught) L.push(`| ${s.invoice} | ${s.group}.${s.field} | ${s.expected ?? "—"} | ${s.got ?? "—"} |`);
      L.push("", "</details>", "");
    }
  }

  L.push("## Per invoice", "");
  L.push("| Invoice | Layout | Distortion | Readers | Correct | Silent | Flagged fields | Failed checks |", "|---|---|---|---|---:|---:|---:|---|");
  for (const r of results) {
    const t = tally(r.merged);
    const readers = r.runs.map((x) => `${x.provider}${x.ok ? ` (${(x.ms / 1000).toFixed(1)}s${x.keySlot !== undefined ? `, key ${x.keySlot}` : ""})` : ` ✗ ${x.error?.slice(0, 60) ?? ""}`}`).join("<br>");
    L.push(`| ${r.id} | ${r.layout ?? "—"} | ${r.distortions?.[0] ?? "—"} | ${readers} | ${r.hasTruth ? pct(t.ok, t.n) : "—"} | ${r.hasTruth ? t.silent : "—"} | ${r.flaggedFields}/${r.totalFields} | ${r.failedChecks.join(", ") || "none"} |`);
  }
  L.push("");

  const runs = results.flatMap((r) => r.runs);
  if (runs.length) {
    L.push("## Provider calls", "");
    L.push("| Provider | Calls | OK | Failed | Median latency |", "|---|---:|---:|---:|---:|");
    for (const [k, rs] of groupBy(runs, (x) => x.provider)) {
      const ok = rs.filter((x) => x.ok);
      const ms = ok.map((x) => x.ms).sort((a, b) => a - b);
      L.push(`| ${k} | ${rs.length} | ${ok.length} | ${rs.length - ok.length} | ${ms.length ? `${(ms[Math.floor(ms.length / 2)]! / 1000).toFixed(1)} s` : "—"} |`);
    }
    const errs = runs.filter((x) => !x.ok && x.error);
    if (errs.length) {
      L.push("", "Failures:", "");
      for (const e of errs) L.push(`- ${e.provider}: ${e.error}`);
    }
    L.push("");
  }
  return `${L.join("\n")}\n`;
}

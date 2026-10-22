import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { loadCases, runEval, scoreDraft, tally } from "../src/index.js";

const samples = fileURLToPath(new URL("../../synth-invoices/samples", import.meta.url));

describe("eval harness", () => {
  it("loads the committed synthetic samples with truth", () => {
    const cases = loadCases(samples);
    expect(cases.length).toBe(6);
    expect(cases.every((c) => c.truth?.expected && c.dataClass === "synthetic")).toBe(true);
  });

  it("perfect draft scores 100%, a wrong flagged field is caught, a wrong unflagged one is silent", () => {
    const c = loadCases(samples)[0]!;
    const exp = c.truth!.expected!;
    const draft = { header: { ...exp.header }, headerMeta: {}, totals: { ...exp.totals }, totalsMeta: {}, lines: exp.lines.map((l) => ({ ...l, meta: {} })) };
    expect(tally(scoreDraft("x", draft, exp)).wrong).toBe(0);
    draft.totals.grandTotalPaise += 100;
    draft.lines[0]!.qtyMilli += 1000;
    (draft.lines[0]!.meta as Record<string, unknown>).qtyMilli = { confidence: 0.5, flagged: true };
    const t = tally(scoreDraft("x", draft, exp));
    expect(t.wrong).toBe(2);
    expect(t.caught).toBe(1);
    expect(t.silent).toBe(1);
  });

  it("simulated mode runs offline end to end", async () => {
    const res = await runEval(loadCases(samples), { mode: "sim", env: {}, useQr: true });
    expect(res).toHaveLength(6);
    const t = tally(res.flatMap((r) => r.merged));
    expect(t.ok / t.n).toBeGreaterThan(0.9);
  });

  it("replays recorded live outputs without network", async () => {
    const cache = fileURLToPath(new URL("../recorded/2026-10-22", import.meta.url));
    const res = await runEval(loadCases(samples).filter((c) => c.id === "synth-7-001-thermal"), { mode: "replay", env: {}, cacheDir: cache, useQr: true });
    expect(res[0]!.runs[0]!.ok).toBe(true);
  });
});

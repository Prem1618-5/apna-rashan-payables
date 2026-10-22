import type { CheckResult, InvoiceDetail } from "@arad/core";
import { ChevronDown, CircleCheck, CircleMinus, CircleX, ShieldCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Amount, BottomBar, Spinner } from "../../components/ui";
import { useI18n, useT } from "../../i18n";
import { checkText } from "../../lib/checks";
import type { MeterState } from "./logic";

const ORDER = { fail: 0, warn: 1, pass: 2, skip: 3 } as const;

export function CheckRow({ c }: { c: CheckResult }) {
  const { t, lang } = useI18n();
  const icon =
    c.status === "pass" ? (
      <CircleCheck size={20} strokeWidth={1.75} className="text-ok" aria-label={t("check.pass")} />
    ) : c.status === "warn" ? (
      <TriangleAlert size={20} strokeWidth={1.75} className="text-warn" aria-label={t("check.warn")} />
    ) : c.status === "fail" ? (
      <CircleX size={20} strokeWidth={1.75} className="text-bad" aria-label={t("check.fail")} />
    ) : (
      <CircleMinus size={20} strokeWidth={1.75} className="text-muted" aria-label={t("check.skip")} />
    );
  return (
    <li className={`flex items-start gap-3 px-4 py-3 ${c.status === "fail" ? "bg-bad-soft" : ""}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className={`text-body ${c.status === "fail" ? "font-semibold text-bad" : c.status === "skip" ? "text-muted" : ""}`}>{checkText(c, lang)}</span>
    </li>
  );
}

export function ChecksList({ checks }: { checks: CheckResult[] }) {
  const t = useT();
  const [showPassed, setShowPassed] = useState(false);
  const sorted = [...checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const problems = sorted.filter((c) => c.status === "fail" || c.status === "warn");
  const rest = sorted.filter((c) => c.status === "pass" || c.status === "skip");
  return (
    <div className="card overflow-hidden">
      {problems.length > 0 && <ul className="divide-y divide-line">{problems.map((c, i) => <CheckRow key={`${c.id}${i}`} c={c} />)}</ul>}
      <button type="button" onClick={() => setShowPassed((s) => !s)} aria-expanded={showPassed} className={`flex min-h-12 w-full items-center gap-3 px-4 text-left ${problems.length ? "border-t border-line" : ""}`}>
        <CircleCheck size={20} strokeWidth={1.75} className="text-ok" />
        <span className="flex-1 font-semibold">{t("seal.passed", { n: rest.filter((c) => c.status === "pass").length })}</span>
        <ChevronDown size={18} strokeWidth={1.75} className={`text-muted transition-transform ${showPassed ? "rotate-180" : ""}`} />
      </button>
      {showPassed && <ul className="anim-fade divide-y divide-line border-t border-line">{rest.map((c, i) => <CheckRow key={`${c.id}${i}`} c={c} />)}</ul>}
    </div>
  );
}

export function SealStep({ inv, meter, onSeal, onBackToLines }: { inv: InvoiceDetail; meter: MeterState; onSeal: () => Promise<void>; onBackToLines: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const fails = inv.checks.filter((c) => c.status === "fail");
  const edits = inv.lines.filter((l) => l.status === "edited").length;
  const can = meter.balanced && fails.length === 0;
  return (
    <>
      <main className="mx-auto max-w-2xl px-4 pb-36 pt-4">
        <div className="card mb-4 p-4">
          <p className="text-cap text-muted">{t("seal.summary")}</p>
          <p className="mt-0.5 text-lead font-semibold">{inv.header.vendorName}</p>
          <p className="text-body text-muted">{[inv.header.invoiceNo, t("home.lines", { n: meter.totalCount }), edits ? t("seal.edits", { n: edits }) : ""].filter(Boolean).join(" · ")}</p>
          <p className="mt-2 text-amount font-semibold">
            <Amount paise={meter.lockedPaise} />
          </p>
        </div>
        <h2 className="section-title mb-2 px-1">{t("seal.checks")}</h2>
        <ChecksList checks={inv.checks} />
        {!can && (
          <div className="mt-4 rounded-[14px] bg-bad-soft p-3 text-body text-bad" role="alert">
            {!meter.balanced ? t("seal.notBalanced") : t("seal.fixFails")}
            <button type="button" className="btn btn-secondary mt-3 w-full" onClick={onBackToLines}>
              {t("seal.backToLines")}
            </button>
          </div>
        )}
      </main>
      <BottomBar>
        <button
          type="button"
          className="btn btn-primary btn-block min-h-14"
          disabled={!can || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSeal();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner /> : <ShieldCheck size={22} strokeWidth={1.75} />}
          {t("seal.seal")}
        </button>
      </BottomBar>
    </>
  );
}

/** The "bill balanced" moment: a check that draws itself (static when reduced motion is on). */
export function Balanced({ amount, lines, seconds, onNext, onHome, hasNext }: { amount: number; lines: number; seconds: number; onNext: () => void; onHome: () => void; hasNext: boolean }) {
  const t = useT();
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return (
    <div className="pt-safe pb-safe fixed inset-0 z-50 flex flex-col bg-bg" role="dialog" aria-modal="true" aria-labelledby="balanced-title">
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="relative mb-6 h-32 w-32">
          <span className="absolute inset-0 rounded-full bg-ok-soft" style={{ animation: "ring-out 900ms 250ms ease-out both" }} />
          <svg viewBox="0 0 120 120" className="anim-pop relative h-32 w-32" aria-hidden>
            <circle cx="60" cy="60" r="56" fill="var(--ok)" />
            <path d="M36 62l16 16 32-34" fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="80" style={{ ["--len" as string]: "80", animation: "draw 420ms 260ms var(--ease-out-soft) both" }} />
          </svg>
        </div>
        <h2 id="balanced-title" className="text-h1 font-semibold">
          {t("done.title")}
        </h2>
        <p className="mt-1 text-body text-muted">{t("done.text")}</p>
        <p className="mt-5 text-amount font-semibold">
          <Amount paise={amount} />
        </p>
        <p className="num mt-1 text-body text-muted">{t("done.stats", { lines, time: mins ? `${mins}m ${secs}s` : `${secs}s` })}</p>
      </div>
      <div className="mx-auto w-full max-w-md space-y-2 px-4 pb-4">
        {hasNext && (
          <button type="button" className="btn btn-primary btn-block min-h-14" onClick={onNext} autoFocus>
            {t("done.next")}
          </button>
        )}
        <button type="button" className={`btn btn-block min-h-14 ${hasNext ? "btn-secondary" : "btn-primary"}`} onClick={onHome}>
          {t("done.home")}
        </button>
      </div>
    </div>
  );
}

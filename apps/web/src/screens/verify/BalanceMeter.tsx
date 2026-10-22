import { CircleCheck, Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Amount } from "../../components/ui";
import { useT } from "../../i18n";
import { prefersReducedMotion } from "../../lib/haptics";
import type { MeterState } from "./logic";

/** Counts smoothly to the target (integer paise), instantly when reduced motion is on. */
export function useAnimatedNumber(target: number, ms = 320): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (prefersReducedMotion() || from.current === target) {
      from.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const e = 1 - (1 - p) ** 3;
      const v = Math.round(a + (target - a) * e);
      setValue(v);
      from.current = v;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/** Sticky "left to match" meter. Goal: ₹0.00. */
export function BalanceMeter({ m }: { m: MeterState }) {
  const t = useT();
  const shown = useAnimatedNumber(m.remainingPaise);
  const tone = m.balanced ? "text-ok" : m.stuck ? "text-warn" : "text-text";
  const bar = m.balanced ? "bg-ok" : m.remainingPaise < 0 ? "bg-bad" : "bg-brand";
  return (
    <div className="sticky top-[calc(env(safe-area-inset-top)+57px)] z-20 border-b border-line bg-bg/95 backdrop-blur">
      <div className="mx-auto max-w-2xl px-4 py-2.5">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-cap font-semibold text-muted">
              {m.balanced ? <CircleCheck size={14} strokeWidth={2} className="text-ok" /> : null}
              {m.balanced ? t("meter.balanced") : m.remainingPaise < 0 ? t("meter.over") : t("meter.left")}
            </p>
            <p className={`text-h1 font-semibold leading-8 ${tone}`} aria-live="polite" aria-atomic="true">
              <Amount paise={Math.abs(shown)} />
            </p>
          </div>
          <div className="text-right">
            <p className="flex items-center justify-end gap-1 text-cap text-muted">
              <Lock size={12} strokeWidth={2} />
              {t("meter.target")} <Amount paise={m.lockedPaise} className="font-semibold text-text" />
            </p>
            <p className="num text-cap text-muted">{t("meter.lines", { done: m.confirmedCount, total: m.totalCount })}</p>
          </div>
        </div>
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(m.progress * 100)}
          aria-label={t("meter.progress")}
        >
          <div className={`h-full origin-left rounded-full ${bar} transition-transform duration-300 ease-out`} style={{ transform: `scaleX(${m.balanced ? 1 : m.progress})` }} />
        </div>
      </div>
    </div>
  );
}

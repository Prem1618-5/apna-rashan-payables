import type { LockTotalResponse } from "@arad/core";
import { CircleAlert, Eye, Lock } from "lucide-react";
import { useCallback, useState } from "react";
import { applyKey, groupTyped, Keypad } from "../../components/Keypad";
import { Amount, Spinner } from "../../components/ui";
import { useT } from "../../i18n";
import { keypadToPaise } from "../../lib/format";
import { haptic } from "../../lib/haptics";

/**
 * Blind total: staff type the printed grand total before seeing what the machine read.
 * A mismatch reveals the machine's number and asks for one more careful look.
 */
export function TotalStep({ onLock }: { onLock: (paise: number) => Promise<LockTotalResponse> }) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [miss, setMiss] = useState<{ extracted: number; typed: number } | undefined>();
  const [shake, setShake] = useState(0);
  const paise = keypadToPaise(text);

  const onKey = useCallback((k: string) => setText((s) => applyKey(s, k, { decimal: true })), []);

  async function submit() {
    if (!paise || busy) return;
    setBusy(true);
    try {
      const r = await onLock(paise);
      if (!r.match && r.invoice.lockedTotalPaise === undefined) {
        haptic([20, 40, 20]);
        setShake((n) => n + 1);
        setMiss({ extracted: r.extractedTotalPaise, typed: paise });
        setText("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="pb-safe mx-auto flex min-h-[calc(100dvh-57px-env(safe-area-inset-top))] max-w-md flex-col px-4 pt-4">
      <div className="flex-1">
        <div className="mb-1 flex items-center gap-2 text-cap font-semibold text-brand">
          <Lock size={14} strokeWidth={2} />
          {t("total.step")}
        </div>
        <h2 className="text-title font-semibold">{t("total.title")}</h2>
        <p className="mt-1 text-body text-muted">{t("total.help")}</p>

        {miss && (
          <div className="anim-rise mt-4 rounded-[14px] border border-warn/40 bg-warn-soft p-3" role="alert">
            <p className="flex items-center gap-2 font-semibold text-warn">
              <Eye size={18} strokeWidth={2} /> {t("total.lookAgain")}
            </p>
            <p className="mt-1 text-body">
              {t("total.youTyped")} <Amount paise={miss.typed} strong />. {t("total.readerSaw")} <Amount paise={miss.extracted} strong />.
            </p>
            <p className="mt-1 text-cap text-muted">{t("total.lookAgainHelp")}</p>
          </div>
        )}

        <div key={shake} className={`mt-6 flex min-h-20 items-baseline justify-center gap-1 ${shake ? "anim-nudge" : ""}`} aria-live="polite">
          <span className="text-h1 text-muted">₹</span>
          <span className={`num text-[44px] font-semibold leading-[52px] ${text ? "text-text" : "text-muted/60"}`} data-testid="total-display">
            {groupTyped(text)}
          </span>
          <span className="ml-0.5 inline-block h-10 w-0.5 animate-pulse self-center bg-brand" aria-hidden />
        </div>
        {!miss && (
          <p className="mt-1 flex items-center justify-center gap-1.5 text-cap text-muted">
            <CircleAlert size={13} strokeWidth={2} /> {t("total.blind")}
          </p>
        )}
      </div>
      <div className="pb-4 pt-4">
        <Keypad onKey={onKey} decimal disabled={busy} />
        <button type="button" className="btn btn-primary btn-block mt-3 min-h-14" disabled={!paise || busy} onClick={() => void submit()}>
          {busy ? <Spinner /> : <Lock size={20} strokeWidth={1.75} />}
          {t("total.lock")}
        </button>
      </div>
    </main>
  );
}

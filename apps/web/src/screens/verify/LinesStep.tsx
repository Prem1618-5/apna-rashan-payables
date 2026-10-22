import type { InvoiceLine, LineInput } from "@arad/core";
import { Check, ChevronDown, CircleCheck, CopyX, ListPlus, PencilLine, Plus, SearchCheck, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Amount, BottomBar, ICON } from "../../components/ui";
import { useT } from "../../i18n";
import { dwellMs, pendingLines, type MeterState } from "./logic";
import { LineCard, type LineCardHandle, type PageInfo } from "./LineCard";
import { LineEditSheet } from "./LineEditSheet";
import { prefetch } from "./media";

export function LinesStep({
  lines,
  meter,
  pageFor,
  canUndo,
  onAccept,
  onSaveEdit,
  onRemove,
  onAdd,
  onUndo,
  onZoom,
  onContinue,
}: {
  lines: InvoiceLine[];
  meter: MeterState;
  pageFor: (l: InvoiceLine) => PageInfo | undefined;
  canUndo: boolean;
  onAccept: (l: InvoiceLine) => void;
  onSaveEdit: (l: InvoiceLine, input: LineInput) => Promise<void>;
  onRemove: (l: InvoiceLine) => Promise<void>;
  onAdd: (input: LineInput) => Promise<void>;
  onUndo: () => void;
  onZoom: (l: InvoiceLine) => void;
  onContinue: () => void;
}) {
  const t = useT();
  const pending = pendingLines(lines);
  const current = pending[0];
  const next = pending[1];
  const live = lines.filter((l) => l.status !== "removed");
  const position = current ? t("verify.position", { n: live.findIndex((l) => l.id === current.id) + 1, total: live.length }) : "";
  const card = useRef<LineCardHandle>(null);
  const [ready, setReady] = useState(false);
  const [tooSoon, setTooSoon] = useState(false);
  const [editing, setEditing] = useState<InvoiceLine | "new" | null>(null);
  const [suggested, setSuggested] = useState<number>();
  const [showDone, setShowDone] = useState(false);
  const flying = useRef(false);

  // Minimum look time per card.
  const dwell = current ? dwellMs(current) : 0;
  useEffect(() => {
    setReady(false);
    setTooSoon(false);
    if (!current) return;
    const timer = setTimeout(() => setReady(true), dwell);
    return () => clearTimeout(timer);
  }, [current?.id, dwell]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the next card in view after a swipe further down the page.
  useEffect(() => {
    if (current && window.scrollY > 0) window.scrollTo({ top: 0, behavior: "smooth" });
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Prefetch the page images the next cards need.
  useEffect(() => {
    prefetch(pending.slice(1, 3).map((l) => pageFor(l)?.url));
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function accept() {
    if (!current || flying.current) return;
    if (!ready) {
      setTooSoon(true);
      card.current?.nudge();
      return;
    }
    flying.current = true;
    await card.current?.fly("right");
    flying.current = false;
    onAccept(current);
  }
  function edit(l: InvoiceLine) {
    setEditing(l);
  }

  // Keyboard: → matches, ← fix, Backspace/Z undo (handy on desktop and for testing).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (editing || (e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowRight") void accept();
      else if (e.key === "ArrowLeft" && current) edit(current);
      else if ((e.key === "z" || e.key === "Backspace") && canUndo) onUndo();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const done = live.filter((l) => l.status === "accepted" || l.status === "edited");
  const removed = lines.filter((l) => l.status === "removed");
  const nextPage = next ? pageFor(next) : undefined;
  const curPage = current ? pageFor(current) : undefined;

  return (
    <>
      <main className="mx-auto max-w-2xl overflow-x-clip px-4 pb-40 pt-3">
        {current ? (
          <>
            <div className="relative">
              {next && (
                <div className="pointer-events-none absolute inset-x-0 top-0 origin-top translate-y-2.5 scale-[0.95] opacity-60" aria-hidden>
                  <LineCard line={next} page={nextPage} position="" canAccept={false} onAccept={() => {}} onEdit={() => {}} onTooSoon={() => {}} onZoom={() => {}} interactive={false} />
                </div>
              )}
              <div className="relative">
                <LineCard
                  key={current.id}
                  ref={card}
                  line={current}
                  page={curPage}
                  position={position}
                  canAccept={ready}
                  onAccept={() => onAccept(current)}
                  onEdit={() => edit(current)}
                  onTooSoon={() => setTooSoon(true)}
                  onZoom={() => onZoom(current)}
                />
              </div>
            </div>
            <p className={`mt-3 min-h-5 text-center text-cap ${tooSoon && !ready ? "font-semibold text-warn" : "text-muted"}`} aria-live="polite">
              {tooSoon && !ready ? t("verify.tooSoon") : t("verify.swipeHint")}
            </p>
          </>
        ) : (
          <AllChecked meter={meter} lines={lines} onAddMissing={(amt) => { setSuggested(amt); setEditing("new"); }} onEdit={(id) => { const l = lines.find((x) => x.id === id); if (l) edit(l); }} onRemove={(id) => { const l = lines.find((x) => x.id === id); if (l) void onRemove(l); }} />
        )}

        <div className="mt-4 flex justify-center">
          <button type="button" className="btn btn-ghost text-body" onClick={() => { setSuggested(undefined); setEditing("new"); }}>
            <ListPlus {...ICON} /> {t("verify.addLine")}
          </button>
        </div>

        {(done.length > 0 || removed.length > 0) && (
          <div className="card mt-2 overflow-hidden">
            <button type="button" className="flex min-h-12 w-full items-center gap-2 px-4 text-left" onClick={() => setShowDone((s) => !s)} aria-expanded={showDone}>
              <SearchCheck {...ICON} className="text-muted" />
              <span className="flex-1 font-semibold">{t("verify.checkedLines", { n: done.length })}</span>
              <ChevronDown size={18} strokeWidth={1.75} className={`text-muted transition-transform ${showDone ? "rotate-180" : ""}`} />
            </button>
            {showDone && (
              <ul className="anim-fade divide-y divide-line border-t border-line">
                {[...done, ...removed]
                  .sort((a, b) => a.idx - b.idx)
                  .map((l) => (
                    <li key={l.id}>
                      <button type="button" className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left active:bg-surface-2" onClick={() => edit(l)}>
                        {l.status === "edited" ? (
                          <PencilLine size={16} strokeWidth={2} className="shrink-0 text-info" aria-label={t("verify.statusEdited")} />
                        ) : l.status === "removed" ? (
                          <X size={16} strokeWidth={2} className="shrink-0 text-muted" aria-label={t("verify.statusRemoved")} />
                        ) : (
                          <Check size={16} strokeWidth={2.25} className="shrink-0 text-ok" aria-label={t("verify.statusAccepted")} />
                        )}
                        <span className={`min-w-0 flex-1 truncate ${l.status === "removed" ? "text-muted line-through" : ""}`}>{l.description}</span>
                        <Amount paise={l.totalPaise} className="text-body" />
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}
      </main>

      <BottomBar>
        {current ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col items-center gap-1">
              <button type="button" onClick={() => edit(current)} className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-warn/60 bg-surface text-warn active:scale-95" aria-label={t("verify.fixLine")}>
                <X size={26} strokeWidth={2.25} />
              </button>
              <span className="text-[12px] font-semibold text-muted">{t("verify.fix")}</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <button type="button" onClick={onUndo} disabled={!canUndo} className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-text disabled:opacity-35" aria-label={t("verify.undo")}>
                <Undo2 size={20} strokeWidth={1.75} />
              </button>
              <span className="text-[12px] font-semibold text-muted">{t("verify.undo")}</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <button
                type="button"
                onClick={() => void accept()}
                className={`relative flex h-16 w-16 items-center justify-center rounded-full transition-[background-color,transform] duration-200 active:scale-95 ${ready ? "bg-brand text-brand-ink" : "bg-brand-soft text-brand"}`}
                aria-label={t("verify.acceptLine")}
                aria-disabled={!ready}
                data-testid="accept-line"
              >
                <DwellRing key={current.id} ms={dwell} />
                <Check size={30} strokeWidth={2.5} />
              </button>
              <span className="text-[12px] font-semibold text-muted">{t("verify.matches")}</span>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-primary btn-block min-h-14" onClick={onContinue} disabled={!meter.balanced}>
            <CircleCheck {...ICON} />
            {meter.balanced ? t("verify.toSeal") : t("verify.balanceFirst")}
          </button>
        )}
      </BottomBar>

      <LineEditSheet
        open={editing !== null}
        line={editing && editing !== "new" ? editing : undefined}
        suggestedAmountPaise={editing === "new" ? suggested : undefined}
        onClose={() => setEditing(null)}
        onSave={async (input) => {
          if (editing === "new") await onAdd(input);
          else if (editing) await onSaveEdit(editing, input);
          setEditing(null);
        }}
        onRemove={
          editing && editing !== "new"
            ? async () => {
                await onRemove(editing);
                setEditing(null);
              }
            : undefined
        }
      />
    </>
  );
}

/** Thin ring that fills while the minimum look time runs. */
function DwellRing({ ms }: { ms: number }) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setGo(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const c = 2 * Math.PI * 30;
  return (
    <svg className="pointer-events-none absolute -inset-1 h-[72px] w-[72px] -rotate-90" viewBox="0 0 64 64" aria-hidden>
      <circle cx="32" cy="32" r="30" fill="none" stroke="var(--brand)" strokeOpacity="0.18" strokeWidth="3" />
      <circle
        cx="32"
        cy="32"
        r="30"
        fill="none"
        stroke="var(--brand)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={go ? 0 : c}
        style={{ transition: `stroke-dashoffset ${ms}ms linear` }}
      />
    </svg>
  );
}

function AllChecked({ meter, lines, onAddMissing, onEdit, onRemove }: { meter: MeterState; lines: InvoiceLine[]; onAddMissing: (amount: number) => void; onEdit: (id: string) => void; onRemove: (id: string) => void }) {
  const t = useT();
  const n = (id?: string) => (lines.find((l) => l.id === id)?.idx ?? 0) + 1;
  if (meter.balanced)
    return (
      <div className="card anim-rise flex flex-col items-center px-6 py-8 text-center">
        <div className="anim-pop mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-ok-soft text-ok">
          <CircleCheck size={30} strokeWidth={2} />
        </div>
        <p className="text-title font-semibold">{t("verify.allBalanced")}</p>
        <p className="mt-1 text-body text-muted">{t("verify.allBalancedText")}</p>
      </div>
    );
  return (
    <div className="card anim-rise p-4" role="alert">
      <p className="text-lead font-semibold">{t("verify.notBalanced")}</p>
      <p className="mt-1 text-body text-muted">
        {meter.remainingPaise > 0 ? t("verify.shortBy") : t("verify.overBy")} <Amount paise={Math.abs(meter.remainingPaise)} strong className="text-text" />. {t("verify.notBalancedText")}
      </p>
      <div className="mt-3 space-y-2">
        {meter.hints.map((h, i) =>
          h.kind === "missing_line" ? (
            <button key={i} type="button" className="flex w-full items-center gap-3 rounded-[12px] bg-surface-2 p-3 text-left" onClick={() => onAddMissing(h.amountPaise)}>
              <Plus {...ICON} className="shrink-0 text-brand" />
              <span className="flex-1 text-body">{t("hint.missing", { amount: "" })}<Amount paise={h.amountPaise} strong /></span>
            </button>
          ) : h.kind === "duplicate_line" ? (
            <button key={i} type="button" className="flex w-full items-center gap-3 rounded-[12px] bg-surface-2 p-3 text-left" onClick={() => onRemove(h.lineId!)}>
              <CopyX {...ICON} className="shrink-0 text-bad" />
              <span className="flex-1 text-body">{t("hint.duplicate", { n: n(h.lineId) })}</span>
            </button>
          ) : (
            <button key={i} type="button" className="flex w-full items-center gap-3 rounded-[12px] bg-surface-2 p-3 text-left" onClick={() => onEdit(h.lineId!)}>
              <PencilLine {...ICON} className="shrink-0 text-warn" />
              <span className="flex-1 text-body">{t("hint.off", { n: n(h.lineId) })}</span>
            </button>
          ),
        )}
        {meter.hints.length === 0 && <p className="text-body text-muted">{t("hint.none")}</p>}
      </div>
    </div>
  );
}

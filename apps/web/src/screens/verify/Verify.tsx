import type { InvoiceDetail, InvoiceLine, LineInput, LineStatus } from "@arad/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { api, ApiError, errorMessage } from "../../api/client";
import { useSession } from "../../app/session";
import { useToast } from "../../components/toast";
import { ErrorState, Header, ListSkeleton, Sheet, Skeleton, Spinner, StateBadge } from "../../components/ui";
import { useI18n } from "../../i18n";
import { haptic } from "../../lib/haptics";
import { invalidate } from "../../lib/resource";
import { BalanceMeter } from "./BalanceMeter";
import { HeaderStep } from "./HeaderStep";
import { LinesStep } from "./LinesStep";
import { effectiveLines, meterState, type LocalStatus } from "./logic";
import { PageViewer, usePageSize } from "./media";
import { Balanced, SealStep } from "./SealStep";
import { TotalStep } from "./TotalStep";

type Step = "header" | "total" | "lines" | "seal";
const STEPS: Step[] = ["header", "total", "lines", "seal"];

export default function Verify({ id }: { id: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [, navigate] = useLocation();
  const { stores } = useSession();
  const [inv, setInv] = useState<InvoiceDetail>();
  const [error, setError] = useState<unknown>();
  const [step, setStep] = useState<Step>("header");
  const [local, setLocal] = useState<LocalStatus>({});
  const [history, setHistory] = useState<{ lineId: string; prev: LineStatus }[]>([]);
  const [zoom, setZoom] = useState<{ url: string; line?: InvoiceLine } | null>(null);
  const [problem, setProblem] = useState(false);
  const [sealed, setSealed] = useState<{ amount: number; lines: number; seconds: number; next?: string } | null>(null);
  const started = useRef(Date.now());

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const d = await api.invoice(id);
      setInv(d);
      setStep(d.lockedTotalPaise === undefined ? "header" : d.lines.some((l) => l.status === "pending") ? "lines" : "seal");
    } catch (e) {
      setError(e);
    }
  }, [id]);
  useEffect(() => {
    started.current = Date.now();
    setLocal({});
    setHistory([]);
    setSealed(null);
    setInv(undefined);
    void load();
  }, [load]);

  const page0 = inv?.pages[0];
  const size = usePageSize(page0?.url, page0?.width, page0?.height);
  const lines = useMemo(() => (inv ? effectiveLines(inv.lines, local) : []), [inv, local]);
  const meter = useMemo(() => (inv ? meterState(inv, lines) : undefined), [inv, lines]);
  const storeName = stores.find((s) => s.id === inv?.storeId)?.name ?? "";

  const pageFor = useCallback(
    (l: InvoiceLine) => {
      const p = inv?.pages[l.box?.page ?? 0];
      if (!p) return undefined;
      const w = p.width ?? (p === page0 ? size?.w : undefined);
      const h = p.height ?? (p === page0 ? size?.h : undefined);
      return w && h ? { url: p.url, w, h } : undefined;
    },
    [inv, page0, size],
  );

  /** Apply a server response but keep local "pending" overrides from undo. */
  const take = (d: InvoiceDetail, clearIds: string[] = []) => {
    setInv(d);
    if (clearIds.length)
      setLocal((m) => {
        const n = { ...m };
        for (const k of clearIds) delete n[k];
        return n;
      });
  };

  const fail = (e: unknown) => toast(errorMessage(e), { kind: "bad" });
  /** Line changes go to the server one at a time, so responses can never arrive out of order. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.current.then(fn, fn);
    queue.current = p.catch(() => {});
    return p;
  };

  // ----------------------------------------------------------- line actions
  const accept = (l: InvoiceLine) => {
    setLocal((m) => ({ ...m, [l.id]: "accepted" }));
    setHistory((h) => [...h, { lineId: l.id, prev: "pending" }]);
    serial(() => api.updateLine(id, l.id, { action: "accept" }))
      .then((d) => {
        setInv(d);
        setLocal((m) => {
          if (m[l.id] !== "accepted") return m; // undone meanwhile: keep it on the deck
          const n = { ...m };
          delete n[l.id];
          return n;
        });
      })
      .catch((e) => {
        setLocal((m) => ({ ...m, [l.id]: "pending" }));
        fail(e);
      });
  };
  const saveEdit = async (l: InvoiceLine, input: LineInput) => {
    try {
      const d = await serial(() => api.updateLine(id, l.id, { action: "edit", line: input }));
      take(d, [l.id]);
      haptic(10);
      setHistory((h) => h.filter((x) => x.lineId !== l.id));
      toast(t("verify.lineSaved"));
    } catch (e) {
      fail(e);
      throw e;
    }
  };
  const remove = async (l: InvoiceLine) => {
    try {
      const d = await serial(() => api.updateLine(id, l.id, { action: "remove" }));
      take(d, [l.id]);
      setHistory((h) => h.filter((x) => x.lineId !== l.id));
      toast(t("verify.lineRemoved"), { kind: "info" });
    } catch (e) {
      fail(e);
      throw e;
    }
  };
  const add = async (input: LineInput) => {
    try {
      take(await serial(() => api.addLine(id, input)));
      toast(t("verify.lineAdded"));
    } catch (e) {
      fail(e);
      throw e;
    }
  };
  /** Undo puts the last accepted card back on the deck (it stays accepted on the server until swiped again). */
  const undo = () => {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    setLocal((m) => ({ ...m, [last.lineId]: "pending" }));
    haptic(6);
  };

  // ----------------------------------------------------------- seal
  const seal = async () => {
    if (!inv) return;
    try {
      const d = await serial(() => api.seal(id, Date.now() - started.current));
      setInv(d);
      invalidate("invoices", "dashboard", "payables");
      haptic([12, 60, 18]);
      const next = await api
        .invoices({ storeId: inv.storeId, state: "NEEDS_VERIFICATION", limit: 5 })
        .then((p) => p.items.find((x) => x.id !== id)?.id)
        .catch(() => undefined);
      setSealed({ amount: d.lockedTotalPaise ?? d.totals.grandTotalPaise, lines: d.lines.filter((l) => l.status !== "removed").length, seconds: Math.round((Date.now() - started.current) / 1000), next });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) void load();
      fail(e);
    }
  };

  // ----------------------------------------------------------- render
  if (error)
    return (
      <>
        <Header title={t("verify.title")} back="/" />
        <main className="mx-auto max-w-2xl px-4 pt-4">
          <ErrorState error={error} onRetry={() => void load()} />
        </main>
      </>
    );
  if (!inv || !meter)
    return (
      <>
        <Header title={t("verify.title")} back="/" />
        <main className="mx-auto max-w-2xl space-y-3 px-4 pt-4" aria-busy="true">
          <Skeleton className="h-56 w-full rounded-[16px]" />
          <ListSkeleton rows={3} />
        </main>
      </>
    );

  if (sealed)
    return (
      <Balanced
        amount={sealed.amount}
        lines={sealed.lines}
        seconds={sealed.seconds}
        hasNext={!!sealed.next}
        onNext={() => sealed.next && navigate(`/verify/${sealed.next}`, { replace: true })}
        onHome={() => navigate("/")}
      />
    );

  if (inv.state !== "NEEDS_VERIFICATION")
    return (
      <>
        <Header title={inv.header.vendorName ?? t("verify.title")} back="/" />
        <main className="mx-auto max-w-2xl px-4 pt-6 text-center">
          <StateBadge state={inv.state} />
          <p className="mt-3 text-body text-muted">{t("verify.notWaiting")}</p>
          <button type="button" className="btn btn-primary mt-4" onClick={() => navigate("/")}>
            {t("common.goHome")}
          </button>
        </main>
      </>
    );

  const stepIdx = STEPS.indexOf(step);
  const locked = inv.lockedTotalPaise !== undefined;
  return (
    <div className="min-h-dvh">
      <Header
        title={inv.header.vendorName ?? t("verify.title")}
        sub={[storeName, inv.header.invoiceNo].filter(Boolean).join(" · ")}
        back="/"
        right={<StepDots idx={stepIdx} onPick={(i) => (i === 0 || (locked && i >= 2)) && setStep(STEPS[i]!)} locked={locked} />}
      />
      {(step === "lines" || step === "seal") && <BalanceMeter m={meter} />}

      {step === "header" && (
        <HeaderStep
          inv={inv}
          storeName={storeName}
          onZoom={() => page0 && setZoom({ url: page0.url })}
          onProblem={() => setProblem(true)}
          onConfirm={async (changes) => {
            try {
              if (Object.keys(changes).length) setInv(await api.updateHeader(id, changes));
              setStep(locked ? "lines" : "total");
            } catch (e) {
              fail(e);
            }
          }}
        />
      )}
      {step === "total" && (
        <TotalStep
          onLock={async (paise) => {
            try {
              const r = await api.lockTotal(id, paise);
              setInv(r.invoice);
              if (r.invoice.lockedTotalPaise !== undefined) {
                haptic(r.match ? 12 : [20, 40, 20]);
                toast(r.match ? t("total.locked") : t("total.trusted"), { kind: r.match ? "ok" : "info" });
                setStep("lines");
              }
              return r;
            } catch (e) {
              fail(e);
              throw e;
            }
          }}
        />
      )}
      {step === "lines" && (
        <LinesStep
          lines={lines}
          meter={meter}
          pageFor={pageFor}
          canUndo={history.length > 0}
          onAccept={accept}
          onSaveEdit={saveEdit}
          onRemove={remove}
          onAdd={add}
          onUndo={undo}
          onZoom={(l) => {
            const p = pageFor(l);
            if (p) setZoom({ url: p.url, line: l });
          }}
          onContinue={() => setStep("seal")}
        />
      )}
      {step === "seal" && <SealStep inv={inv} meter={meter} onSeal={seal} onBackToLines={() => setStep("lines")} />}

      {zoom && <PageViewer url={zoom.url} highlight={zoom.line?.box} onClose={() => setZoom(null)} />}
      <ProblemSheet open={problem} onClose={() => setProblem(false)} id={id} onDone={() => navigate("/")} />
    </div>
  );
}

function StepDots({ idx, onPick, locked }: { idx: number; onPick: (i: number) => void; locked: boolean }) {
  const { t } = useI18n();
  const labels = [t("step.details"), t("step.total"), t("step.lines"), t("step.seal")];
  return (
    <ol className="mr-2 flex items-center gap-1.5" aria-label={t("step.label", { n: idx + 1, total: 4 })}>
      {labels.map((l, i) => (
        <li key={l}>
          <button
            type="button"
            onClick={() => onPick(i)}
            disabled={!(i === 0 || (locked && i >= 2))}
            aria-label={l}
            aria-current={i === idx ? "step" : undefined}
            className="flex h-8 items-center justify-center"
          >
            <span className={`block h-2 rounded-full transition-[width,background-color] duration-200 ${i === idx ? "w-6 bg-brand" : i < idx ? "w-2 bg-brand/50" : "w-2 bg-line"}`} />
          </button>
        </li>
      ))}
    </ol>
  );
}

function ProblemSheet({ open, onClose, id, onDone }: { open: boolean; onClose: () => void; id: string; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"hold" | "reject" | null>(null);
  const act = async (kind: "hold" | "reject") => {
    if (!reason.trim()) return toast(t("problem.needReason"), { kind: "info" });
    setBusy(kind);
    try {
      await (kind === "hold" ? api.hold(id, reason.trim()) : api.reject(id, reason.trim()));
      invalidate("invoices", "dashboard");
      toast(kind === "hold" ? t("problem.held") : t("problem.rejected"), { kind: "info" });
      onDone();
    } catch (e) {
      toast(errorMessage(e), { kind: "bad" });
    } finally {
      setBusy(null);
    }
  };
  const quick = [t("problem.notOurs"), t("problem.unreadable"), t("problem.shortSupply"), t("problem.duplicate")];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("problem.title")}
      footer={
        <div className="flex gap-2">
          <button type="button" className="btn btn-secondary flex-1" onClick={() => void act("hold")} disabled={!!busy}>
            {busy === "hold" && <Spinner />} {t("problem.hold")}
          </button>
          <button type="button" className="btn btn-danger flex-1" onClick={() => void act("reject")} disabled={!!busy}>
            {busy === "reject" && <Spinner />} {t("problem.reject")}
          </button>
        </div>
      }
    >
      <p className="mb-3 text-body text-muted">{t("problem.text")}</p>
      <div className="mb-3 flex flex-wrap gap-2">
        {quick.map((q) => (
          <button key={q} type="button" className="chip" aria-pressed={reason === q} onClick={() => setReason(q)}>
            {q}
          </button>
        ))}
      </div>
      <label className="label" htmlFor="problem-reason">
        {t("problem.reason")}
      </label>
      <textarea id="problem-reason" className="input min-h-24" value={reason} onChange={(e) => setReason(e.target.value)} />
    </Sheet>
  );
}

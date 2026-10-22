import type { PayableVendor } from "@arad/core";
import { Ban, Check, ChevronDown, History, ListChecks, Minus, Send, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { api, errorMessage } from "../../api/client";
import { useToast } from "../../components/toast";
import { Amount, BottomBar, EmptyState, ErrorState, Header, ICON, ListSkeleton, Page, Sheet, Spinner } from "../../components/ui";
import { useI18n, type MessageKey } from "../../i18n";
import { daysFromToday, fmtDate, todayIso } from "../../lib/format";
import { invalidate, useResource } from "../../lib/resource";

type Due = "overdue" | "today" | "week" | "all";
const DUES: { v: Due; key: MessageKey }[] = [
  { v: "overdue", key: "pay.overdue" },
  { v: "today", key: "pay.today" },
  { v: "week", key: "pay.week" },
  { v: "all", key: "pay.all" },
];

function Checkbox({ state, disabled }: { state: "all" | "some" | "none"; disabled?: boolean }) {
  return (
    <span
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border-2 transition-colors ${disabled ? "border-line bg-surface-2" : state === "none" ? "border-muted/60" : "border-brand bg-brand text-brand-ink"}`}
      aria-hidden
    >
      {state === "all" && <Check size={16} strokeWidth={3} />}
      {state === "some" && <Minus size={16} strokeWidth={3} />}
    </span>
  );
}

export default function Pay() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [, navigate] = useLocation();
  const [due, setDue] = useState<Due>("week");
  const res = useResource(`payables:${due}`, () => api.payables(due));
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [prep, setPrep] = useState(false);
  const [valueDate, setValueDate] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const vendors = res.data?.vendors ?? [];

  const eligible = useMemo(() => vendors.filter((v) => v.bankReady && v.totalPaise > 0), [vendors]);
  const billsOf = (v: PayableVendor) => v.bills.map((b) => b.invoiceId);
  const stateOf = (v: PayableVendor) => {
    const n = v.bills.filter((b) => sel.has(b.invoiceId)).length;
    return n === 0 ? "none" : n === v.bills.length ? "all" : "some";
  };
  const toggleVendor = (v: PayableVendor) => {
    if (!v.bankReady) return;
    setSel((s) => {
      const n = new Set(s);
      const all = stateOf(v) === "all";
      for (const id of billsOf(v)) all ? n.delete(id) : n.add(id);
      return n;
    });
  };
  const toggleBill = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const allSelected = eligible.length > 0 && eligible.every((v) => stateOf(v) === "all");
  const selectAll = () => setSel(allSelected ? new Set() : new Set(eligible.flatMap(billsOf)));

  const picked = vendors
    .map((v) => ({ v, bills: v.bills.filter((b) => sel.has(b.invoiceId)) }))
    .filter((x) => x.bills.length);
  const total = picked.reduce((s, x) => s + x.bills.reduce((a, b) => a + b.amountPaise, 0), 0);
  const billCount = picked.reduce((s, x) => s + x.bills.length, 0);

  async function prepare() {
    setBusy(true);
    try {
      const run = await api.createRun([...sel], valueDate);
      invalidate("payables", "dashboard", "runs", "invoices", "vendors");
      setSel(new Set());
      navigate(`/runs/${run.id}`);
    } catch (e) {
      toast(errorMessage(e), { kind: "bad" });
      setBusy(false);
    }
  }

  return (
    <>
      <Header
        title={t("pay.title")}
        right={
          <button type="button" className="icon-btn text-brand" onClick={() => navigate("/runs")} aria-label={t("runs.title")}>
            <History {...ICON} />
          </button>
        }
      />
      <Page className={billCount ? "pb-56" : ""}>
        <div className="no-scrollbar -mx-4 mb-3 flex gap-2 overflow-x-auto px-4" role="tablist" aria-label={t("pay.dueFilter")}>
          {DUES.map((d) => (
            <button
              key={d.v}
              type="button"
              role="tab"
              className="chip"
              aria-selected={due === d.v}
              onClick={() => {
                setDue(d.v);
                setSel(new Set());
              }}
            >
              {t(d.key)}
            </button>
          ))}
        </div>

        {res.error && !res.data ? (
          <ErrorState error={res.error} onRetry={res.reload} />
        ) : !res.data ? (
          <ListSkeleton rows={5} />
        ) : vendors.length === 0 ? (
          <EmptyState icon={Wallet} title={t("pay.empty")} text={t("pay.emptyText")} />
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between gap-3 px-1">
              <p className="text-body text-muted">
                {t("pay.summary", { n: vendors.length })} · <Amount paise={res.data.totalPaise} strong className="text-text" />
              </p>
              <button type="button" className="btn btn-ghost min-h-10 shrink-0 px-2 text-body" onClick={selectAll} disabled={!eligible.length}>
                <ListChecks size={18} strokeWidth={1.75} />
                {allSelected ? t("pay.clear") : t("pay.selectAll")}
              </button>
            </div>
            <div className="space-y-2">
              {vendors.map((v) => {
                const st = stateOf(v);
                const isOpen = open.has(v.vendorId);
                const stores = new Set(v.bills.map((b) => b.storeName));
                const byStore = [...stores].map((s) => ({ s, bills: v.bills.filter((b) => b.storeName === s) }));
                const firstDue = v.bills[0]!.dueDate;
                const late = daysFromToday(firstDue) < 0;
                return (
                  <div key={v.vendorId} className={`card overflow-hidden ${st !== "none" ? "border-brand/50" : ""}`}>
                    <div className="flex items-stretch">
                      <button
                        type="button"
                        onClick={() => toggleVendor(v)}
                        disabled={!v.bankReady}
                        className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 text-left disabled:cursor-not-allowed"
                        role="checkbox"
                        aria-checked={st === "all" ? true : st === "some" ? "mixed" : false}
                        aria-label={v.vendorName}
                      >
                        <Checkbox state={st} disabled={!v.bankReady} />
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate font-semibold ${v.bankReady ? "" : "text-muted"}`}>{v.vendorName}</span>
                          <span className="block truncate text-cap text-muted">
                            {t("pay.bills", { n: v.bills.length })}
                            {stores.size > 1 ? ` · ${t("pay.stores", { n: stores.size })}` : ` · ${[...stores][0]}`}
                            {" · "}
                            <span className={late ? "font-semibold text-bad" : ""}>{late ? t("pay.lateBy", { n: -daysFromToday(firstDue) }) : t("pay.dueOn", { date: fmtDate(firstDue, lang) })}</span>
                          </span>
                          {!v.bankReady && v.blockedReason && (
                            <span className="mt-1 flex items-center gap-1 text-cap font-semibold text-warn">
                              <Ban size={13} strokeWidth={2} className="shrink-0" />
                              <span className="truncate">{v.blockedReason}</span>
                            </span>
                          )}
                        </span>
                        <Amount paise={v.totalPaise} strong className={`text-body ${v.bankReady ? "" : "text-muted"}`} />
                      </button>
                      <button
                        type="button"
                        className="flex w-12 shrink-0 items-center justify-center text-muted"
                        onClick={() =>
                          setOpen((o) => {
                            const n = new Set(o);
                            n.has(v.vendorId) ? n.delete(v.vendorId) : n.add(v.vendorId);
                            return n;
                          })
                        }
                        aria-expanded={isOpen}
                        aria-label={t("pay.showBills", { name: v.vendorName })}
                      >
                        <ChevronDown size={20} strokeWidth={1.75} className={`transition-transform ${isOpen ? "rotate-180" : ""}`} />
                      </button>
                    </div>
                    {isOpen && (
                      <div className="anim-fade border-t border-line bg-surface-2/50">
                        {byStore.map(({ s, bills }) => (
                          <div key={s}>
                            <p className="px-4 pb-1 pt-2.5 text-cap font-semibold text-muted">{s}</p>
                            {bills.map((b) => (
                              <button
                                key={b.invoiceId}
                                type="button"
                                disabled={!v.bankReady}
                                onClick={() => toggleBill(b.invoiceId)}
                                role="checkbox"
                                aria-checked={sel.has(b.invoiceId)}
                                className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left disabled:cursor-not-allowed"
                              >
                                <Checkbox state={sel.has(b.invoiceId) ? "all" : "none"} disabled={!v.bankReady} />
                                <span className="min-w-0 flex-1">
                                  <span className="num block truncate text-body">
                                    {b.invoiceNo}
                                    {b.docType === "CRN" && <span className="ml-2 rounded-full bg-info-soft px-1.5 text-cap font-semibold text-info">{t("pay.creditNote")}</span>}
                                  </span>
                                  <span className={`block text-cap ${daysFromToday(b.dueDate) < 0 ? "text-bad" : "text-muted"}`}>{t("pay.dueOn", { date: fmtDate(b.dueDate, lang) })}</span>
                                </span>
                                <Amount paise={b.amountPaise} className="text-body" />
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Page>

      {billCount > 0 && (
        <BottomBar withTabs>
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-body text-muted">{t("pay.selected", { bills: billCount, vendors: picked.length })}</span>
            <Amount paise={total} strong className="text-title" />
          </div>
          <button type="button" className="btn btn-primary btn-block min-h-14" onClick={() => setPrep(true)}>
            <Send size={20} strokeWidth={1.75} /> {t("pay.prepare")}
          </button>
        </BottomBar>
      )}

      <Sheet
        open={prep}
        onClose={() => setPrep(false)}
        title={t("pay.prepareTitle")}
        footer={
          <button type="button" className="btn btn-primary btn-block min-h-14" onClick={() => void prepare()} disabled={busy || !valueDate}>
            {busy && <Spinner />} {t("pay.prepareConfirm")}
          </button>
        }
      >
        <p className="text-body text-muted">{t("pay.prepareText")}</p>
        <div className="card my-4 divide-y divide-line">
          <div className="flex justify-between px-4 py-3">
            <span className="text-muted">{t("pay.vendorsCount")}</span>
            <span className="num font-semibold">{picked.length}</span>
          </div>
          <div className="flex justify-between px-4 py-3">
            <span className="text-muted">{t("pay.billsCount")}</span>
            <span className="num font-semibold">{billCount}</span>
          </div>
          <div className="flex items-baseline justify-between px-4 py-3">
            <span className="text-muted">{t("pay.total")}</span>
            <Amount paise={total} strong className="text-title" />
          </div>
        </div>
        <label className="label" htmlFor="value-date">
          {t("pay.valueDate")}
        </label>
        <input id="value-date" type="date" className="input" value={valueDate} min={todayIso()} onChange={(e) => setValueDate(e.target.value)} />
      </Sheet>
    </>
  );
}

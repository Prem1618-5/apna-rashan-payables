import { formatBp, formatMilli } from "@arad/core";
import { CirclePause, CirclePlay, History, ScanSearch } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { api, errorMessage } from "../../api/client";
import { useSession } from "../../app/session";
import { useToast } from "../../components/toast";
import { Amount, ErrorState, Header, ICON, ListSkeleton, Page, Section, Sheet, Skeleton, Spinner, StateBadge } from "../../components/ui";
import { useI18n } from "../../i18n";
import { fmtDate, fmtDateTime } from "../../lib/format";
import { invalidate, useResource } from "../../lib/resource";
import { PageViewer } from "../verify/media";
import { ChecksList } from "../verify/SealStep";

export default function BillDetail({ id }: { id: string }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [, navigate] = useLocation();
  const { me, stores } = useSession();
  const res = useResource(`invoices:detail:${id}`, () => api.invoice(id));
  const audit = useResource(me?.role === "owner" ? `audit:invoice:${id}` : null, () => api.audit("invoice", id));
  const [zoom, setZoom] = useState<string>();
  const [holdOpen, setHoldOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const inv = res.data;

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      invalidate("invoices", "dashboard", "payables", "audit");
      toast(msg);
      setHoldOpen(false);
    } catch (e) {
      toast(errorMessage(e), { kind: "bad" });
    } finally {
      setBusy(false);
    }
  };

  if (res.error && !inv)
    return (
      <>
        <Header title={t("bill.title")} back />
        <Page>
          <ErrorState error={res.error} onRetry={res.reload} />
        </Page>
      </>
    );
  if (!inv)
    return (
      <>
        <Header title={t("bill.title")} back />
        <Page>
          <Skeleton className="mb-4 h-40 w-full rounded-[16px]" />
          <ListSkeleton rows={4} />
        </Page>
      </>
    );

  const store = stores.find((s) => s.id === inv.storeId);
  const t2 = inv.totals;
  const live = inv.lines.filter((l) => l.status !== "removed");
  return (
    <>
      <Header title={inv.header.vendorName ?? t("bill.title")} sub={[inv.header.invoiceNo, store?.name].filter(Boolean).join(" · ")} back />
      <Page>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <StateBadge state={inv.state} />
          {inv.dueDate && <span className="text-cap text-muted">{t("bill.due", { date: fmtDate(inv.dueDate, lang) })}</span>}
        </div>
        {inv.holdReason && <p className="mb-4 rounded-[12px] bg-warn-soft p-3 text-body text-warn">{inv.holdReason}</p>}

        {inv.pages.length > 0 && (
          <div className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4">
            {inv.pages.map((p, i) => (
              <button key={p.url} type="button" onClick={() => setZoom(p.url)} className="card h-44 w-32 shrink-0 overflow-hidden bg-surface-2" aria-label={t("capture.pageN", { n: i + 1 })}>
                <img src={p.url} alt="" className="h-full w-full object-cover object-top" loading="lazy" />
              </button>
            ))}
          </div>
        )}

        <div className="card divide-y divide-line">
          {[
            [t("header.gstin"), inv.header.sellerGstin],
            [t("header.date"), fmtDate(inv.header.invoiceDate, lang, { year: true })],
            [t("bill.capturedBy"), `${inv.capturedBy} · ${fmtDateTime(inv.createdAt, lang)}`],
            [t("bill.verifiedBy"), inv.verifiedBy ? `${inv.verifiedBy} · ${fmtDateTime(inv.verifiedAt, lang)}` : "–"],
          ].map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-3 px-4 py-3">
              <span className="text-body text-muted">{k}</span>
              <span className="num text-right text-body font-semibold">{v || "–"}</span>
            </div>
          ))}
        </div>

        {inv.state !== "NEEDS_VERIFICATION" && inv.state !== "EXTRACTING" && (
          <>
            <Section title={t("bill.lines")} count={live.length}>
              <div className="card divide-y divide-line overflow-hidden">
                {live.map((l) => (
                  <div key={l.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 flex-1 font-semibold">{l.description}</span>
                      <Amount paise={l.totalPaise} strong />
                    </div>
                    <p className="num mt-0.5 text-cap text-muted">
                      {formatMilli(l.qtyMilli)} {l.unit} × <Amount paise={l.ratePaise} />
                      {l.discountPaise ? (
                        <>
                          {" "}
                          − <Amount paise={l.discountPaise} />
                        </>
                      ) : null}{" "}
                      · GST {formatBp(l.gstRateBp)} {l.hsn ? `· HSN ${l.hsn}` : ""}
                    </p>
                  </div>
                ))}
              </div>
            </Section>
            <Section title={t("bill.totals")}>
              <div className="card divide-y divide-line">
                {(
                  [
                    [t("bill.taxable"), t2.taxablePaise],
                    t2.igstPaise ? [t("bill.igst"), t2.igstPaise] : [t("bill.cgstSgst"), t2.cgstPaise + t2.sgstPaise],
                    t2.otherChargesPaise ? [t("bill.other"), t2.otherChargesPaise] : null,
                    t2.discountPaise ? [t("bill.discount"), -t2.discountPaise] : null,
                    [t("bill.roundOff"), t2.roundOffPaise],
                  ].filter(Boolean) as [string, number][]
                ).map(([k, v]) => (
                  <div key={k} className="flex justify-between px-4 py-2.5 text-body">
                    <span className="text-muted">{k}</span>
                    <Amount paise={v} />
                  </div>
                ))}
                <div className="flex items-baseline justify-between px-4 py-3">
                  <span className="font-semibold">{t("bill.grandTotal")}</span>
                  <Amount paise={t2.grandTotalPaise} strong className="text-title" />
                </div>
              </div>
            </Section>
            <Section title={t("seal.checks")}>
              <ChecksList checks={inv.checks} />
            </Section>
          </>
        )}

        {audit.data && audit.data.length > 0 && (
          <Section title={t("bill.history")}>
            <ol className="card divide-y divide-line">
              {audit.data.map((a) => (
                <li key={a.id} className="flex items-start gap-3 px-4 py-3">
                  <History size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 text-body">
                    <span className="font-semibold">{a.actor}</span> · {a.action.replace(/_/g, " ")}
                    <span className="block text-cap text-muted">{fmtDateTime(a.at, lang)}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        )}

        <div className="mt-6 grid gap-2">
          {inv.state === "NEEDS_VERIFICATION" && (
            <button type="button" className="btn btn-primary" onClick={() => navigate(`/verify/${inv.id}`)}>
              <ScanSearch {...ICON} /> {t("bill.verify")}
            </button>
          )}
          {(inv.state === "VERIFIED" || inv.state === "NEEDS_VERIFICATION") && (
            <button type="button" className="btn btn-secondary" onClick={() => setHoldOpen(true)} disabled={busy}>
              <CirclePause {...ICON} /> {t("bill.hold")}
            </button>
          )}
          {inv.state === "ON_HOLD" && (
            <button type="button" className="btn btn-secondary" onClick={() => void act(async () => res.mutate(await api.unhold(inv.id)), t("bill.unheld"))} disabled={busy}>
              {busy ? <Spinner /> : <CirclePlay {...ICON} />} {t("bill.unhold")}
            </button>
          )}
        </div>
      </Page>
      {zoom && <PageViewer url={zoom} onClose={() => setZoom(undefined)} />}
      <Sheet
        open={holdOpen}
        onClose={() => setHoldOpen(false)}
        title={t("bill.hold")}
        footer={
          <button type="button" className="btn btn-primary btn-block" disabled={!reason.trim() || busy} onClick={() => void act(async () => res.mutate(await api.hold(inv.id, reason.trim())), t("problem.held"))}>
            {busy && <Spinner />} {t("bill.hold")}
          </button>
        }
      >
        <label className="label" htmlFor="hold-reason">
          {t("problem.reason")}
        </label>
        <textarea id="hold-reason" className="input min-h-24" value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />
      </Sheet>
    </>
  );
}

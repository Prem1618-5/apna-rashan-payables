import type { PaymentRunDetail, PaymentRunItem } from "@arad/core";
import { CircleAlert, CircleCheck, Download, FileCheck2, FileSpreadsheet, KeyRound, LogIn, MonitorUp, Share2, ShieldCheck, Upload, Wallet, XCircle } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useToast } from "../../components/toast";
import { Amount, BottomBar, ErrorState, Header, ICON, ListSkeleton, Page, Section, Sheet, Spinner } from "../../components/ui";
import { useI18n } from "../../i18n";
import { fmtDate, fmtDateTime } from "../../lib/format";
import { canShareFiles, downloadText, isIosDevice, shareText } from "../../lib/download";
import { invalidate, useResource } from "../../lib/resource";
import { RunStateBadge, TxnBadge, WarningRow } from "./RunBits";

export default function RunDetail({ id }: { id: string }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const res = useResource(`runs:detail:${id}`, () => api.run(id));
  const [busy, setBusy] = useState<string | null>(null);
  const [paidSheet, setPaidSheet] = useState(false);
  const [failItem, setFailItem] = useState<PaymentRunItem | null>(null);
  const [cancelSheet, setCancelSheet] = useState(false);
  const r = res.data;

  const act = async (name: string, fn: () => Promise<PaymentRunDetail>, msg?: string) => {
    setBusy(name);
    try {
      res.mutate(await fn());
      invalidate("runs", "dashboard", "payables", "invoices", "vendors");
      if (msg) toast(msg);
      return true;
    } catch (e) {
      toast(errorMessage(e), { kind: "bad" });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const download = async (share = false) => {
    if (!r) return;
    setBusy(share ? "share" : "download");
    try {
      const f = await api.runFile(r.id);
      const name = r.file?.name ?? f.fileName ?? `${r.ref}.txt`;
      if (share) {
        if (!(await shareText(name, f.text, name))) downloadText(name, f.text);
      } else downloadText(name, f.text);
      toast(t("file.downloaded", { name }));
    } catch (e) {
      toast(errorMessage(e), { kind: "bad" });
    } finally {
      setBusy(null);
    }
  };
  const advice = async () => {
    if (!r) return;
    try {
      const f = await api.adviceCsv(r.id);
      downloadText(f.fileName ?? `${r.ref}-advice.csv`, f.text);
    } catch (e) {
      toast(errorMessage(e), { kind: "bad" });
    }
  };

  if (res.error && !r)
    return (
      <>
        <Header title={t("run.title")} back="/runs" />
        <Page>
          <ErrorState error={res.error} onRetry={res.reload} />
        </Page>
      </>
    );
  if (!r)
    return (
      <>
        <Header title={t("run.title")} back="/runs" />
        <Page>
          <ListSkeleton rows={4} />
        </Page>
      </>
    );

  const blocks = r.warnings.filter((w) => w.level === "block");
  const draft = r.state === "DRAFT";

  return (
    <>
      <Header title={draft ? t("run.reviewTitle") : r.file ? t("file.title") : t("run.title")} sub={`${r.ref} · ${fmtDate(r.valueDate, lang)}`} back="/runs" right={<span className="mr-2"><RunStateBadge state={r.state} /></span>} />
      <Page className="pb-40">
        {/* ---------------- file ready */}
        {r.file && (
          <>
            <div className="card mb-4 overflow-hidden">
              <div className="flex items-center gap-3 bg-brand-soft px-4 py-3 text-brand">
                <FileCheck2 size={22} strokeWidth={1.75} />
                <span className="font-semibold">{t("file.ready")}</span>
              </div>
              <div className="p-4">
                <p className="text-cap text-muted">{t("file.name")}</p>
                <p className="num select-all break-all text-h1 font-semibold" data-testid="file-name">
                  {r.file.name}
                </p>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="rounded-[12px] bg-surface-2 p-3">
                    <p className="text-cap text-muted">{t("file.count")}</p>
                    <p className="num text-h1 font-semibold" data-testid="control-count">
                      {r.file.control.count}
                    </p>
                  </div>
                  <div className="rounded-[12px] bg-surface-2 p-3">
                    <p className="text-cap text-muted">{t("file.total")}</p>
                    <p className="num text-lead font-semibold leading-8" data-testid="control-total">
                      ₹{r.file.control.total}
                    </p>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  {(["N", "R", "I"] as const).map((k) => (
                    <div key={k} className="rounded-[10px] border border-line px-2 py-2">
                      <p className="text-cap text-muted">{t(k === "N" ? "txn.N" : k === "R" ? "txn.R" : "txn.I")}</p>
                      <p className="num text-body font-semibold">{r.file!.control.byType[k].count}</p>
                      <p className="num text-cap text-muted">
                        <Amount paise={r.file!.control.byType[k].totalPaise} />
                      </p>
                    </div>
                  ))}
                </div>
                <p className="num mt-3 break-all text-[11px] leading-4 text-muted">SHA-256 {r.file.sha256}</p>
              </div>
              <div className="grid gap-2 border-t border-line p-4">
                <button type="button" className="btn btn-primary btn-block min-h-14" onClick={() => void download(false)} disabled={!!busy} data-testid="download-file">
                  {busy === "download" ? <Spinner /> : <Download {...ICON} />} {t("file.download")}
                </button>
                {isIosDevice() && canShareFiles() && (
                  <button type="button" className="btn btn-secondary btn-block" onClick={() => void download(true)} disabled={!!busy}>
                    {busy === "share" ? <Spinner /> : <Share2 {...ICON} />} {t("file.share")}
                  </button>
                )}
              </div>
            </div>

            {(r.state === "APPROVED" || r.state === "UPLOADED") && (
              <Section title={t("file.stepsTitle")}>
                <ol className="card divide-y divide-line">
                  {[
                    { icon: LogIn, key: "file.step1" as const },
                    { icon: Upload, key: "file.step2" as const },
                    { icon: MonitorUp, key: "file.step3" as const },
                    { icon: ShieldCheck, key: "file.step4" as const, params: { count: r.file.control.count, total: r.file.control.total } },
                    { icon: KeyRound, key: "file.step5" as const },
                  ].map((s, i) => (
                    <li key={s.key} className="flex items-start gap-3 px-4 py-3">
                      <span className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-cap font-semibold text-brand-ink">{i + 1}</span>
                      <span className="min-w-0 flex-1 pt-0.5 text-body">
                        {t(s.key, s.params)}
                      </span>
                      <s.icon size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted" />
                    </li>
                  ))}
                </ol>
                <p className="mt-2 flex items-start gap-2 rounded-[12px] bg-bad-soft p-3 text-body font-semibold text-bad">
                  <CircleAlert size={18} strokeWidth={2} className="mt-0.5 shrink-0" />
                  {t("file.mismatchWarn")}
                </p>
              </Section>
            )}
          </>
        )}

        {/* ---------------- review warnings */}
        {draft && (
          <>
            <div className="card mb-4 p-4">
              <p className="text-body text-muted">{t("run.total")}</p>
              <p className="text-amount font-semibold">
                <Amount paise={r.totalPaise} />
              </p>
              <p className="text-body text-muted">{t("run.toVendors", { n: r.count, date: fmtDate(r.valueDate, lang) })}</p>
              <p className="mt-1 text-cap text-muted">{t("run.preparedBy", { name: r.preparedBy, at: fmtDateTime(r.createdAt, lang) })}</p>
            </div>
            {r.warnings.length > 0 && (
              <Section title={t("run.warnings")} count={r.warnings.length}>
                <ul className="space-y-2">
                  {r.warnings.map((w, i) => (
                    <WarningRow key={i} w={w} />
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}

        <Section title={t("run.payments")} count={r.items.length}>
          <div className="card divide-y divide-line overflow-hidden">
            {r.items.map((it) => (
              <div key={it.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{it.vendorName}</p>
                    <p className="num truncate text-cap text-muted">
                      {it.accountMasked} · {it.ifsc}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Amount paise={it.amountPaise} strong />
                    <TxnBadge type={it.txnType} />
                  </div>
                </div>
                <p className="mt-1 truncate text-cap text-muted">
                  {it.bills.map((b) => `${b.invoiceNo} (${b.storeName})`).join(", ")}
                </p>
                {(it.state !== "PENDING" || it.utr) && (
                  <p className={`mt-1 flex items-center gap-1 text-cap font-semibold ${it.state === "FAILED" ? "text-bad" : "text-ok"}`}>
                    {it.state === "FAILED" ? <XCircle size={14} strokeWidth={2} /> : <CircleCheck size={14} strokeWidth={2} />}
                    {it.state === "FAILED" ? `${t("run.failed")}: ${it.failReason ?? ""}` : `${t("run.paid")}${it.utr ? ` · UTR ${it.utr}` : ""}`}
                  </p>
                )}
                {(r.state === "UPLOADED" || r.state === "PAID" || r.state === "APPROVED") && it.state !== "FAILED" && (
                  <button type="button" className="mt-1 text-cap font-semibold text-bad underline-offset-2 hover:underline" onClick={() => setFailItem(it)}>
                    {t("run.markFailed")}
                  </button>
                )}
              </div>
            ))}
          </div>
        </Section>

        {r.file && (
          <button type="button" className="btn btn-ghost mt-4 w-full" onClick={() => void advice()}>
            <FileSpreadsheet {...ICON} /> {t("file.advice")}
          </button>
        )}
        {(r.state === "DRAFT" || r.state === "APPROVED") && (
          <button type="button" className="btn btn-ghost mt-2 w-full text-bad" onClick={() => setCancelSheet(true)}>
            {t("run.cancel")}
          </button>
        )}
      </Page>

      {draft && (
        <BottomBar>
          {blocks.length > 0 && <p className="mb-2 text-cap font-semibold text-bad">{t("run.blocked", { n: blocks.length })}</p>}
          <button type="button" className="btn btn-primary btn-block min-h-14" disabled={blocks.length > 0 || !!busy} onClick={() => void act("approve", () => api.approveRun(r.id), t("run.approvedToast"))} data-testid="approve-run">
            {busy === "approve" ? <Spinner /> : <ShieldCheck size={22} strokeWidth={1.75} />}
            {t("run.approve", { amount: "" })}
            <Amount paise={r.totalPaise} />
          </button>
        </BottomBar>
      )}
      {r.state === "APPROVED" && (
        <BottomBar>
          <button type="button" className="btn btn-primary btn-block min-h-14" disabled={!!busy} onClick={() => void act("uploaded", () => api.markUploaded(r.id), t("run.uploadedToast"))}>
            {busy === "uploaded" ? <Spinner /> : <Upload size={20} strokeWidth={1.75} />} {t("run.markUploaded")}
          </button>
        </BottomBar>
      )}
      {r.state === "UPLOADED" && (
        <BottomBar>
          <button type="button" className="btn btn-primary btn-block min-h-14" disabled={!!busy} onClick={() => setPaidSheet(true)}>
            <Wallet size={20} strokeWidth={1.75} /> {t("run.markPaid")}
          </button>
        </BottomBar>
      )}

      <PaidSheet open={paidSheet} run={r} onClose={() => setPaidSheet(false)} busy={busy === "paid"} onSubmit={async (utrs) => (await act("paid", () => api.markPaid(r.id, utrs), t("run.paidToast"))) && setPaidSheet(false)} />
      <FailSheet item={failItem} onClose={() => setFailItem(null)} busy={busy === "fail"} onSubmit={async (reason) => failItem && (await act("fail", () => api.markFailed(r.id, failItem.id, reason), t("run.failedToast"))) && setFailItem(null)} />
      <Sheet
        open={cancelSheet}
        onClose={() => setCancelSheet(false)}
        title={t("run.cancelTitle")}
        footer={
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary flex-1" onClick={() => setCancelSheet(false)}>
              {t("common.back")}
            </button>
            <button type="button" className="btn btn-danger flex-1" disabled={!!busy} onClick={async () => (await act("cancel", () => api.cancelRun(r.id), t("run.cancelledToast"))) && setCancelSheet(false)}>
              {t("run.cancel")}
            </button>
          </div>
        }
      >
        <p className="text-body text-muted">{t("run.cancelText")}</p>
      </Sheet>
    </>
  );
}

function PaidSheet({ open, run, onClose, onSubmit, busy }: { open: boolean; run: PaymentRunDetail; onClose: () => void; onSubmit: (utrs: Record<string, string>) => void; busy: boolean }) {
  const t = useT2();
  const [utrs, setUtrs] = useState<Record<string, string>>({});
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("run.markPaid")}
      footer={
        <button type="button" className="btn btn-primary btn-block min-h-14" disabled={busy} onClick={() => onSubmit(Object.fromEntries(Object.entries(utrs).filter(([, v]) => v.trim())))}>
          {busy && <Spinner />} {t("run.confirmPaid")}
        </button>
      }
    >
      <p className="mb-4 text-body text-muted">{t("run.paidText")}</p>
      {run.items
        .filter((i) => i.state === "PENDING")
        .map((it) => (
          <div key={it.id} className="mb-3">
            <label className="label" htmlFor={`utr-${it.id}`}>
              {it.vendorName} · <Amount paise={it.amountPaise} />
            </label>
            <input id={`utr-${it.id}`} className="input num uppercase" placeholder={t("run.utrPlaceholder")} value={utrs[it.id] ?? ""} onChange={(e) => setUtrs((u) => ({ ...u, [it.id]: e.target.value }))} autoCapitalize="characters" autoComplete="off" />
          </div>
        ))}
    </Sheet>
  );
}

function FailSheet({ item, onClose, onSubmit, busy }: { item: PaymentRunItem | null; onClose: () => void; onSubmit: (reason: string) => void; busy: boolean }) {
  const t = useT2();
  const [reason, setReason] = useState("");
  const quick = [t("run.failWrongAccount"), t("run.failRejected"), t("run.failReturned")];
  return (
    <Sheet
      open={!!item}
      onClose={onClose}
      title={t("run.failTitle", { name: item?.vendorName ?? "" })}
      footer={
        <button type="button" className="btn btn-danger btn-block min-h-14" disabled={busy || !reason.trim()} onClick={() => onSubmit(reason.trim())}>
          {busy && <Spinner />} {t("run.markFailed")}
        </button>
      }
    >
      <p className="mb-3 text-body text-muted">{t("run.failText")}</p>
      <div className="mb-3 flex flex-wrap gap-2">
        {quick.map((q) => (
          <button key={q} type="button" className="chip" aria-pressed={reason === q} onClick={() => setReason(q)}>
            {q}
          </button>
        ))}
      </div>
      <label className="label" htmlFor="fail-reason">
        {t("problem.reason")}
      </label>
      <input id="fail-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
    </Sheet>
  );
}

function useT2() {
  return useI18n().t;
}

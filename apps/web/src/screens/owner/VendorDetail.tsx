import type { BankVersion } from "@arad/core";
import { Clock3, Landmark, PencilLine, PhoneCall, ShieldAlert, ShieldCheck, UserCheck } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { api, errorMessage } from "../../api/client";
import { useSession } from "../../app/session";
import { useToast } from "../../components/toast";
import { Amount, Badge, ErrorState, Header, ICON, ListSkeleton, Page, Section, Sheet, Spinner } from "../../components/ui";
import { useI18n } from "../../i18n";
import { fmtDateTime } from "../../lib/format";
import { invalidate, useResource } from "../../lib/resource";

export default function VendorDetail({ id }: { id: string }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [, navigate] = useLocation();
  const { me } = useSession();
  const owner = me?.role === "owner";
  const res = useResource(`vendors:detail:${id}`, () => api.vendor(id));
  const settings = useResource(owner ? "settings" : null, () => api.settings(), { staleMs: 300_000 });
  const [confirm, setConfirm] = useState<BankVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const v = res.data;

  const run = async (fn: () => Promise<Awaited<ReturnType<typeof api.vendor>>>, msg: string) => {
    setBusy(true);
    try {
      res.mutate(await fn());
      invalidate("vendors:list", "dashboard", "payables");
      toast(msg);
      setConfirm(null);
    } catch (e) {
      toast(errorMessage(e), { kind: "bad" });
    } finally {
      setBusy(false);
    }
  };

  if (res.error && !v)
    return (
      <>
        <Header title={t("vendor.title")} back="/vendors" />
        <Page>
          <ErrorState error={res.error} onRetry={res.reload} />
        </Page>
      </>
    );
  if (!v)
    return (
      <>
        <Header title={t("vendor.title")} back="/vendors" />
        <Page>
          <ListSkeleton rows={4} />
        </Page>
      </>
    );

  const pending = v.bankVersions.find((b) => b.status === "PENDING");
  const current = v.bankVersions.find((b) => b.status === "APPROVED");
  const older = v.bankVersions.filter((b) => b !== pending && b !== current);
  const hours = settings.data?.coolingOffHours ?? 24;

  return (
    <>
      <Header
        title={v.name}
        sub={v.gstin}
        back="/vendors"
        right={
          <button type="button" className="icon-btn text-brand" onClick={() => navigate(`/vendors/${v.id}/edit`)} aria-label={t("vendor.edit")}>
            <PencilLine {...ICON} />
          </button>
        }
      />
      <Page>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Badge tone={v.status === "ACTIVE" ? "ok" : v.status === "PENDING" ? "info" : "bad"}>{t(v.status === "ACTIVE" ? "vendors.statusActive" : v.status === "PENDING" ? "vendors.statusPending" : "vendors.statusBlocked")}</Badge>
          {v.owedPaise !== 0 && (
            <span className="text-body text-muted">
              {t("vendor.owed")} <Amount paise={v.owedPaise} strong className="text-text" />
            </span>
          )}
        </div>

        {v.status === "PENDING" && owner && (
          <div className="card mb-4 p-4">
            <p className="font-semibold">{t("vendor.newTitle")}</p>
            <p className="mt-1 text-body text-muted">{t("vendor.newText")}</p>
            <button type="button" className="btn btn-primary btn-block mt-3" disabled={busy} onClick={() => void run(() => api.approveVendor(v.id), t("vendor.approved"))}>
              {busy ? <Spinner /> : <UserCheck {...ICON} />} {t("vendor.approve")}
            </button>
          </div>
        )}

        <div className="card divide-y divide-line">
          {[
            [t("vendor.pan"), v.pan],
            [t("vendor.phone"), v.phone],
            [t("vendor.email"), v.email],
            [t("vendor.terms"), t("vendor.termsDays", { n: v.paymentTermsDays })],
          ].map(([k, val]) => (
            <div key={k} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-body text-muted">{k}</span>
              <span className="num truncate text-right text-body font-semibold">{val || "–"}</span>
            </div>
          ))}
        </div>

        <Section
          title={t("vendor.bank")}
          action={
            <button type="button" className="btn btn-ghost min-h-8 px-2 text-body" onClick={() => navigate(`/vendors/${v.id}/bank`)}>
              {current || pending ? t("vendor.changeBank") : t("vendor.addBank")}
            </button>
          }
        >
          {pending && (
            <div className="card mb-3 border-warn/50">
              <div className="flex items-center gap-2 rounded-t-[16px] bg-warn-soft px-4 py-2 text-cap font-semibold text-warn">
                <ShieldAlert size={16} strokeWidth={2} />
                {current ? t("vendor.changeWaiting") : t("vendor.bankWaiting")}
              </div>
              <BankCard b={pending} lang={lang} />
              {owner ? (
                <div className="border-t border-line p-4">
                  <button type="button" className="btn btn-primary btn-block" onClick={() => setConfirm(pending)}>
                    <ShieldCheck {...ICON} /> {t("vendor.approveBank")}
                  </button>
                  <p className="mt-2 text-cap text-muted">{t("vendor.coolingNote", { h: hours })}</p>
                </div>
              ) : (
                <p className="border-t border-line px-4 py-3 text-cap text-muted">{t("vendor.ownerWillApprove")}</p>
              )}
            </div>
          )}
          {current ? (
            <div className="card">
              <BankCard b={current} lang={lang} current />
            </div>
          ) : (
            !pending && (
              <div className="card p-4 text-center">
                <Landmark size={24} strokeWidth={1.75} className="mx-auto text-muted" />
                <p className="mt-2 font-semibold">{t("vendor.noBank")}</p>
                <p className="mt-1 text-body text-muted">{t("vendor.noBankText")}</p>
                <button type="button" className="btn btn-primary mt-3" onClick={() => navigate(`/vendors/${v.id}/bank`)}>
                  {t("vendor.addBank")}
                </button>
              </div>
            )
          )}
          {older.length > 0 && (
            <details className="card mt-3">
              <summary className="flex min-h-12 cursor-pointer items-center px-4 font-semibold">{t("vendor.history", { n: older.length })}</summary>
              <div className="divide-y divide-line border-t border-line">
                {older.map((b) => (
                  <BankCard key={b.id} b={b} lang={lang} />
                ))}
              </div>
            </details>
          )}
        </Section>
      </Page>

      <Sheet
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={t("vendor.approveBankTitle")}
        footer={
          <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => confirm && void run(() => api.approveBank(v.id, confirm.id), t("vendor.bankApproved"))}>
            {busy ? <Spinner /> : <ShieldCheck {...ICON} />} {t("vendor.approveBankConfirm")}
          </button>
        }
      >
        <div className="mb-4 flex items-start gap-3 rounded-[12px] bg-info-soft p-3 text-body">
          <PhoneCall size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-info" />
          <span>{t("vendor.callFirst", { name: v.name })}</span>
        </div>
        {confirm && (
          <div className="card mb-4">
            <BankCard b={confirm} lang={lang} />
          </div>
        )}
        <p className="flex items-start gap-2 text-body text-muted">
          <Clock3 size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" />
          {t("vendor.coolingExplain", { h: hours, until: fmtDateTime(new Date(Date.now() + hours * 3600_000).toISOString(), lang) })}
        </p>
      </Sheet>
    </>
  );
}

function BankCard({ b, lang, current = false }: { b: BankVersion; lang: "en" | "hi"; current?: boolean }) {
  const { t } = useI18n();
  const coolingUntil = b.usableFrom && Date.parse(b.usableFrom) > Date.now() ? b.usableFrom : undefined;
  const statusKey = b.status === "APPROVED" ? "bank.APPROVED" : b.status === "PENDING" ? "bank.PENDING" : b.status === "SUPERSEDED" ? "bank.SUPERSEDED" : "bank.REJECTED";
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="num text-lead font-semibold tracking-wide">{b.accountMasked}</span>
        <Badge tone={b.status === "APPROVED" ? "ok" : b.status === "PENDING" ? "warn" : "muted"}>
          {t(statusKey)} · v{b.version}
        </Badge>
      </div>
      <p className="num mt-1 text-body">
        {b.ifsc} {b.bankName ? `· ${b.bankName}` : ""} {b.branchName ? `· ${b.branchName}` : ""}
      </p>
      {b.beneCode && <p className="num text-cap text-muted">{t("bank.beneCode")}: {b.beneCode}</p>}
      <p className="mt-1 text-cap text-muted">
        {t("bank.addedBy", { name: b.createdBy, at: fmtDateTime(b.createdAt, lang) })}
        {b.approvedBy ? ` · ${t("bank.approvedBy", { name: b.approvedBy, at: fmtDateTime(b.approvedAt, lang) })}` : ""}
      </p>
      {current && coolingUntil && (
        <p className="mt-2 flex items-center gap-1.5 rounded-[10px] bg-warn-soft px-2 py-1.5 text-cap font-semibold text-warn">
          <Clock3 size={14} strokeWidth={2} />
          {t("bank.coolingUntil", { at: fmtDateTime(coolingUntil, lang) })}
        </p>
      )}
    </div>
  );
}

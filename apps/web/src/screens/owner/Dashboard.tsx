import type { PaymentRunSummary } from "@arad/core";
import { Banknote, Camera, ChevronRight, CircleAlert, FileCheck2, Landmark, ListChecks, Send, Store as StoreIcon, UserPlus } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useLocation } from "wouter";
import { api } from "../../api/client";
import { useSession } from "../../app/session";
import { Amount, Badge, ErrorState, ListSkeleton, Section, Skeleton } from "../../components/ui";
import { useI18n } from "../../i18n";
import { fmtDate } from "../../lib/format";
import { useResource } from "../../lib/resource";
import { RunStateBadge } from "./RunBits";

export default function Dashboard() {
  const { t, lang } = useI18n();
  const { me } = useSession();
  const [, navigate] = useLocation();
  const res = useResource("dashboard", () => api.dashboard(), { pollMs: 30_000 });
  const d = res.data;
  const draft = d?.recentRuns.find((r) => r.state === "DRAFT");
  const toCheck = d?.stores.reduce((s, x) => s + x.needsVerification, 0) ?? 0;
  const approvals = d ? d.pendingApprovals.vendors + d.pendingApprovals.bankChanges + d.pendingApprovals.runs : 0;

  return (
    <div className="pt-safe">
      <main className="mx-auto w-full max-w-2xl px-4 pb-28 pt-5">
        <div className="mb-5 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-body text-muted">{new Date().toLocaleDateString(lang === "hi" ? "hi-IN" : "en-IN", { weekday: "long", day: "numeric", month: "long" })}</p>
            <h1 className="truncate text-h1 font-semibold">{t("dash.hello", { name: me?.name.split(" ")[0] ?? "" })}</h1>
          </div>
        </div>

        {res.error && !d ? (
          <ErrorState error={res.error} onRetry={res.reload} />
        ) : (
          <>
            <div className="card p-4">
              <p className="text-body text-muted">{t("dash.owed")}</p>
              {d ? <p className="mt-0.5 text-amount font-semibold">{<Amount paise={d.owedPaise} />}</p> : <Skeleton className="mt-2 h-9 w-48" />}
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className={`rounded-[12px] p-3 ${d && d.overduePaise > 0 ? "bg-bad-soft" : "bg-surface-2"}`}>
                  <p className={`flex items-center gap-1 text-cap font-semibold ${d && d.overduePaise > 0 ? "text-bad" : "text-muted"}`}>
                    {d && d.overduePaise > 0 && <CircleAlert size={13} strokeWidth={2.25} />}
                    {t("dash.overdue")}
                  </p>
                  {d ? <p className="mt-0.5 text-lead font-semibold">{<Amount paise={d.overduePaise} />}</p> : <Skeleton className="mt-1 h-6 w-24" />}
                </div>
                <div className="rounded-[12px] bg-surface-2 p-3">
                  <p className="text-cap font-semibold text-muted">{t("dash.week")}</p>
                  {d ? <p className="mt-0.5 text-lead font-semibold">{<Amount paise={d.dueThisWeekPaise} />}</p> : <Skeleton className="mt-1 h-6 w-24" />}
                </div>
              </div>
              <button type="button" className="btn btn-primary btn-block mt-4" onClick={() => navigate("/pay")}>
                <Banknote size={20} strokeWidth={1.75} />
                {d ? t("dash.payVendors", { n: d.vendorsDue }) : t("tab.pay")}
              </button>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <QuickAction icon={Camera} label={t("home.photograph")} onClick={() => navigate("/capture")} />
              <QuickAction icon={ListChecks} label={t("dash.toCheck", { n: toCheck })} onClick={() => navigate("/home")} />
            </div>

            {d && approvals > 0 && (
              <Section title={t("dash.approvals")} count={approvals}>
                <div className="space-y-2">
                  {d.pendingApprovals.runs > 0 && (
                    <ActionCard icon={Send} tone="brand" title={t("dash.runsWaiting", { n: d.pendingApprovals.runs })} text={draft ? `${draft.ref} · ${t("dash.vendors", { n: draft.count })}` : undefined} right={draft ? <Amount paise={draft.totalPaise} strong /> : undefined} onClick={() => navigate(draft ? `/runs/${draft.id}` : "/runs")} />
                  )}
                  {d.pendingApprovals.bankChanges > 0 && <ActionCard icon={Landmark} tone="warn" title={t("dash.bankWaiting", { n: d.pendingApprovals.bankChanges })} text={t("dash.bankWaitingText")} onClick={() => navigate("/vendors?filter=bank")} />}
                  {d.pendingApprovals.vendors > 0 && <ActionCard icon={UserPlus} tone="info" title={t("dash.vendorsWaiting", { n: d.pendingApprovals.vendors })} onClick={() => navigate("/vendors?filter=PENDING")} />}
                </div>
              </Section>
            )}

            <Section title={t("dash.today")}>
              {!d ? (
                <ListSkeleton rows={3} />
              ) : (
                <div className="card divide-y divide-line overflow-hidden">
                  {d.stores.map((s) => (
                    <button key={s.storeId} type="button" onClick={() => navigate(`/bills?store=${s.storeId}`)} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
                        <StoreIcon size={18} strokeWidth={1.75} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{s.storeName}</span>
                        <span className="num block text-cap text-muted">{t("dash.storeLine", { captured: s.captured, verified: s.verified })}</span>
                      </span>
                      {s.needsVerification > 0 ? <Badge tone="warn">{t("dash.storeToCheck", { n: s.needsVerification })}</Badge> : <Badge tone="ok">{t("dash.storeClear")}</Badge>}
                    </button>
                  ))}
                </div>
              )}
            </Section>

            <Section
              title={t("dash.recentRuns")}
              action={
                <button type="button" className="btn btn-ghost min-h-8 px-2 text-body" onClick={() => navigate("/runs")}>
                  {t("common.seeAll")}
                </button>
              }
            >
              {!d ? <ListSkeleton rows={2} /> : d.recentRuns.length === 0 ? <p className="px-1 text-body text-muted">{t("runs.empty")}</p> : <RunList runs={d.recentRuns} lang={lang} />}
            </Section>
          </>
        )}
      </main>
    </div>
  );
}

export function RunList({ runs, lang }: { runs: PaymentRunSummary[]; lang: "en" | "hi" }) {
  const { t } = useI18n();
  const [, navigate] = useLocation();
  return (
    <div className="card divide-y divide-line overflow-hidden">
      {runs.map((r) => (
        <button key={r.id} type="button" onClick={() => navigate(`/runs/${r.id}`)} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
            <FileCheck2 size={18} strokeWidth={1.75} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="num block truncate font-semibold">{r.ref}</span>
            <span className="block truncate text-cap text-muted">
              {fmtDate(r.valueDate, lang)} · {t("dash.vendors", { n: r.count })}
            </span>
          </span>
          <span className="flex flex-col items-end gap-1">
            <Amount paise={r.totalPaise} strong className="text-body" />
            <RunStateBadge state={r.state} />
          </span>
        </button>
      ))}
    </div>
  );
}

function QuickAction({ icon: Icon, label, onClick }: { icon: ComponentType<{ size?: number; strokeWidth?: number }>; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="card flex min-h-14 items-center gap-2 px-3 py-3 text-left font-semibold active:bg-surface-2">
      <span className="text-brand">
        <Icon size={20} strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1 leading-5">{label}</span>
    </button>
  );
}

function ActionCard({ icon: Icon, tone, title, text, right, onClick }: { icon: ComponentType<{ size?: number; strokeWidth?: number }>; tone: "brand" | "warn" | "info"; title: string; text?: string; right?: ReactNode; onClick: () => void }) {
  const toneCls = tone === "brand" ? "bg-brand-soft text-brand" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-info-soft text-info";
  return (
    <button type="button" onClick={onClick} className="card flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${toneCls}`}>
        <Icon size={20} strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{title}</span>
        {text && <span className="block truncate text-cap text-muted">{text}</span>}
      </span>
      {right}
      <ChevronRight size={18} strokeWidth={1.75} className="text-muted" />
    </button>
  );
}

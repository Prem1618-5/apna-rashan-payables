import type { VendorSummary } from "@arad/core";
import { Landmark, Plus, Search, SearchX, Store as StoreIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { api } from "../../api/client";
import { Amount, Badge, EmptyState, ErrorState, Header, ListSkeleton, Page } from "../../components/ui";
import { useT, type MessageKey } from "../../i18n";
import { useResource } from "../../lib/resource";

type Filter = "" | "PENDING" | "bank" | "nobank" | "BLOCKED";
const FILTERS: { v: Filter; key: MessageKey }[] = [
  { v: "", key: "vendors.all" },
  { v: "PENDING", key: "vendors.new" },
  { v: "bank", key: "vendors.bankPending" },
  { v: "nobank", key: "vendors.noBank" },
  { v: "BLOCKED", key: "vendors.blocked" },
];

export function BankBadge({ v }: { v: Pick<VendorSummary, "bankStatus" | "accountMasked"> }) {
  const t = useT();
  if (v.bankStatus === "APPROVED")
    return (
      <Badge tone="ok" icon={Landmark}>
        <span className="num">{v.accountMasked?.slice(-8)}</span>
      </Badge>
    );
  if (v.bankStatus === "PENDING") return <Badge tone="warn">{t("vendors.bankPendingShort")}</Badge>;
  return <Badge tone="muted">{t("vendors.noBankShort")}</Badge>;
}

export default function Vendors() {
  const t = useT();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>((params.get("filter") as Filter) ?? "");
  const [dq, setDq] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setDq(q), 200);
    return () => clearTimeout(h);
  }, [q]);
  const status = filter === "PENDING" || filter === "BLOCKED" ? filter : "";
  const res = useResource(`vendors:list:${status}:${dq}`, () => api.vendors({ q: dq, status }));
  const list = useMemo(
    () => (res.data ?? []).filter((v) => (filter === "bank" ? v.bankStatus === "PENDING" : filter === "nobank" ? v.bankStatus === "NONE" : true)),
    [res.data, filter],
  );

  return (
    <>
      <Header
        title={t("vendors.title")}
        right={
          <button type="button" className="btn btn-ghost min-h-10 px-3 text-body" onClick={() => navigate("/vendors/new")}>
            <Plus size={20} strokeWidth={1.75} /> {t("vendors.add")}
          </button>
        }
      />
      <Page>
        <div className="relative mb-3">
          <Search size={20} strokeWidth={1.75} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <input type="search" className="input pl-11" placeholder={t("vendors.search")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("vendors.search")} />
        </div>
        <div className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4" role="tablist">
          {FILTERS.map((f) => (
            <button key={f.v} type="button" role="tab" className="chip" aria-selected={filter === f.v} onClick={() => setFilter(f.v)}>
              {t(f.key)}
            </button>
          ))}
        </div>
        {res.error && !res.data ? (
          <ErrorState error={res.error} onRetry={res.reload} />
        ) : !res.data ? (
          <ListSkeleton rows={6} />
        ) : list.length === 0 ? (
          <EmptyState icon={q ? SearchX : StoreIcon} title={t("vendors.empty")} />
        ) : (
          <div className="card divide-y divide-line overflow-hidden">
            {list.map((v) => (
              <button key={v.id} type="button" onClick={() => navigate(`/vendors/${v.id}`)} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-body font-semibold text-muted">{v.name.slice(0, 1)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-semibold">{v.name}</span>
                    {v.status !== "ACTIVE" && <Badge tone={v.status === "PENDING" ? "info" : "bad"}>{t(v.status === "PENDING" ? "vendors.statusPending" : "vendors.statusBlocked")}</Badge>}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <BankBadge v={v} />
                    <span className="num truncate text-cap text-muted">{v.gstin}</span>
                  </span>
                </span>
                {v.owedPaise !== 0 && <Amount paise={v.owedPaise} strong className="text-body" />}
              </button>
            ))}
          </div>
        )}
      </Page>
    </>
  );
}

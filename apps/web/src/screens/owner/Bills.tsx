import type { InvoiceState, InvoiceSummary } from "@arad/core";
import { FileText, Search, SearchX } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { api } from "../../api/client";
import { useSession } from "../../app/session";
import { Amount, EmptyState, ErrorState, Header, ListSkeleton, Page, Spinner, StateBadge } from "../../components/ui";
import { useI18n, type MessageKey } from "../../i18n";
import { fmtDate } from "../../lib/format";
import { useResource } from "../../lib/resource";

const FILTERS: { v: InvoiceState | ""; key: MessageKey }[] = [
  { v: "", key: "bills.all" },
  { v: "NEEDS_VERIFICATION", key: "state.NEEDS_VERIFICATION" },
  { v: "VERIFIED", key: "state.VERIFIED" },
  { v: "IN_PAYMENT_RUN", key: "state.IN_PAYMENT_RUN" },
  { v: "PAID", key: "state.PAID" },
  { v: "ON_HOLD", key: "state.ON_HOLD" },
  { v: "DUPLICATE", key: "state.DUPLICATE" },
  { v: "REJECTED", key: "state.REJECTED" },
];

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export default function Bills() {
  const { t, lang } = useI18n();
  const { me, stores } = useSession();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const [q, setQ] = useState("");
  const [state, setState] = useState<InvoiceState | "">((params.get("state") as InvoiceState) ?? "");
  const [storeId, setStoreId] = useState(params.get("store") ?? "");
  const dq = useDebounced(q);
  const [extra, setExtra] = useState<{ items: InvoiceSummary[]; cursor?: string }>({ items: [] });
  const [more, setMore] = useState(false);
  const key = `invoices:list:${state}:${storeId}:${dq}`;
  const res = useResource(key, () => api.invoices({ state, storeId, q: dq, limit: 30 }), { staleMs: 10_000 });
  useEffect(() => setExtra({ items: [], cursor: undefined }), [key]);
  const cursor = extra.cursor ?? res.data?.nextCursor;
  const items = [...(res.data?.items ?? []), ...extra.items];
  const myStores = stores.filter((s) => me?.role === "owner" || me?.storeIds.includes(s.id));

  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const p = await api.invoices({ state, storeId, q: dq, limit: 30, cursor });
      setExtra((x) => ({ items: [...x.items, ...p.items], cursor: p.nextCursor ?? "" }));
    } finally {
      setMore(false);
    }
  };

  return (
    <>
      <Header title={t("bills.title")} />
      <Page>
        <div className="relative mb-3">
          <Search size={20} strokeWidth={1.75} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <input type="search" className="input pl-11" placeholder={t("bills.search")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("bills.search")} enterKeyHint="search" />
        </div>
        <div className="no-scrollbar -mx-4 mb-3 flex gap-2 overflow-x-auto px-4" role="tablist" aria-label={t("bills.filter")}>
          {FILTERS.map((f) => (
            <button key={f.v} type="button" role="tab" className="chip" aria-selected={state === f.v} onClick={() => setState(f.v)}>
              {t(f.key)}
            </button>
          ))}
        </div>
        {myStores.length > 1 && (
          <select className="input mb-4" value={storeId} onChange={(e) => setStoreId(e.target.value)} aria-label={t("bills.store")}>
            <option value="">{t("bills.allStores")}</option>
            {myStores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}

        {res.error && !res.data ? (
          <ErrorState error={res.error} onRetry={res.reload} />
        ) : !res.data ? (
          <ListSkeleton rows={6} />
        ) : items.length === 0 ? (
          <EmptyState icon={q ? SearchX : FileText} title={t("bills.empty")} text={q ? t("bills.emptySearch") : undefined} />
        ) : (
          <>
            <div className="card divide-y divide-line overflow-hidden">
              {items.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => navigate(i.state === "NEEDS_VERIFICATION" ? `/verify/${i.id}` : `/bills/${i.id}`)}
                  className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{i.vendorName ?? t("home.reading")}</span>
                    <span className="block truncate text-cap text-muted">{[i.invoiceNo, i.storeName, fmtDate(i.invoiceDate ?? i.createdAt.slice(0, 10), lang)].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    {i.grandTotalPaise !== undefined && i.state !== "NEEDS_VERIFICATION" ? <Amount paise={i.grandTotalPaise} strong className="text-body" /> : <span className="text-cap text-muted">{t("home.lines", { n: i.lineCount })}</span>}
                    <StateBadge state={i.state} />
                  </span>
                </button>
              ))}
            </div>
            {cursor && (
              <button type="button" className="btn btn-secondary btn-block mt-3" onClick={() => void loadMore()} disabled={more}>
                {more && <Spinner />} {t("common.loadMore")}
              </button>
            )}
          </>
        )}
      </Page>
    </>
  );
}

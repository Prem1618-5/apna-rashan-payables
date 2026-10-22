import type { InvoiceSummary } from "@arad/core";
import { Camera, Check, ChevronDown, ChevronRight, CircleAlert, CloudUpload, Flag, RefreshCw, Store as StoreIcon, Trash2, WifiOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { api } from "../api/client";
import { outbox, useOutbox } from "../app/outbox";
import { useSession } from "../app/session";
import { useToast } from "../components/toast";
import { Amount, BottomBar, EmptyState, ErrorState, ICON, ListSkeleton, Section, Sheet, Spinner } from "../components/ui";
import { useI18n } from "../i18n";
import { fmtAgo } from "../lib/format";
import type { OutboxMeta } from "../lib/outbox";
import { useResource } from "../lib/resource";

export function Home() {
  const { t, lang } = useI18n();
  const { me, store, stores, storeId, setStoreId } = useSession();
  const [, navigate] = useLocation();
  const waiting = useOutbox();
  const [storeSheet, setStoreSheet] = useState(false);
  const myStores = stores.filter((s) => me?.role === "owner" || me?.storeIds.includes(s.id));

  const key = storeId ? `invoices:home:${storeId}` : null;
  const [poll, setPoll] = useState(20_000);
  const res = useResource(
    key,
    async () => {
      const [ready, reading, captured, done] = await Promise.all([
        api.invoices({ storeId, state: "NEEDS_VERIFICATION", limit: 50 }),
        api.invoices({ storeId, state: "EXTRACTING", limit: 20 }),
        api.invoices({ storeId, state: "CAPTURED", limit: 20 }),
        api.invoices({ storeId, state: "VERIFIED", limit: 50 }),
      ]);
      return {
        ready: ready.items,
        reading: [...captured.items, ...reading.items],
        done: done.items.filter((i) => isToday(i.createdAt)),
      };
    },
    { pollMs: poll, staleMs: 5_000 },
  );
  const reading = res.data?.reading.length ?? 0;
  useEffect(() => setPoll(reading || waiting.length ? 3_000 : 20_000), [reading, waiting.length]);

  const hour = new Date().getHours();
  const greet = hour < 12 ? t("home.morning") : hour < 17 ? t("home.afternoon") : t("home.evening");
  const firstName = me?.name.split(" ")[0] ?? "";

  return (
    <div className="pt-safe">
      <main className="mx-auto w-full max-w-2xl px-4 pb-48 pt-5">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-body text-muted">{greet}</p>
            <h1 className="truncate text-h1 font-semibold">{firstName}</h1>
          </div>
          <button
            type="button"
            className="chip mt-1 max-w-[55%] shrink-0"
            onClick={() => myStores.length > 1 && setStoreSheet(true)}
            aria-label={t("home.switchStore")}
            disabled={myStores.length < 2}
          >
            <StoreIcon size={16} strokeWidth={1.75} className="text-brand" />
            <span className="truncate font-semibold">{store?.name ?? "…"}</span>
            {myStores.length > 1 && <ChevronDown size={16} strokeWidth={1.75} className="text-muted" />}
          </button>
        </div>

        <TodayStrip ready={res.data?.ready.length} done={res.data?.done.length} waiting={waiting.length} />

        {waiting.length > 0 && (
          <Section title={t("home.waiting")} count={waiting.length}>
            <div className="card divide-y divide-line overflow-hidden">
              {waiting.map((w) => (
                <OutboxRow key={w.clientId} item={w} />
              ))}
            </div>
          </Section>
        )}

        <Section title={t("home.ready")} count={res.data ? res.data.ready.length : undefined}>
          {res.error && !res.data ? (
            <ErrorState error={res.error} onRetry={res.reload} />
          ) : !res.data ? (
            <ListSkeleton rows={2} />
          ) : res.data.ready.length === 0 && reading === 0 ? (
            <EmptyState icon={Check} title={t("home.readyEmpty")} text={t("home.readyEmptyText")} />
          ) : (
            <div className="card divide-y divide-line overflow-hidden">
              {res.data.reading.map((i) => (
                <div key={i.id} className="flex min-h-16 items-center gap-3 px-4 py-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-info-soft text-info">
                    <Spinner />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{t("home.reading")}</span>
                    <span className="block text-cap text-muted">{t("home.readingSub", { ago: fmtAgo(i.createdAt, lang) })}</span>
                  </span>
                </div>
              ))}
              {res.data.ready.map((i) => (
                <ReadyRow key={i.id} inv={i} onOpen={() => navigate(`/verify/${i.id}`)} />
              ))}
            </div>
          )}
        </Section>

        {res.data && res.data.done.length > 0 && <DoneToday items={res.data.done} />}
      </main>

      <BottomBar withTabs>
        <button type="button" className="btn btn-primary btn-block min-h-14 text-lead" onClick={() => navigate("/capture")}>
          <Camera size={24} strokeWidth={1.75} />
          {t("home.photograph")}
        </button>
      </BottomBar>

      <Sheet open={storeSheet} onClose={() => setStoreSheet(false)} title={t("home.chooseStore")}>
        <div className="card divide-y divide-line overflow-hidden" role="radiogroup">
          {myStores.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={s.id === storeId}
              onClick={() => {
                setStoreId(s.id);
                setStoreSheet(false);
              }}
              className="flex min-h-14 w-full items-center gap-3 px-4 text-left active:bg-surface-2"
            >
              <StoreIcon {...ICON} className="text-muted" />
              <span className="flex-1">
                <span className="block font-semibold">{s.name}</span>
                <span className="block text-cap text-muted">{s.address}</span>
              </span>
              {s.id === storeId && <Check {...ICON} className="text-brand" />}
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

function isToday(iso: string) {
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

function TodayStrip({ ready, done, waiting }: { ready?: number; done?: number; waiting: number }) {
  const { t } = useI18n();
  const cell = (n: number | undefined, label: string, tone: string) => (
    <div className="flex-1 px-3 py-3">
      <p className={`num text-h1 font-semibold ${tone}`}>{n ?? "–"}</p>
      <p className="text-cap text-muted">{label}</p>
    </div>
  );
  return (
    <div className="card mb-6 flex divide-x divide-line">
      {cell(waiting, t("home.statWaiting"), waiting ? "text-info" : "")}
      {cell(ready, t("home.statReady"), ready ? "text-warn" : "")}
      {cell(done, t("home.statDone"), done ? "text-ok" : "")}
    </div>
  );
}

function ReadyRow({ inv, onOpen }: { inv: InvoiceSummary; onOpen: () => void }) {
  const { t, lang } = useI18n();
  return (
    <button type="button" onClick={onOpen} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warn-soft text-warn">
        <Flag size={18} strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{inv.vendorName ?? t("home.unknownVendor")}</span>
        <span className="block truncate text-cap text-muted">
          {[inv.invoiceNo, t("home.lines", { n: inv.lineCount }), fmtAgo(inv.createdAt, lang)].filter(Boolean).join(" · ")}
        </span>
        {inv.flaggedCount > 0 && (
          <span className="mt-1 inline-flex items-center gap-1 text-cap font-semibold text-warn">
            <CircleAlert size={14} strokeWidth={2} />
            {t("home.toLookAt", { n: inv.flaggedCount })}
          </span>
        )}
      </span>
      <span className="flex items-center gap-1 text-body font-semibold text-brand">
        {t("home.check")}
        <ChevronRight size={18} strokeWidth={1.75} />
      </span>
    </button>
  );
}

function DoneToday({ items }: { items: InvoiceSummary[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const total = useMemo(() => items.reduce((s, i) => s + (i.grandTotalPaise ?? 0), 0), [items]);
  return (
    <Section title={t("home.done")} count={items.length}>
      <div className="card overflow-hidden">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-h-14 w-full items-center gap-3 px-4 text-left">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-ok-soft text-ok">
            <Check size={20} strokeWidth={2} />
          </span>
          <span className="flex-1">
            <span className="block font-semibold">{t("home.doneSummary", { n: items.length })}</span>
            <span className="block text-cap text-muted">
              <Amount paise={total} />
            </span>
          </span>
          <ChevronDown size={18} strokeWidth={1.75} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <div className="anim-fade divide-y divide-line border-t border-line">
            {items.map((i) => (
              <div key={i.id} className="flex min-h-12 items-center gap-3 px-4 py-2">
                <span className="min-w-0 flex-1 truncate">{i.vendorName}</span>
                <Amount paise={i.grandTotalPaise ?? 0} className="text-body" />
              </div>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

function OutboxRow({ item }: { item: OutboxMeta }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [thumb, setThumb] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let url: string | undefined;
    void outbox.firstPage(item.clientId).then((b) => {
      if (b && b.type.startsWith("image/")) setThumb((url = URL.createObjectURL(b)));
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [item.clientId]);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const status = item.uploading
    ? t("outbox.uploading")
    : item.stuck
      ? t("outbox.stuck", { reason: item.lastError ?? "" })
      : offline
        ? t("outbox.offline")
        : item.attempts > 0
          ? t("outbox.retrying")
          : t("outbox.queued");
  return (
    <div className="flex min-h-16 items-center gap-3 px-4 py-3">
      <span className="relative h-12 w-10 shrink-0 overflow-hidden rounded-md border border-line bg-surface-2">
        {thumb && <img src={thumb} alt="" className="h-full w-full object-cover" />}
        <span className="absolute inset-x-0 bottom-0 flex justify-center bg-black/45 py-0.5 text-white">
          {item.uploading ? <Spinner size={12} /> : offline ? <WifiOff size={12} strokeWidth={2} /> : <CloudUpload size={12} strokeWidth={2} />}
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{t("outbox.title", { n: item.pageCount })}</span>
        <span className={`block text-cap ${item.stuck ? "text-bad" : "text-muted"}`}>
          {status} · {fmtAgo(item.createdAt, lang)} · {Math.round(item.bytes / 1024)} KB
        </span>
      </span>
      {(item.stuck || item.attempts > 0) && !item.uploading && (
        <button type="button" className="icon-btn text-brand" aria-label={t("common.retry")} onClick={() => void outbox.retry(item.clientId)}>
          <RefreshCw {...ICON} />
        </button>
      )}
      {item.stuck && (
        <>
          <button type="button" className="icon-btn text-bad" aria-label={t("outbox.discard")} onClick={() => setConfirm(true)}>
            <Trash2 {...ICON} />
          </button>
          <Sheet
            open={confirm}
            onClose={() => setConfirm(false)}
            title={t("outbox.discardTitle")}
            footer={
              <div className="flex gap-2">
                <button type="button" className="btn btn-secondary flex-1" onClick={() => setConfirm(false)}>
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-danger flex-1"
                  onClick={() => {
                    void outbox.discard(item.clientId).then(() => toast(t("outbox.discarded"), { kind: "info" }));
                    setConfirm(false);
                  }}
                >
                  {t("outbox.discard")}
                </button>
              </div>
            }
          >
            <p className="text-body text-muted">{t("outbox.discardText")}</p>
          </Sheet>
        </>
      )}
    </div>
  );
}

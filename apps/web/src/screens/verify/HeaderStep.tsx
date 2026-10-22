import type { HeaderField, InvoiceDetail, InvoiceHeader } from "@arad/core";
import { isValidGstin } from "@arad/core";
import { CircleAlert, CircleCheck, Expand, PencilLine, QrCode, Store as StoreIcon } from "lucide-react";
import { useState } from "react";
import { BottomBar, ICON, Spinner } from "../../components/ui";
import { useI18n, type MessageKey } from "../../i18n";
import { fmtDate } from "../../lib/format";
import { isLow } from "./logic";

const ROWS: { key: HeaderField; label: MessageKey; type?: "date" | "gstin" }[] = [
  { key: "vendorName", label: "header.vendor" },
  { key: "sellerGstin", label: "header.gstin", type: "gstin" },
  { key: "invoiceNo", label: "header.invoiceNo" },
  { key: "invoiceDate", label: "header.date", type: "date" },
];

export function HeaderStep({
  inv,
  storeName,
  onZoom,
  onConfirm,
  onProblem,
}: {
  inv: InvoiceDetail;
  storeName: string;
  onZoom: () => void;
  onConfirm: (changes: Partial<InvoiceHeader>) => Promise<void>;
  onProblem: () => void;
}) {
  const { t, lang } = useI18n();
  const [edits, setEdits] = useState<Partial<InvoiceHeader>>({});
  const [editing, setEditing] = useState<HeaderField | null>(null);
  const [busy, setBusy] = useState(false);
  const page = inv.pages[0];
  const value = (k: HeaderField) => (edits[k] ?? inv.header[k]) as string | undefined;
  const qrOk = inv.checks.find((c) => c.id === "qr_header")?.status === "pass";

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm(edits);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <main className="mx-auto max-w-2xl px-4 pb-36 pt-4">
        <p className="mb-3 text-body text-muted">{t("header.intro")}</p>
        {page && (
          <button type="button" onClick={onZoom} className="card relative mb-4 block w-full overflow-hidden bg-surface-2" aria-label={t("verify.zoomPage")}>
            <img src={page.url} alt={t("verify.pageImage")} className="mx-auto max-h-[38dvh] w-full object-contain object-top" />
            <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-cap font-semibold text-white">
              <Expand size={14} strokeWidth={2} /> {t("verify.tapToZoom")}
            </span>
          </button>
        )}

        {inv.qr && (
          <p className={`mb-3 flex items-center gap-2 rounded-[12px] px-3 py-2 text-body font-semibold ${qrOk ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`}>
            <QrCode size={18} strokeWidth={2} />
            {qrOk ? t("header.qrMatch") : t("header.qrDiffers")}
          </p>
        )}

        <div className="card divide-y divide-line">
          {ROWS.map((r) => {
            const meta = inv.headerMeta[r.key];
            const low = isLow(meta) && edits[r.key] === undefined;
            const v = value(r.key);
            const gstinBad = r.type === "gstin" && !!v && !isValidGstin(v);
            return (
              <div key={r.key} className={`px-4 py-3 ${low ? "bg-warn-soft" : ""}`}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1 text-cap text-muted">
                      {low && <CircleAlert size={13} strokeWidth={2.25} className="text-warn" />}
                      {t(r.label)}
                      {low && <span className="font-semibold text-warn">· {t("header.checkThis")}</span>}
                    </p>
                    {editing === r.key ? (
                      <input
                        autoFocus
                        className="input mt-1"
                        type={r.type === "date" ? "date" : "text"}
                        defaultValue={v ?? ""}
                        autoCapitalize={r.type === "gstin" ? "characters" : "words"}
                        onBlur={(e) => {
                          const nv = r.type === "gstin" ? e.target.value.toUpperCase().replace(/\s/g, "") : e.target.value.trim();
                          if (nv && nv !== inv.header[r.key]) setEdits((x) => ({ ...x, [r.key]: nv }));
                          setEditing(null);
                        }}
                        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                        aria-label={t(r.label)}
                      />
                    ) : (
                      <p className={`mt-0.5 break-words text-lead font-semibold ${r.type === "gstin" ? "num tracking-wide" : ""}`}>
                        {r.type === "date" ? fmtDate(v, lang, { year: true }) || "–" : v || "–"}
                      </p>
                    )}
                    {r.type === "gstin" && v && editing !== r.key && (
                      <p className={`mt-0.5 flex items-center gap-1 text-cap ${gstinBad ? "text-bad" : "text-ok"}`}>
                        {gstinBad ? <CircleAlert size={13} strokeWidth={2} /> : <CircleCheck size={13} strokeWidth={2} />}
                        {gstinBad ? t("header.gstinBad") : t("header.gstinOk")}
                      </p>
                    )}
                  </div>
                  {editing !== r.key && (
                    <button type="button" className="icon-btn -mr-2 text-brand" onClick={() => setEditing(r.key)} aria-label={t("header.edit", { field: t(r.label) })}>
                      <PencilLine {...ICON} />
                    </button>
                  )}
                </div>
                {low && meta?.sources && editing !== r.key && (
                  <div className="mt-2">
                    <p className="mb-1 text-cap text-muted">{t("header.readersSaw")}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(meta.sources).map(([src, sv]) => (
                        <button key={src} type="button" className="chip min-h-9 max-w-full text-cap" onClick={() => setEdits((x) => ({ ...x, [r.key]: sv }))}>
                          <span className="text-muted">{src}:</span>
                          <span className="truncate font-semibold">{sv}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <div className="flex items-center gap-3 px-4 py-3">
            <StoreIcon {...ICON} className="text-muted" />
            <div className="flex-1">
              <p className="text-cap text-muted">{t("header.store")}</p>
              <p className="text-lead font-semibold">{storeName}</p>
            </div>
          </div>
        </div>
        <button type="button" onClick={onProblem} className="btn btn-ghost mt-3 w-full text-body">
          {t("verify.problem")}
        </button>
      </main>
      <BottomBar>
        <button type="button" className="btn btn-primary btn-block min-h-14" onClick={() => void confirm()} disabled={busy || editing !== null}>
          {busy ? <Spinner /> : <CircleCheck {...ICON} />}
          {Object.keys(edits).length ? t("header.saveContinue") : t("header.confirm")}
        </button>
      </BottomBar>
    </>
  );
}

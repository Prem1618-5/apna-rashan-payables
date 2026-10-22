import type { PaymentRunState, RunWarning } from "@arad/core";
import { Ban, CircleCheck, FileCheck2, Info, PencilRuler, TriangleAlert, Upload, Wallet } from "lucide-react";
import { Badge } from "../../components/ui";
import { useT, type MessageKey } from "../../i18n";

const RUN: Record<PaymentRunState, { tone: "muted" | "info" | "ok" | "brand" | "bad" | "warn"; key: MessageKey; icon: typeof Info }> = {
  DRAFT: { tone: "warn", key: "run.DRAFT", icon: PencilRuler },
  APPROVED: { tone: "info", key: "run.APPROVED", icon: FileCheck2 },
  UPLOADED: { tone: "info", key: "run.UPLOADED", icon: Upload },
  PAID: { tone: "ok", key: "run.PAID", icon: Wallet },
  CANCELLED: { tone: "muted", key: "run.CANCELLED", icon: Ban },
};

export function RunStateBadge({ state }: { state: PaymentRunState }) {
  const t = useT();
  const r = RUN[state];
  return (
    <Badge tone={r.tone} icon={r.icon}>
      {t(r.key)}
    </Badge>
  );
}

export function WarningRow({ w }: { w: RunWarning }) {
  const t = useT();
  const s =
    w.level === "block"
      ? { cls: "border-bad/40 bg-bad-soft text-bad", icon: <Ban size={18} strokeWidth={2} />, label: t("warn.block") }
      : w.level === "warn"
        ? { cls: "border-warn/40 bg-warn-soft text-warn", icon: <TriangleAlert size={18} strokeWidth={2} />, label: t("warn.warn") }
        : { cls: "border-info/30 bg-info-soft text-info", icon: <Info size={18} strokeWidth={2} />, label: t("warn.info") };
  return (
    <li className={`flex items-start gap-2 rounded-[12px] border px-3 py-2.5 ${s.cls}`}>
      <span className="mt-0.5 shrink-0" aria-label={s.label}>
        {s.icon}
      </span>
      <span className="text-body text-text">
        <span className={`mr-1 font-semibold`}>{s.label}:</span>
        {w.message}
      </span>
    </li>
  );
}

export function TxnBadge({ type }: { type: "N" | "R" | "I" }) {
  const t = useT();
  return <Badge tone={type === "I" ? "brand" : type === "R" ? "info" : "muted"} icon={type === "I" ? CircleCheck : undefined}>{t(type === "N" ? "txn.N" : type === "R" ? "txn.R" : "txn.I")}</Badge>;
}

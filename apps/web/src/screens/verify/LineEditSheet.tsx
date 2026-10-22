import type { InvoiceLine, LineField, LineInput } from "@arad/core";
import { computeLine } from "@arad/core";
import { CircleAlert, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Amount, Sheet, Spinner } from "../../components/ui";
import { useT } from "../../i18n";
import { inputToMilli, inputToPaise, milliToInput, paiseToInput } from "../../lib/format";
import { isLow } from "./logic";

const GST = [0, 5, 12, 18, 28, 40];
const UNITS = ["PCS", "KG", "BAG", "BOX", "PCK", "LTR", "CTN", "TIN", "DOZ"];

interface Form {
  description: string;
  hsn: string;
  qty: string;
  unit: string;
  mrp: string;
  rate: string;
  discount: string;
  gst: string;
  amount: string;
}

const fromLine = (l?: InvoiceLine): Form => ({
  description: l?.description ?? "",
  hsn: l?.hsn ?? "",
  qty: milliToInput(l?.qtyMilli),
  unit: l?.unit ?? "PCS",
  mrp: paiseToInput(l?.mrpPaise),
  rate: paiseToInput(l?.ratePaise),
  discount: l?.discountPaise ? paiseToInput(l.discountPaise) : "",
  gst: l ? String(l.gstRateBp / 100) : "5",
  amount: paiseToInput(l?.totalPaise),
});

/** Prefilled manual entry for a line (or a blank one for a missing line), with live maths. */
export function LineEditSheet({
  open,
  line,
  suggestedAmountPaise,
  onClose,
  onSave,
  onRemove,
}: {
  open: boolean;
  line?: InvoiceLine;
  suggestedAmountPaise?: number;
  onClose: () => void;
  onSave: (l: LineInput) => Promise<void>;
  onRemove?: () => Promise<void>;
}) {
  const t = useT();
  const uid = useId();
  const [f, setF] = useState<Form>(fromLine(line));
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      const base = fromLine(line);
      if (!line && suggestedAmountPaise) base.amount = paiseToInput(suggestedAmountPaise);
      setF(base);
      setTouched(false);
      setBusy(false);
    }
  }, [open, line, suggestedAmountPaise]);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const qtyMilli = inputToMilli(f.qty);
  const ratePaise = inputToPaise(f.rate);
  const discountPaise = f.discount ? inputToPaise(f.discount) : 0;
  const gstRateBp = Math.round(Number(f.gst) * 100);
  const printed = f.amount ? inputToPaise(f.amount) : undefined;
  const valid = !!f.description.trim() && !!qtyMilli && ratePaise !== undefined && discountPaise !== undefined && Number.isFinite(gstRateBp) && gstRateBp >= 0 && gstRateBp <= 4000;
  const calc = useMemo(() => (valid ? computeLine({ qtyMilli: qtyMilli!, ratePaise: ratePaise!, discountPaise: discountPaise!, gstRateBp }) : undefined), [valid, qtyMilli, ratePaise, discountPaise, gstRateBp]);
  const diff = calc && printed !== undefined ? printed - calc.totalPaise : 0;

  const low = (k: LineField) => (line ? isLow(line.meta?.[k]) : false);
  const cls = (k: LineField) => `input num ${low(k) ? "border-warn bg-warn-soft" : ""}`;
  const err = (bad: boolean) => (touched && bad ? "true" : undefined);

  async function save() {
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    try {
      await onSave({
        description: f.description.trim(),
        hsn: f.hsn.trim() || undefined,
        qtyMilli: qtyMilli!,
        unit: f.unit.trim() || undefined,
        mrpPaise: f.mrp ? inputToPaise(f.mrp) : undefined,
        ratePaise: ratePaise!,
        discountPaise: discountPaise!,
        gstRateBp,
        totalPaise: printed,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={line ? t("edit.title", { n: line.idx + 1 }) : t("edit.addTitle")}
      footer={
        <div className="flex gap-2">
          {line && onRemove && (
            <button type="button" className="btn btn-danger px-3" onClick={() => void onRemove()} aria-label={t("edit.remove")} disabled={busy}>
              <Trash2 size={20} strokeWidth={1.75} />
            </button>
          )}
          <button type="button" className="btn btn-primary flex-1" onClick={() => void save()} disabled={busy}>
            {busy && <Spinner />}
            {line ? t("edit.save") : t("edit.add")}
          </button>
        </div>
      }
    >
      <p className="mb-4 text-body text-muted">{t(line ? "edit.help" : "edit.addHelp")}</p>
      <div className="mb-4">
        <label className="label" htmlFor={`${uid}d`}>
          {t("line.item")}
        </label>
        <input id={`${uid}d`} className={`input ${low("description") ? "border-warn bg-warn-soft" : ""}`} value={f.description} onChange={set("description")} aria-invalid={err(!f.description.trim())} data-autofocus={!line || undefined} autoComplete="off" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`${uid}q`}>
            {t("line.qty")}
          </label>
          <input id={`${uid}q`} className={cls("qtyMilli")} inputMode="decimal" value={f.qty} onChange={set("qty")} aria-invalid={err(!qtyMilli)} data-autofocus={low("qtyMilli") || undefined} autoComplete="off" />
        </div>
        <div>
          <label className="label" htmlFor={`${uid}u`}>
            {t("line.unit")}
          </label>
          <select id={`${uid}u`} className="input" value={UNITS.includes(f.unit) ? f.unit : "__"} onChange={set("unit")}>
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
            {!UNITS.includes(f.unit) && <option value="__">{f.unit || "–"}</option>}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`${uid}r`}>
            {t("line.rate")} (₹)
          </label>
          <input id={`${uid}r`} className={cls("ratePaise")} inputMode="decimal" value={f.rate} onChange={set("rate")} aria-invalid={err(ratePaise === undefined)} autoComplete="off" />
        </div>
        <div>
          <label className="label" htmlFor={`${uid}x`}>
            {t("line.discount")} (₹)
          </label>
          <input id={`${uid}x`} className={cls("discountPaise")} inputMode="decimal" value={f.discount} onChange={set("discount")} placeholder="0" aria-invalid={err(discountPaise === undefined)} autoComplete="off" />
        </div>
        <div>
          <label className="label" htmlFor={`${uid}m`}>
            {t("line.mrp")} (₹)
          </label>
          <input id={`${uid}m`} className={cls("mrpPaise")} inputMode="decimal" value={f.mrp} onChange={set("mrp")} autoComplete="off" />
        </div>
        <div>
          <label className="label" htmlFor={`${uid}h`}>
            {t("line.hsn")}
          </label>
          <input id={`${uid}h`} className={cls("hsn")} inputMode="numeric" value={f.hsn} onChange={set("hsn")} autoComplete="off" />
        </div>
      </div>
      <div className="mt-4">
        <p className="label">{t("line.gst")}</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("line.gst")}>
          {GST.map((g) => (
            <button key={g} type="button" role="radio" aria-checked={Number(f.gst) === g} aria-pressed={Number(f.gst) === g} className="chip num min-w-14 justify-center" onClick={() => setF((x) => ({ ...x, gst: String(g) }))}>
              {g}%
            </button>
          ))}
          {!GST.includes(Number(f.gst)) && (
            <span className="chip num" aria-pressed="true">
              {f.gst}%
            </span>
          )}
        </div>
      </div>
      <div className="mt-4">
        <label className="label" htmlFor={`${uid}a`}>
          {t("edit.printedAmount")} (₹)
        </label>
        <input id={`${uid}a`} className={cls("totalPaise")} inputMode="decimal" value={f.amount} onChange={set("amount")} placeholder={calc ? paiseToInput(calc.totalPaise) : ""} autoComplete="off" />
      </div>

      <div className="mt-4 rounded-[12px] bg-surface-2 p-3" aria-live="polite">
        <div className="flex items-baseline justify-between">
          <span className="text-body text-muted">{t("edit.calculated")}</span>
          {calc ? <Amount paise={calc.totalPaise} strong className="text-title" /> : <span className="text-muted">–</span>}
        </div>
        {calc && (
          <p className="num mt-1 text-cap text-muted">
            {t("edit.calcBreakdown", { taxable: paiseToInput(calc.taxablePaise), tax: paiseToInput(calc.taxPaise) })}
          </p>
        )}
        {Math.abs(diff) > 5 && (
          <p className="mt-2 flex items-start gap-1.5 text-cap font-semibold text-warn">
            <CircleAlert size={14} strokeWidth={2} className="mt-0.5 shrink-0" />
            {t("edit.mismatch", { diff: paiseToInput(Math.abs(diff)) })}
          </p>
        )}
      </div>
    </Sheet>
  );
}

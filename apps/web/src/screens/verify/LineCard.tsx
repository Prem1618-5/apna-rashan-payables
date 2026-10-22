import type { FieldMeta, InvoiceLine, LineField } from "@arad/core";
import { formatBp, formatMilli } from "@arad/core";
import { Check, CircleAlert, PencilLine } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Amount } from "../../components/ui";
import { useT, type MessageKey } from "../../i18n";
import { haptic, prefersReducedMotion } from "../../lib/haptics";
import { decideSwipe, isLow } from "./logic";
import { LineCrop } from "./media";

export interface PageInfo {
  url: string;
  w: number;
  h: number;
}

export interface LineCardHandle {
  /** Animate the card off screen, then call back. */
  fly: (dir: "right" | "left") => Promise<void>;
  nudge: () => void;
}

const FIELDS: { key: LineField; label: MessageKey; value: (l: InvoiceLine) => ReactNode }[] = [
  { key: "hsn", label: "line.hsn", value: (l) => l.hsn || "–" },
  { key: "qtyMilli", label: "line.qty", value: (l) => `${formatMilli(l.qtyMilli)}${l.unit ? ` ${l.unit}` : ""}` },
  { key: "mrpPaise", label: "line.mrp", value: (l) => (l.mrpPaise ? <Amount paise={l.mrpPaise} /> : "–") },
  { key: "ratePaise", label: "line.rate", value: (l) => <Amount paise={l.ratePaise} /> },
  { key: "discountPaise", label: "line.discount", value: (l) => (l.discountPaise ? <Amount paise={l.discountPaise} /> : "–") },
  { key: "gstRateBp", label: "line.gst", value: (l) => formatBp(l.gstRateBp) },
];

function Sources({ meta }: { meta?: FieldMeta }) {
  if (!meta?.sources) return null;
  return (
    <span className="mt-0.5 block truncate text-[11px] leading-4 text-warn">
      {Object.entries(meta.sources)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" · ")}
    </span>
  );
}

/** One invoice line as a swipeable card. Transform/opacity only; no React state during the drag. */
export const LineCard = forwardRef<
  LineCardHandle,
  {
    line: InvoiceLine;
    page?: PageInfo;
    position: string;
    canAccept: boolean;
    onAccept: () => void;
    onEdit: () => void;
    onTooSoon: () => void;
    onZoom: () => void;
    interactive?: boolean;
  }
>(function LineCard({ line, page, position, canAccept, onAccept, onEdit, onTooSoon, onZoom, interactive = true }, ref) {
  const t = useT();
  const el = useRef<HTMLDivElement>(null);
  const yes = useRef<HTMLDivElement>(null);
  const no = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x0: number; y0: number; dx: number; on: boolean; pts: { x: number; t: number }[] } | null>(null);
  const canRef = useRef(canAccept);
  canRef.current = canAccept;
  const low = (k: LineField) => isLow(line.meta?.[k]);

  const set = (dx: number, animate: string | false) => {
    const node = el.current;
    if (!node) return;
    node.style.transition = animate || "none";
    const rot = Math.max(-12, Math.min(12, dx / 18));
    node.style.transform = `translate3d(${dx}px,0,0) rotate(${rot}deg)`;
    const w = node.offsetWidth || 320;
    if (yes.current) yes.current.style.opacity = String(Math.max(0, Math.min(1, dx / (w * 0.3))));
    if (no.current) no.current.style.opacity = String(Math.max(0, Math.min(1, -dx / (w * 0.3))));
  };
  const snapBack = () => set(0, "transform 260ms cubic-bezier(.2,1.4,.4,1)");

  const fly = (dir: "right" | "left") =>
    new Promise<void>((resolve) => {
      const node = el.current;
      if (!node || prefersReducedMotion()) return resolve();
      const w = node.offsetWidth || 360;
      set(dir === "right" ? w * 1.3 : -w * 1.3, "transform 220ms cubic-bezier(.3,.7,.4,1), opacity 220ms");
      node.style.opacity = "0";
      setTimeout(resolve, 200);
    });

  useImperativeHandle(ref, () => ({
    fly,
    nudge: () => {
      const node = el.current;
      if (!node) return;
      node.classList.remove("anim-nudge");
      void node.offsetWidth;
      node.classList.add("anim-nudge");
    },
  }));

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    node.style.opacity = "1";
    set(0, false);
  }, [line.id]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || (e.pointerType === "mouse" && e.button !== 0)) return;
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, on: false, pts: [{ x: e.clientX, t: e.timeStamp }] };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        drag.current = null; // vertical scroll wins
        return;
      }
      if (Math.abs(dx) < 8) return;
      d.on = true;
      el.current?.setPointerCapture(e.pointerId);
    }
    d.dx = dx;
    d.pts.push({ x: e.clientX, t: e.timeStamp });
    if (d.pts.length > 6) d.pts.shift();
    set(dx, false);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.on || d.id !== e.pointerId) return;
    const first = d.pts[0]!;
    const last = d.pts[d.pts.length - 1]!;
    const v = (last.x - first.x) / Math.max(1, last.t - first.t);
    const result = decideSwipe(d.dx, v, el.current?.offsetWidth ?? 320);
    if (result === "accept") {
      if (!canRef.current) {
        snapBack();
        onTooSoon();
        return;
      }
      haptic(10);
      void fly("right").then(onAccept);
    } else if (result === "edit") {
      haptic(10);
      snapBack();
      onEdit();
    } else snapBack();
  };

  return (
    <div
      ref={el}
      className="card relative touch-pan-y select-none overflow-hidden p-3 will-change-transform"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null;
        snapBack();
      }}
      data-testid="line-card"
      aria-roledescription={t("verify.card")}
      aria-label={`${position}: ${line.description}`}
    >
      {/* Swipe stamps */}
      <div ref={yes} className="pointer-events-none absolute left-4 top-4 z-10 flex rotate-[-8deg] items-center gap-1 rounded-[10px] border-2 border-ok bg-surface px-2 py-1 text-body font-semibold text-ok opacity-0">
        <Check size={18} strokeWidth={2.5} /> {t("verify.matches")}
      </div>
      <div ref={no} className="pointer-events-none absolute right-4 top-4 z-10 flex rotate-[8deg] items-center gap-1 rounded-[10px] border-2 border-warn bg-surface px-2 py-1 text-body font-semibold text-warn opacity-0">
        <PencilLine size={18} strokeWidth={2} /> {t("verify.fix")}
      </div>

      <div className="mb-2 flex items-center justify-between text-cap text-muted">
        <span className="num font-semibold">{position}</span>
        {line.box && page ? <span>{t("verify.tapToZoom")}</span> : null}
      </div>
      {line.box && page ? (
        <LineCrop url={page.url} box={line.box} pageW={page.w} pageH={page.h} onZoom={onZoom} />
      ) : (
        <div className="flex h-16 items-center justify-center rounded-[12px] border border-dashed border-line text-cap text-muted">{t("verify.noCrop")}</div>
      )}

      <div className={`mt-3 rounded-[10px] px-1 ${low("description") ? "bg-warn-soft px-2 py-1" : ""}`}>
        <p className="text-lead font-semibold leading-6">{line.description}</p>
        <Sources meta={line.meta?.description} />
      </div>

      <dl className="mt-2 grid grid-cols-3 gap-1.5">
        {FIELDS.map((f) => (
          <div key={f.key} className={`min-w-0 rounded-[10px] px-2 py-1.5 ${low(f.key) ? "bg-warn-soft ring-1 ring-warn/40" : "bg-surface-2"}`}>
            <dt className="flex items-center gap-1 truncate text-[12px] leading-4 text-muted">
              {low(f.key) && <CircleAlert size={12} strokeWidth={2.25} className="shrink-0 text-warn" aria-label={t("verify.lowConfidence")} />}
              {t(f.label)}
            </dt>
            <dd className={`num truncate text-body font-semibold ${low(f.key) ? "text-warn" : ""}`}>{f.value(line)}</dd>
            <Sources meta={line.meta?.[f.key]} />
          </div>
        ))}
      </dl>

      <div className={`mt-2 flex items-baseline justify-between rounded-[10px] px-2 py-1.5 ${low("totalPaise") ? "bg-warn-soft" : ""}`}>
        <span className="text-body text-muted">{t("line.amount")}</span>
        <Amount paise={line.totalPaise} strong className="text-h1" />
      </div>
    </div>
  );
});

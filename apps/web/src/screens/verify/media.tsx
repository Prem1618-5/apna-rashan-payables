import type { Box } from "@arad/core";
import { Minus, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../../i18n";
import { cropStrips, cropStyle } from "./logic";

const sizes = new Map<string, { w: number; h: number }>();

/** Natural size of a page image (from the API when known, else measured once and cached). */
export function usePageSize(url: string | undefined, w?: number, h?: number) {
  const [size, setSize] = useState<{ w: number; h: number } | undefined>(() => (w && h ? { w, h } : url ? sizes.get(url) : undefined));
  useEffect(() => {
    if (w && h) return setSize({ w, h });
    if (!url) return;
    const known = sizes.get(url);
    if (known) return setSize(known);
    const img = new Image();
    img.onload = () => {
      const s = { w: img.naturalWidth || 1000, h: img.naturalHeight || 1414 };
      sizes.set(url, s);
      setSize(s);
    };
    img.src = url;
  }, [url, w, h]);
  return size;
}

/** Warm the browser cache for images the next cards will need. */
export function prefetch(urls: (string | undefined)[]) {
  for (const u of urls) {
    if (!u || sizes.has(u)) continue;
    const img = new Image();
    img.decoding = "async";
    img.src = u;
  }
}

/** The printed line cut out of the page photo, in 1–3 readable strips. */
export function LineCrop({ url, box, pageW, pageH, onZoom }: { url: string; box: Box; pageW: number; pageH: number; onZoom?: () => void }) {
  const t = useT();
  const strips = cropStrips(box, pageW, pageH);
  return (
    <button type="button" onClick={onZoom} className="block w-full overflow-hidden rounded-[12px] border border-line bg-[#fdfcf8] text-left" aria-label={t("verify.zoomLine")}>
      {strips.map((s, i) => (
        <div key={i} className={`w-full ${i ? "border-t border-dashed border-[#d9d6cc]" : ""}`} style={cropStyle(url, s, pageW, pageH)} role="img" aria-label={i === 0 ? t("verify.lineImage") : undefined} />
      ))}
    </button>
  );
}

/** Full-screen page with pinch-zoom, drag and double-tap; optional highlighted box. */
export function PageViewer({ url, highlight, onClose }: { url: string; highlight?: Box; onClose: () => void }) {
  const t = useT();
  const [view, setView] = useState({ s: highlight ? 2.2 : 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ s: number; x: number; y: number; d: number; cx: number; cy: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const lastTap = useRef(0);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);

  // Centre the highlighted line once the image has a size.
  const centre = () => {
    const img = imgRef.current;
    if (!img || !highlight) return;
    const r = img.getBoundingClientRect();
    const w = r.width / view.s;
    const h = r.height / view.s;
    const cx = (highlight.x + highlight.w / 2 - 0.5) * w;
    const cy = (highlight.y + highlight.h / 2 - 0.5) * h;
    setView((v) => ({ ...v, x: -cx * v.s, y: -cy * v.s }));
  };

  const onDown = (e: ReactPointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const d = pts.length > 1 ? Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) : 0;
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    start.current = { ...view, d, cx, cy };
    if (pts.length === 1) {
      const now = Date.now();
      if (now - lastTap.current < 280) setView((v) => (v.s > 1.2 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: v.x, y: v.y }));
      lastTap.current = now;
    }
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !start.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const st = start.current;
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    let s = st.s;
    if (pts.length > 1 && st.d > 0) s = Math.max(1, Math.min(5, (st.s * Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y)) / st.d));
    setView({ s, x: st.x + (cx - st.cx), y: st.y + (cy - st.cy) });
  };
  const onUp = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    const pts = [...pointers.current.values()];
    if (pts.length) {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      start.current = { ...view, d: 0, cx, cy };
    } else start.current = null;
    if (view.s <= 1.01) setView({ s: 1, x: 0, y: 0 });
  };
  const zoom = (f: number) => setView((v) => ({ ...v, s: Math.max(1, Math.min(5, v.s * f)) }));

  return (
    <div className="anim-fade fixed inset-0 z-[70] bg-black" role="dialog" aria-modal="true" aria-label={t("verify.pageViewer")}>
      <div className="absolute inset-0 touch-none overflow-hidden" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="flex h-full w-full items-center justify-center" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transformOrigin: "center" }}>
          <div className="relative max-h-full max-w-full">
            <img ref={imgRef} src={url} alt={t("verify.pageImage")} className="max-h-[100dvh] max-w-full object-contain" onLoad={centre} draggable={false} />
            {highlight && (
              <div
                className="pointer-events-none absolute rounded-sm ring-2 ring-[#F0A63A]"
                style={{ left: `${highlight.x * 100}%`, top: `${highlight.y * 100}%`, width: `${highlight.w * 100}%`, height: `${highlight.h * 100}%`, background: "rgb(240 166 58 / 0.12)" }}
              />
            )}
          </div>
        </div>
      </div>
      <div className="pt-safe absolute inset-x-0 top-0 flex justify-between p-3">
        <button type="button" className="icon-btn bg-black/55 text-white" onClick={onClose} aria-label={t("common.close")}>
          <X size={24} strokeWidth={1.75} />
        </button>
        <div className="flex gap-2">
          <button type="button" className="icon-btn bg-black/55 text-white" onClick={() => zoom(1 / 1.5)} aria-label={t("verify.zoomOut")}>
            <Minus size={22} strokeWidth={1.75} />
          </button>
          <button type="button" className="icon-btn bg-black/55 text-white" onClick={() => zoom(1.5)} aria-label={t("verify.zoomIn")}>
            <Plus size={22} strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </div>
  );
}

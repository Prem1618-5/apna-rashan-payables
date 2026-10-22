import type { ClassifiedQr } from "@arad/core";
import { classifyQr } from "@arad/core";
import { Camera, CameraOff, Check, CircleCheck, FileText, Flashlight, FlashlightOff, ImagePlus, Info, QrCode, ScanLine, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { outbox } from "../../app/outbox";
import { useSession } from "../../app/session";
import { useToast } from "../../components/toast";
import { BottomBar, Header, ICON, Sheet, Spinner } from "../../components/ui";
import { useT, type MessageKey } from "../../i18n";
import { haptic } from "../../lib/haptics";
import { compressFile, compressSource, frameQuality, grabPixels, hintFor, loadImage, type FrameHint, type Rect } from "../../lib/image";
import { requestPersistentStorage } from "../../lib/outbox";
import { createQrScanner, type QrScanner } from "./qr";

interface Shot {
  id: number;
  blob: Blob;
  url?: string;
  qr: string[];
  pdf?: boolean;
}
type CamState = "starting" | "live" | "denied" | "unavailable";

const QR_RANK = { einvoice: 3, upi: 2, other: 1 } as const;
const best = (list: ClassifiedQr[]) => list.slice().sort((a, b) => QR_RANK[b.kind] - QR_RANK[a.kind])[0];

export default function Capture() {
  const t = useT();
  const toast = useToast();
  const [, navigate] = useLocation();
  const { storeId, store } = useSession();
  const [shots, setShots] = useState<Shot[]>([]);
  const [cam, setCam] = useState<CamState>("starting");
  const [hint, setHint] = useState<FrameHint | undefined>();
  const [qr, setQr] = useState<ClassifiedQr[]>([]);
  const [flash, setFlash] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [torch, setTorch] = useState<boolean | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const scannerRef = useRef<Promise<QrScanner> | undefined>(undefined);
  const liveQr = useRef(new Map<string, ClassifiedQr>());
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const scanner = () => (scannerRef.current ??= createQrScanner());

  // ---------------------------------------------------------------- camera
  useEffect(() => {
    let cancelled = false;
    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) return setCam("unavailable");
      let stream: MediaStream | undefined;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 2560 }, height: { ideal: 1920 } },
        });
      } catch (e) {
        const name = (e as DOMException).name;
        if (name === "NotAllowedError" || name === "SecurityError") return !cancelled && setCam("denied");
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "environment" } });
        } catch (e2) {
          return !cancelled && setCam((e2 as DOMException).name === "NotAllowedError" ? "denied" : "unavailable");
        }
      }
      if (cancelled) return stream?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = stream;
      const v = videoRef.current!;
      v.srcObject = stream;
      try {
        await v.play();
      } catch {
        /* autoplay may need the next tap; the video still shows frames */
      }
      const track = stream.getVideoTracks()[0];
      const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
      if (caps.torch) setTorch(false);
      if (!cancelled) setCam("live");
    }
    void start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = undefined;
    };
  }, []);

  useEffect(
    () => () => {
      void scannerRef.current?.then((s) => s.dispose());
    },
    [],
  );

  /** The on-screen guide frame, in video pixel coordinates (video uses object-fit: cover). */
  const regionInVideo = useCallback((): Rect | undefined => {
    const v = videoRef.current;
    const f = frameRef.current;
    if (!v || !f || !v.videoWidth) return undefined;
    const vr = v.getBoundingClientRect();
    const fr = f.getBoundingClientRect();
    const s = Math.max(vr.width / v.videoWidth, vr.height / v.videoHeight);
    const ox = (vr.width - v.videoWidth * s) / 2;
    const oy = (vr.height - v.videoHeight * s) / 2;
    const pad = 0.03;
    let x = (fr.left - vr.left - ox) / s;
    let y = (fr.top - vr.top - oy) / s;
    let w = fr.width / s;
    let h = fr.height / s;
    x -= w * pad;
    y -= h * pad;
    w *= 1 + 2 * pad;
    h *= 1 + 2 * pad;
    x = Math.max(0, x);
    y = Math.max(0, y);
    w = Math.min(v.videoWidth - x, w);
    h = Math.min(v.videoHeight - y, h);
    return { x, y, w, h };
  }, []);

  // ---------------------------------------------------------------- live hints + QR (~4 fps quality, ~3 fps QR)
  useEffect(() => {
    if (cam !== "live") return;
    let raf = 0;
    let lastQ = 0;
    let lastQr = 0;
    let qrBusy = false;
    const hist: FrameHint[] = [];
    const small = document.createElement("canvas");
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const v = videoRef.current;
      if (!v || document.hidden || busy || v.readyState < 2) return;
      const region = regionInVideo();
      if (!region) return;
      if (now - lastQ > 250) {
        lastQ = now;
        const q = frameQuality(grabPixels(v, region, 200, small));
        hist.push(hintFor(q));
        if (hist.length > 3) hist.shift();
        // Only change the hint when 2 of the last 3 frames agree, so it doesn't flicker.
        const counts = hist.reduce<Record<string, number>>((m, h) => ((m[h] = (m[h] ?? 0) + 1), m), {});
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        if (top && top[1] >= 2) setHint(top[0] as FrameHint);
      }
      if (!qrBusy && now - lastQr > 330) {
        lastQr = now;
        qrBusy = true;
        void scanner()
          .then((s) => s.scan(v, v.videoWidth, v.videoHeight, region, 720))
          .then((texts) => {
            let changed = false;
            for (const raw of texts) {
              if (!liveQr.current.has(raw)) {
                liveQr.current.set(raw, classifyQr(raw));
                changed = true;
              }
            }
            if (changed) {
              haptic(8);
              setQr([...liveQr.current.values()]);
            }
          })
          .finally(() => (qrBusy = false));
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [cam, busy, regionInVideo]);

  const addShot = (s: Omit<Shot, "id" | "url">) => {
    const url = s.blob.type.startsWith("image/") ? URL.createObjectURL(s.blob) : undefined;
    setShots((list) => [...list, { ...s, id: ++seq.current, url }]);
  };
  useEffect(() => () => shots.forEach((s) => s.url && URL.revokeObjectURL(s.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const takeQr = () => {
    const raws = [...liveQr.current.keys()];
    liveQr.current.clear();
    setQr([]);
    return raws;
  };

  async function shutter() {
    const v = videoRef.current;
    if (!v || busy || !v.videoWidth) return;
    if (shots.some((s) => s.pdf)) return toast(t("capture.pdfAlone"), { kind: "info" });
    if (shots.length >= 10) return toast(t("capture.maxPages"), { kind: "info" });
    setBusy(true);
    setFlash((n) => n + 1);
    haptic(15);
    try {
      const region = regionInVideo();
      const blob = await compressSource(v, v.videoWidth, v.videoHeight, region);
      let raws = takeQr();
      if (!raws.length) {
        // One careful look at the full-resolution still in case the live scan missed a small QR.
        raws = await scanner()
          .then((s) => s.scan(v, v.videoWidth, v.videoHeight, region, 1400))
          .catch(() => []);
      }
      addShot({ blob, qr: raws });
    } catch (e) {
      toast(t("capture.failed"), { kind: "bad" });
      console.error(e);
    } finally {
      setBusy(false);
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        if (f.type === "application/pdf") {
          if (shots.length || files.length > 1) {
            toast(t("capture.pdfAlone"), { kind: "info" });
            continue;
          }
          addShot({ blob: f, qr: [], pdf: true });
          continue;
        }
        if (!f.type.startsWith("image/")) {
          toast(t("capture.notImage"), { kind: "bad" });
          continue;
        }
        const blob = await compressFile(f);
        let raws: string[] = [];
        try {
          const img = await loadImage(blob);
          raws = await (await scanner()).scan(img, img.naturalWidth, img.naturalHeight, undefined, 1400);
        } catch {
          /* QR is optional */
        }
        addShot({ blob, qr: raws });
      }
    } catch (e) {
      toast(t("capture.failed"), { kind: "bad" });
      console.error(e);
    } finally {
      setBusy(false);
      if (galleryRef.current) galleryRef.current.value = "";
      if (cameraInputRef.current) cameraInputRef.current.value = "";
    }
  }

  function removeShot(id: number) {
    setShots((list) => {
      const s = list.find((x) => x.id === id);
      if (s?.url) URL.revokeObjectURL(s.url);
      return list.filter((x) => x.id !== id);
    });
  }

  async function done() {
    if (!shots.length || saving) return;
    if (!storeId) return toast(t("capture.noStore"), { kind: "bad" });
    setSaving(true);
    try {
      const qrAll = [...new Set(shots.flatMap((s) => s.qr))];
      await outbox.add({ storeId, pages: shots.map((s) => s.blob), qr: qrAll });
      void requestPersistentStorage();
      haptic([10, 40, 10]);
      toast(navigator.onLine === false ? t("capture.savedOffline") : t("capture.saved"));
      navigate("/");
    } catch (e) {
      console.error(e);
      toast(t("capture.saveFailed"), { kind: "bad" });
      setSaving(false);
    }
  }

  const close = () => (shots.length ? setConfirmClose(true) : navigate("/"));
  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torch;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorch(next);
    } catch {
      setTorch(undefined);
    }
  };

  const inputs = (
    <>
      <input ref={galleryRef} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => void onFiles(e.target.files)} data-testid="gallery-input" />
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void onFiles(e.target.files)} data-testid="camera-input" />
    </>
  );

  const discardSheet = (
    <Sheet
      open={confirmClose}
      onClose={() => setConfirmClose(false)}
      title={t("capture.discardTitle", { n: shots.length })}
      footer={
        <div className="flex gap-2">
          <button type="button" className="btn btn-secondary flex-1" onClick={() => setConfirmClose(false)}>
            {t("capture.keep")}
          </button>
          <button type="button" className="btn btn-danger flex-1" onClick={() => navigate("/")}>
            {t("capture.discard")}
          </button>
        </div>
      }
    >
      <p className="text-body text-muted">{t("capture.discardText")}</p>
    </Sheet>
  );

  // ---------------------------------------------------------------- no camera: file picker fallback
  if (cam === "denied" || cam === "unavailable") {
    return (
      <div className="min-h-dvh">
        <Header title={t("capture.title")} back sub={store?.name} />
        <main className="mx-auto max-w-2xl px-4 pb-40 pt-4">
          <div className="card mb-4 p-5">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-warn-soft text-warn">
              <CameraOff size={24} strokeWidth={1.75} />
            </div>
            <p className="text-lead font-semibold">{t(cam === "denied" ? "capture.deniedTitle" : "capture.noCameraTitle")}</p>
            <p className="mt-1 text-body text-muted">{t(cam === "denied" ? "capture.deniedText" : "capture.noCameraText")}</p>
            <div className="mt-4 grid gap-2">
              <button type="button" className="btn btn-primary" onClick={() => cameraInputRef.current?.click()} disabled={busy}>
                <Camera {...ICON} /> {t("capture.takePhoto")}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => galleryRef.current?.click()} disabled={busy}>
                <ImagePlus {...ICON} /> {t("capture.gallery")}
              </button>
            </div>
          </div>
          {busy && (
            <p className="flex items-center gap-2 text-body text-muted">
              <Spinner /> {t("capture.processing")}
            </p>
          )}
          {shots.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {shots.map((s, i) => (
                <ShotThumb key={s.id} shot={s} n={i + 1} onRemove={() => removeShot(s.id)} light />
              ))}
            </div>
          )}
          {inputs}
        </main>
        <BottomBar>
          <button type="button" className="btn btn-primary btn-block min-h-14" disabled={!shots.length || saving} onClick={() => void done()}>
            {saving ? <Spinner /> : <Check {...ICON} />}
            {t("capture.done", { n: shots.length })}
          </button>
        </BottomBar>
        {discardSheet}
      </div>
    );
  }

  // ---------------------------------------------------------------- live camera
  const hintKey: Record<FrameHint, MessageKey> = { ok: "capture.hintOk", blurry: "capture.hintBlurry", dark: "capture.hintDark", bright: "capture.hintBright" };
  const topQr = best(qr);
  const frameTone = hint === "ok" ? "border-[#34C79F]" : hint ? "border-[#F0A63A]" : "border-white/80";
  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black text-white select-none">
      <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" playsInline muted autoPlay aria-label={t("capture.preview")} />
      {cam === "starting" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner size={32} className="text-white/80" />
        </div>
      )}

      {/* Guide frame: everything outside is dimmed. */}
      <div
        ref={frameRef}
        className={`pointer-events-none absolute left-[5%] right-[5%] top-[calc(env(safe-area-inset-top)+76px)] bottom-[calc(env(safe-area-inset-bottom)+190px)] rounded-[18px] border-2 transition-colors duration-200 ${frameTone}`}
        style={{ boxShadow: "0 0 0 100vmax rgb(0 0 0 / 0.5)" }}
        aria-hidden
      >
        {["left-[-3px] top-[-3px] border-l-4 border-t-4 rounded-tl-[18px]", "right-[-3px] top-[-3px] border-r-4 border-t-4 rounded-tr-[18px]", "left-[-3px] bottom-[-3px] border-l-4 border-b-4 rounded-bl-[18px]", "right-[-3px] bottom-[-3px] border-r-4 border-b-4 rounded-br-[18px]"].map((c) => (
          <span key={c} className={`absolute h-8 w-8 border-white ${c}`} />
        ))}
      </div>
      {flash > 0 && <div key={flash} className="pointer-events-none absolute inset-0 bg-white" style={{ animation: "fade-in 180ms reverse both" }} />}

      {/* Top bar */}
      <div className="pt-safe absolute inset-x-0 top-0">
        <div className="flex items-center gap-2 px-3 pt-2">
          <button type="button" onClick={close} className="icon-btn bg-black/45 text-white" aria-label={t("common.close")}>
            <X size={24} strokeWidth={1.75} />
          </button>
          <div className="flex min-w-0 flex-1 justify-center" aria-live="polite">
            <span className="inline-flex max-w-full items-center gap-2 truncate rounded-full bg-black/55 px-3 py-2 text-body font-semibold">
              {hint === "ok" ? <CircleCheck size={18} strokeWidth={2} className="text-[#34C79F]" /> : <ScanLine size={18} strokeWidth={2} />}
              <span className="truncate">{hint ? t(hintKey[hint]) : t("capture.hintFit")}</span>
            </span>
          </div>
          {torch !== undefined ? (
            <button type="button" onClick={() => void toggleTorch()} className="icon-btn bg-black/45 text-white" aria-label={t("capture.torch")} aria-pressed={torch}>
              {torch ? <Flashlight size={22} strokeWidth={1.75} /> : <FlashlightOff size={22} strokeWidth={1.75} />}
            </button>
          ) : (
            <span className="w-12" />
          )}
        </div>
        {topQr && (
          <div className="mt-2 flex justify-center px-4">
            <QrChip qr={topQr} />
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="pb-safe absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-black/0 pt-6">
        {shots.length > 0 && (
          <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto px-4" aria-label={t("capture.pages")}>
            {shots.map((s, i) => (
              <ShotThumb key={s.id} shot={s} n={i + 1} onRemove={() => removeShot(s.id)} />
            ))}
          </div>
        )}
        <div className="flex items-center justify-between px-6 pb-3">
          <button type="button" onClick={() => galleryRef.current?.click()} className="flex h-14 w-14 items-center justify-center rounded-full bg-white/15 text-white" aria-label={t("capture.gallery")} disabled={busy}>
            <ImagePlus size={24} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => void shutter()}
            disabled={busy || cam !== "live"}
            aria-label={shots.length ? t("capture.addPage") : t("capture.shutter")}
            className="relative flex h-20 w-20 items-center justify-center rounded-full border-4 border-white transition-transform duration-150 active:scale-95 disabled:opacity-60"
          >
            <span className="h-16 w-16 rounded-full bg-white" />
            {busy && <Spinner size={28} className="absolute text-black" />}
          </button>
          <button
            type="button"
            onClick={() => void done()}
            disabled={!shots.length || saving}
            className="flex h-14 min-w-14 items-center justify-center gap-1 rounded-full bg-[#0E7C66] px-4 font-semibold text-white transition-opacity disabled:opacity-0"
            aria-label={t("capture.done", { n: shots.length })}
          >
            {saving ? <Spinner /> : <Check size={22} strokeWidth={2} />}
            <span className="num">{shots.length}</span>
          </button>
        </div>
        <p className="px-6 pb-3 text-center text-cap text-white/75">{shots.length ? t("capture.morePages", { n: shots.length + 1 }) : t("capture.tip")}</p>
      </div>
      {inputs}
      {discardSheet}
    </div>
  );
}

function QrChip({ qr }: { qr: ClassifiedQr }) {
  const t = useT();
  if (qr.kind === "einvoice")
    return (
      <span className="anim-pop inline-flex items-center gap-2 rounded-full bg-[#12805C] px-3 py-1.5 text-body font-semibold text-white">
        <QrCode size={18} strokeWidth={2} />
        {t("capture.qrEinvoice")}
        <CircleCheck size={18} strokeWidth={2} />
      </span>
    );
  if (qr.kind === "upi")
    return (
      <span className="anim-pop inline-flex max-w-full items-center gap-2 rounded-full bg-black/65 px-3 py-1.5 text-cap font-semibold text-white">
        <Info size={16} strokeWidth={2} className="shrink-0" />
        <span className="truncate">{t("capture.qrUpi")}</span>
      </span>
    );
  return (
    <span className="anim-pop inline-flex items-center gap-2 rounded-full bg-black/65 px-3 py-1.5 text-cap font-semibold text-white">
      <QrCode size={16} strokeWidth={2} />
      {t("capture.qrOther")}
    </span>
  );
}

function ShotThumb({ shot, n, onRemove, light = false }: { shot: Shot; n: number; onRemove: () => void; light?: boolean }) {
  const t = useT();
  return (
    <div className={`anim-pop relative shrink-0 overflow-hidden rounded-[10px] border ${light ? "aspect-[3/4] border-line bg-surface-2" : "h-20 w-16 border-white/40 bg-white/10"}`}>
      {shot.url ? (
        <img src={shot.url} alt={t("capture.pageN", { n })} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-cap">
          <FileText size={22} strokeWidth={1.75} /> PDF
        </span>
      )}
      <span className="num absolute left-1 top-1 rounded-full bg-black/60 px-1.5 text-[11px] font-semibold text-white">{n}</span>
      {shot.qr.length > 0 && (
        <span className="absolute bottom-1 left-1 rounded-full bg-[#12805C] p-0.5 text-white">
          <QrCode size={12} strokeWidth={2} />
        </span>
      )}
      <button type="button" onClick={onRemove} className="absolute right-0 top-0 flex h-9 w-9 items-start justify-end p-1" aria-label={t("capture.removePage", { n })}>
        <span className="rounded-full bg-black/65 p-1 text-white">
          <Trash2 size={12} strokeWidth={2} />
        </span>
      </button>
    </div>
  );
}

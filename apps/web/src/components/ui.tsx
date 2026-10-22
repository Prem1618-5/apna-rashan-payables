import type { InvoiceState } from "@arad/core";
import { ChevronLeft, CircleAlert, CircleCheck, CircleDashed, CircleX, Clock3, FileWarning, Hourglass, Inbox, Loader, PauseCircle, RefreshCw, Send, Wallet, X } from "lucide-react";
import { useEffect, useId, useRef, type ComponentType, type ReactNode } from "react";
import { useLocation } from "wouter";
import { errorMessage } from "../api/client";
import { useT, type MessageKey } from "../i18n";
import { inr } from "../lib/format";

export const ICON = { size: 20, strokeWidth: 1.75 } as const;

/** Sticky top bar with optional back button. */
export function Header({ title, back, right, sub }: { title: ReactNode; back?: string | true; right?: ReactNode; sub?: ReactNode }) {
  const [, navigate] = useLocation();
  const t = useT();
  return (
    <header className="pt-safe sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/80">
      <div className="mx-auto flex min-h-14 max-w-2xl items-center gap-1 px-2">
        {back ? (
          <button
            type="button"
            className="icon-btn"
            aria-label={t("common.back")}
            onClick={() => (back === true ? history.length > 1 ? history.back() : navigate("/") : navigate(back))}
          >
            <ChevronLeft size={24} strokeWidth={1.75} />
          </button>
        ) : (
          <span className="w-2" />
        )}
        <div className="min-w-0 flex-1 py-2">
          <h1 className="truncate text-lead font-semibold">{title}</h1>
          {sub && <p className="truncate text-cap text-muted">{sub}</p>}
        </div>
        {right && <div className="flex shrink-0 items-center">{right}</div>}
      </div>
    </header>
  );
}

export function Page({ children, className = "", bottomPad = true }: { children: ReactNode; className?: string; bottomPad?: boolean }) {
  return <main className={`mx-auto w-full max-w-2xl px-4 pt-4 ${bottomPad ? "pb-28" : "pb-6"} ${className}`}>{children}</main>;
}

export function Section({ title, count, action, children, className = "" }: { title: ReactNode; count?: number; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`mt-6 first:mt-0 ${className}`}>
      <div className="mb-2 flex min-h-8 items-center justify-between gap-2 px-1">
        <h2 className="section-title">
          {title}
          {count !== undefined && <span className="num ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-cap text-muted normal-case">{count}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  const t = useT();
  return (
    <div className="card divide-y divide-line" aria-busy="true" aria-label={t("common.loading")}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 p-4">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, text, action }: { icon?: ComponentType<{ size?: number; strokeWidth?: number }>; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-8 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-muted">
        <Icon size={24} strokeWidth={1.75} />
      </div>
      <p className="text-lead font-semibold">{title}</p>
      {text && <p className="mt-1 max-w-xs text-body text-muted">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="card flex flex-col items-center px-6 py-8 text-center" role="alert">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-bad-soft text-bad">
        <CircleAlert size={24} strokeWidth={1.75} />
      </div>
      <p className="text-lead font-semibold">{t("common.errorTitle")}</p>
      <p className="mt-1 max-w-xs text-body text-muted">{errorMessage(error)}</p>
      {onRetry && (
        <button type="button" className="btn btn-secondary mt-4" onClick={onRetry}>
          <RefreshCw {...ICON} /> {t("common.retry")}
        </button>
      )}
    </div>
  );
}

export function Spinner({ size = 20, className = "" }: { size?: number; className?: string }) {
  return <Loader size={size} strokeWidth={1.75} className={`anim-spin ${className}`} aria-hidden />;
}

type Tone = "ok" | "warn" | "bad" | "info" | "muted" | "brand";
const TONE: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  info: "bg-info-soft text-info",
  muted: "bg-surface-2 text-muted",
  brand: "bg-brand-soft text-brand",
};
export function Badge({ tone = "muted", icon: Icon, children }: { tone?: Tone; icon?: ComponentType<{ size?: number; strokeWidth?: number }>; children: ReactNode }) {
  return (
    <span className={`inline-flex min-h-6 items-center gap-1 whitespace-nowrap rounded-full px-2 text-cap font-semibold ${TONE[tone]}`}>
      {Icon && <Icon size={14} strokeWidth={2} />}
      {children}
    </span>
  );
}

const STATE: Record<InvoiceState, { tone: Tone; icon: ComponentType<{ size?: number; strokeWidth?: number }>; key: MessageKey }> = {
  CAPTURED: { tone: "muted", icon: Hourglass, key: "state.CAPTURED" },
  EXTRACTING: { tone: "info", icon: Hourglass, key: "state.EXTRACTING" },
  NEEDS_VERIFICATION: { tone: "warn", icon: CircleDashed, key: "state.NEEDS_VERIFICATION" },
  VERIFIED: { tone: "ok", icon: CircleCheck, key: "state.VERIFIED" },
  IN_PAYMENT_RUN: { tone: "info", icon: Send, key: "state.IN_PAYMENT_RUN" },
  PAID: { tone: "brand", icon: Wallet, key: "state.PAID" },
  ON_HOLD: { tone: "warn", icon: PauseCircle, key: "state.ON_HOLD" },
  DUPLICATE: { tone: "bad", icon: FileWarning, key: "state.DUPLICATE" },
  REJECTED: { tone: "bad", icon: CircleX, key: "state.REJECTED" },
  EXTRACTION_FAILED: { tone: "bad", icon: Clock3, key: "state.EXTRACTION_FAILED" },
};
export function StateBadge({ state }: { state: InvoiceState }) {
  const t = useT();
  const s = STATE[state];
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {t(s.key)}
    </Badge>
  );
}

/** Money with tabular figures; the paise part is quieter. */
export function Amount({ paise, className = "", strong = false }: { paise: number; className?: string; strong?: boolean }) {
  const s = inr(paise);
  const dot = s.lastIndexOf(".");
  return (
    <span className={`num whitespace-nowrap ${strong ? "font-semibold" : ""} ${className}`}>
      {s.slice(0, dot)}
      <span className="opacity-60">{s.slice(dot)}</span>
    </span>
  );
}

/** Bottom sheet: scrim, slide up, Escape/scrim closes, focus moves in. */
export function Sheet({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = "hidden";
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus() ?? ref.current?.focus());
    return () => {
      document.removeEventListener("keydown", key);
      html.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="presentation">
      <div className="anim-fade absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        className="anim-sheet pb-safe relative flex max-h-[92dvh] w-full max-w-2xl flex-col rounded-t-[20px] bg-surface shadow-[var(--shadow-sheet)] outline-none"
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line" aria-hidden />
        <div className="flex items-center gap-2 px-4 pt-2">
          <h2 id={id} className="min-w-0 flex-1 text-title font-semibold">
            {title}
          </h2>
          <button type="button" className="icon-btn -mr-2 text-muted" aria-label={t("common.close")} onClick={onClose}>
            <X {...ICON} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-2">{children}</div>
        {footer && <div className="border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="mb-4">
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1.5 flex items-start gap-1 text-cap text-bad" role="alert">
          <CircleAlert size={14} strokeWidth={2} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-cap text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/** Sticky bottom area for the primary action, above the home indicator. */
export function BottomBar({ children, withTabs = false }: { children: ReactNode; withTabs?: boolean }) {
  return (
    <div className={`fixed inset-x-0 z-30 border-t border-line bg-surface/95 backdrop-blur ${withTabs ? "bottom-[calc(64px+env(safe-area-inset-bottom))]" : "pb-safe bottom-0"}`}>
      <div className="mx-auto max-w-2xl px-4 py-3">{children}</div>
    </div>
  );
}

export function Row({ children, onClick, href, className = "" }: { children: ReactNode; onClick?: () => void; href?: string; className?: string }) {
  const [, navigate] = useLocation();
  const cls = `flex w-full items-center gap-3 px-4 py-3 text-left min-h-16 transition-colors active:bg-surface-2 ${className}`;
  if (href || onClick)
    return (
      <button type="button" className={cls} onClick={onClick ?? (() => navigate(href!))}>
        {children}
      </button>
    );
  return <div className={cls}>{children}</div>;
}

import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n";

type Kind = "ok" | "bad" | "info";
interface Toast {
  id: number;
  kind: Kind;
  text: string;
  action?: { label: string; run: () => void };
}
type Show = (text: string, opts?: { kind?: Kind; action?: Toast["action"]; ms?: number }) => void;
const Ctx = createContext<Show>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const tr = useT();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback<Show>(
    (text, opts = {}) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-2), { id, kind: opts.kind ?? "ok", text, action: opts.action }]);
      setTimeout(() => dismiss(id), opts.ms ?? (opts.action ? 5000 : 3200));
    },
    [dismiss],
  );
  const value = useMemo(() => show, [show]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+12px)]" aria-live="polite" role="status">
        {toasts.map((t) => {
          const Icon = t.kind === "ok" ? CircleCheck : t.kind === "bad" ? CircleAlert : Info;
          const color = t.kind === "ok" ? "text-ok" : t.kind === "bad" ? "text-bad" : "text-info";
          return (
            <div key={t.id} className="anim-rise pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-[14px] border border-line bg-surface py-2 pl-3 pr-1 shadow-[var(--shadow-sheet)]">
              <Icon size={20} strokeWidth={1.75} className={`shrink-0 ${color}`} aria-hidden />
              <p className="min-w-0 flex-1 py-1.5 text-body">{t.text}</p>
              {t.action && (
                <button
                  type="button"
                  className="btn btn-ghost min-h-10 px-3 text-body"
                  onClick={() => {
                    t.action!.run();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button type="button" className="icon-btn h-10 w-10 text-muted" aria-label={tr("common.close")} onClick={() => dismiss(t.id)}>
                <X size={18} strokeWidth={1.75} />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);

import { Delete } from "lucide-react";
import { useEffect } from "react";
import { useT } from "../i18n";
import { haptic } from "../lib/haptics";

/** Applies one key to the typed text. Amounts: up to 9 digits and 2 decimals; PINs: digits only. */
export function applyKey(text: string, key: string, opts: { decimal?: boolean; maxLength?: number } = {}): string {
  if (key === "back") return text.slice(0, -1);
  if (key === "clear") return "";
  if (key === ".") {
    if (!opts.decimal || text.includes(".")) return text;
    return text ? `${text}.` : "0.";
  }
  if (!/^\d$/.test(key)) return text;
  if (opts.maxLength && text.replace(".", "").length >= opts.maxLength) return text;
  if (opts.decimal) {
    const [, frac] = text.split(".");
    if (frac !== undefined && frac.length >= 2) return text;
    if (!text.includes(".") && text.replace(/^0+/, "").length >= 9) return text;
    if (text === "0") return key;
  }
  return text + key;
}

/** Shows typed rupees with Indian grouping: "123456.5" -> "1,23,456.5". */
export function groupTyped(text: string): string {
  if (!text) return "0";
  const [whole = "0", frac] = text.split(".");
  const w = whole.replace(/^0+(?=\d)/, "");
  const last3 = w.slice(-3);
  const rest = w.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return frac !== undefined ? `${grouped}.${frac}` : grouped;
}

export function Keypad({
  onKey,
  decimal = false,
  disabled = false,
  keyboard = true,
  size = "lg",
}: {
  onKey: (key: string) => void;
  decimal?: boolean;
  disabled?: boolean;
  keyboard?: boolean;
  size?: "lg" | "md";
}) {
  const t = useT();
  useEffect(() => {
    if (!keyboard || disabled) return;
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (/^\d$/.test(e.key)) onKey(e.key);
      else if (e.key === "Backspace") onKey("back");
      else if ((e.key === "." || e.key === ",") && decimal) onKey(".");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onKey, decimal, keyboard, disabled]);

  const press = (k: string) => {
    if (disabled) return;
    haptic(6);
    onKey(k);
  };
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", decimal ? "." : "", "0", "back"];
  const h = size === "lg" ? "h-16" : "h-14";
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label={t("keypad.label")}>
      {keys.map((k, i) =>
        k === "" ? (
          <span key={i} />
        ) : (
          <button
            key={k}
            type="button"
            disabled={disabled}
            onClick={() => press(k)}
            aria-label={k === "back" ? t("keypad.delete") : k === "." ? t("keypad.dot") : k}
            className={`${h} num flex select-none items-center justify-center rounded-[14px] bg-surface text-h1 font-semibold text-text transition-[transform,background-color] duration-150 active:scale-95 active:bg-surface-2 disabled:opacity-40 border border-line`}
          >
            {k === "back" ? <Delete size={26} strokeWidth={1.75} /> : k}
          </button>
        ),
      )}
    </div>
  );
}

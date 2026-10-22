import type { Lang } from "@arad/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type MessageKey } from "./en";
import { hi } from "./hi";

export type { MessageKey };
export const DICTS: Record<Lang, Record<MessageKey, string>> = { en, hi };
const KEY = "arad.lang";

/** Fills {name} placeholders. */
export function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] !== undefined ? String(params[k]) : m));
}

export function translate(lang: Lang, key: MessageKey, params?: Record<string, string | number>): string {
  const one = params?.n === 1 ? DICTS[lang][`${key}_one` as MessageKey] : undefined;
  return format(one ?? DICTS[lang][key] ?? en[key] ?? key, params);
}

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "hi") return saved;
  } catch {
    /* ignore */
  }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("hi") ? "hi" : "en";
}

export type T = (key: MessageKey, params?: Record<string, string | number>) => string;
interface Ctx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: T;
}
const LangCtx = createContext<Ctx>({ lang: "en", setLang: () => {}, t: (k, p) => translate("en", k, p) });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(KEY, l);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang === "hi" ? "hi" : "en";
  }, [lang]);
  const value = useMemo<Ctx>(() => ({ lang, setLang, t: (k, p) => translate(lang, k, p) }), [lang, setLang]);
  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>;
}

export const useI18n = () => useContext(LangCtx);
export const useT = () => useContext(LangCtx).t;

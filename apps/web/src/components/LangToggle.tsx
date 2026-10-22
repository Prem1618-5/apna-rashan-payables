import type { Lang } from "@arad/core";
import { useI18n } from "../i18n";
import { useSession } from "../app/session";

/** EN | हिं segmented switch. Saves to the server when logged in. */
export function LangToggle() {
  const { lang, t } = useI18n();
  const { changeLang } = useSession();
  const opts: { v: Lang; label: string }[] = [
    { v: "en", label: "English" },
    { v: "hi", label: "हिंदी" },
  ];
  return (
    <div className="inline-flex rounded-full border border-line bg-surface p-1" role="group" aria-label={t("lang.label")}>
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          lang={o.v}
          aria-pressed={lang === o.v}
          onClick={() => changeLang(o.v)}
          className={`min-h-10 rounded-full px-4 text-body font-semibold transition-colors ${lang === o.v ? "bg-text text-bg" : "text-muted"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

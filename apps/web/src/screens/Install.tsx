import { CircleCheck, Download, EllipsisVertical, Plus, Share, SquarePlus } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { BrandMark } from "../components/BrandMark";
import { useToast } from "../components/toast";
import { Header, Page } from "../components/ui";
import { useT } from "../i18n";
import { canPromptInstall, isIos, isStandalone, onInstallChange, promptInstall } from "../lib/install";

/** A tiny drawing of a phone screen for each step. */
function Phone({ children, bar }: { children: ReactNode; bar: "top" | "bottom" }) {
  return (
    <div className="mx-auto h-36 w-24 shrink-0 overflow-hidden rounded-[16px] border-2 border-text/70 bg-surface-2 p-1" aria-hidden>
      <div className="flex h-full flex-col overflow-hidden rounded-[11px] bg-bg">
        {bar === "top" && <div className="flex h-5 items-center justify-end gap-1 border-b border-line bg-surface px-1.5">{children}</div>}
        <div className="flex flex-1 items-center justify-center">
          <BrandMark size={26} className="opacity-80" />
        </div>
        {bar === "bottom" && <div className="flex h-6 items-center justify-center border-t border-line bg-surface">{children}</div>}
      </div>
    </div>
  );
}

function Step({ n, text, art }: { n: number; text: ReactNode; art: ReactNode }) {
  return (
    <li className="flex items-center gap-4 px-4 py-4">
      <div className="min-w-0 flex-1">
        <span className="num mb-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-brand text-cap font-semibold text-brand-ink">{n}</span>
        <p className="text-body">{text}</p>
      </div>
      {art}
    </li>
  );
}

export default function Install() {
  const t = useT();
  const toast = useToast();
  const [os, setOs] = useState<"android" | "ios">(isIos() ? "ios" : "android");
  const [canPrompt, setCanPrompt] = useState(canPromptInstall());
  useEffect(() => onInstallChange(() => setCanPrompt(canPromptInstall())), []);
  const installed = isStandalone();

  return (
    <>
      <Header title={t("install.title")} back="/more" />
      <Page>
        {installed ? (
          <div className="card mb-4 flex items-center gap-3 p-4 text-ok">
            <CircleCheck size={24} strokeWidth={1.75} />
            <p className="font-semibold">{t("install.done")}</p>
          </div>
        ) : (
          <p className="mb-4 text-body text-muted">{t("install.intro")}</p>
        )}

        <div className="mb-4 inline-flex rounded-full border border-line bg-surface p-1" role="tablist">
          {(["android", "ios"] as const).map((o) => (
            <button key={o} type="button" role="tab" aria-selected={os === o} onClick={() => setOs(o)} className={`min-h-10 rounded-full px-4 font-semibold ${os === o ? "bg-text text-bg" : "text-muted"}`}>
              {o === "android" ? "Android" : "iPhone"}
            </button>
          ))}
        </div>

        {os === "android" ? (
          <>
            {canPrompt && (
              <button
                type="button"
                className="btn btn-primary btn-block mb-4 min-h-14"
                onClick={async () => {
                  if (await promptInstall()) toast(t("install.thanks"));
                }}
              >
                <Download size={22} strokeWidth={1.75} /> {t("install.button")}
              </button>
            )}
            <ol className="card divide-y divide-line">
              <Step n={1} text={t("install.android1")} art={<Phone bar="top"><EllipsisVertical size={12} strokeWidth={2.5} className="text-brand" /></Phone>} />
              <Step n={2} text={t("install.android2")} art={<Phone bar="top"><Download size={12} strokeWidth={2.5} className="text-brand" /></Phone>} />
              <Step n={3} text={t("install.android3")} art={<Phone bar="bottom"><Plus size={14} strokeWidth={2.5} className="text-brand" /></Phone>} />
            </ol>
          </>
        ) : (
          <ol className="card divide-y divide-line">
            <Step n={1} text={t("install.ios1")} art={<Phone bar="bottom"><Share size={14} strokeWidth={2.25} className="text-info" /></Phone>} />
            <Step n={2} text={t("install.ios2")} art={<Phone bar="bottom"><SquarePlus size={14} strokeWidth={2.25} className="text-info" /></Phone>} />
            <Step n={3} text={t("install.ios3")} art={<Phone bar="top"><span className="text-[9px] font-semibold text-info">{t("install.add")}</span></Phone>} />
          </ol>
        )}
        <p className="mt-4 text-cap text-muted">{t("install.why")}</p>
      </Page>
    </>
  );
}

import { CircleAlert, Phone, UserRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError, errorMessage } from "../api/client";
import { isMockMode } from "../api/mode";
import { useSession } from "../app/session";
import { BrandMark } from "../components/BrandMark";
import { Keypad } from "../components/Keypad";
import { LangToggle } from "../components/LangToggle";
import { Spinner } from "../components/ui";
import { useT } from "../i18n";
import { haptic } from "../lib/haptics";

const PHONE_KEY = "arad.lastPhone";
const PIN_LEN = 4;

const fmtPhone = (p: string) => (p.length > 5 ? `${p.slice(0, 5)} ${p.slice(5)}` : p);

export function Login() {
  const t = useT();
  const { login } = useSession();
  const [phone, setPhone] = useState(() => {
    try {
      return localStorage.getItem(PHONE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [pin, setPin] = useState("");
  const [field, setField] = useState<"phone" | "pin">(() => (phone.length === 10 ? "pin" : "phone"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [shake, setShake] = useState(0);

  const submit = useCallback(
    async (ph: string, p: string) => {
      setBusy(true);
      setError(undefined);
      try {
        await login(ph, p);
        try {
          localStorage.setItem(PHONE_KEY, ph);
        } catch {
          /* ignore */
        }
      } catch (e) {
        haptic([30, 40, 30]);
        setShake((n) => n + 1);
        setPin("");
        setError(e instanceof ApiError && e.code === "bad_login" ? t("login.wrong") : e instanceof ApiError && e.isNetwork ? t("login.offline") : errorMessage(e));
        setBusy(false);
      }
    },
    [login, t],
  );

  const onKey = useCallback(
    (k: string) => {
      if (busy) return;
      setError(undefined);
      if (field === "phone") {
        const next = k === "back" ? phone.slice(0, -1) : phone.length < 10 ? phone + k : phone;
        setPhone(next);
        if (next.length === 10 && k !== "back") setField("pin");
      } else {
        if (k === "back") {
          if (!pin) setField("phone");
          setPin(pin.slice(0, -1));
          return;
        }
        if (pin.length >= PIN_LEN) return;
        const next = pin + k;
        setPin(next);
        if (next.length === PIN_LEN) void submit(phone, next);
      }
    },
    [busy, field, phone, pin, submit],
  );

  useEffect(() => {
    if (field === "pin" && phone.length !== 10) setField("phone");
  }, [field, phone]);

  const fill = (ph: string, p: string) => {
    setPhone(ph);
    setPin("");
    setField("pin");
    void submit(ph, p);
  };

  return (
    <div className="pt-safe pb-safe mx-auto flex min-h-dvh max-w-md flex-col px-4">
      <div className="flex items-center justify-end pt-3">
        <LangToggle />
      </div>
      <div className="flex flex-1 flex-col justify-center py-4">
        <div className="mb-6 flex items-center gap-3">
          <BrandMark size={48} />
          <div>
            <p className="text-title font-semibold">{t("app.name")}</p>
            <p className="text-body text-muted">{t("login.tagline")}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setField("phone")}
          aria-pressed={field === "phone"}
          className={`card mb-3 flex w-full items-center gap-3 px-4 py-3 text-left transition-[border-color,box-shadow] ${field === "phone" ? "border-brand shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand)_16%,transparent)]" : ""}`}
        >
          <Phone size={20} strokeWidth={1.75} className="text-muted" />
          <span className="flex-1">
            <span className="block text-cap text-muted">{t("login.phone")}</span>
            <span className="num block min-h-7 text-title font-semibold tracking-wide">
              {phone ? (
                <>
                  <span className="text-muted">+91 </span>
                  {fmtPhone(phone)}
                </>
              ) : (
                <span className="text-muted">{t("login.phonePlaceholder")}</span>
              )}
              {field === "phone" && <span className="ml-0.5 inline-block h-6 w-0.5 translate-y-1 animate-pulse bg-brand" aria-hidden />}
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={() => phone.length === 10 && setField("pin")}
          aria-pressed={field === "pin"}
          className={`card flex w-full items-center gap-3 px-4 py-3 text-left transition-[border-color,box-shadow] ${field === "pin" ? "border-brand shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand)_16%,transparent)]" : ""}`}
        >
          <UserRound size={20} strokeWidth={1.75} className="text-muted" />
          <span className="flex-1">
            <span className="block text-cap text-muted">{t("login.pin")}</span>
            <span key={shake} className={`flex h-7 items-center gap-3 ${shake ? "anim-nudge" : ""}`} aria-label={t("login.pinDigits", { n: pin.length })}>
              {Array.from({ length: PIN_LEN }, (_, i) => (
                <span key={i} className={`h-3.5 w-3.5 rounded-full transition-colors duration-150 ${i < pin.length ? "bg-text" : "border-2 border-line"}`} />
              ))}
            </span>
          </span>
          {busy && <Spinner className="text-brand" />}
        </button>

        <div className="min-h-12 pt-3" aria-live="assertive">
          {error && (
            <p className="flex items-center gap-2 text-body text-bad">
              <CircleAlert size={18} strokeWidth={1.75} />
              {error}
            </p>
          )}
        </div>

        {isMockMode() && (
          <div className="mb-2 rounded-[14px] border border-dashed border-line p-3">
            <p className="mb-2 text-cap text-muted">{t("login.demo")}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="chip" onClick={() => fill("9000000002", "1111")}>
                {t("login.demoStaff")}
              </button>
              <button type="button" className="chip" onClick={() => fill("9000000001", "1234")}>
                {t("login.demoOwner")}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="pb-4">
        <Keypad onKey={onKey} disabled={busy} />
        <p className="mt-3 text-center text-cap text-muted">{t("login.forgot")}</p>
      </div>
    </div>
  );
}

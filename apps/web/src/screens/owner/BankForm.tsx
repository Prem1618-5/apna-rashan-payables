// Deep import: only the validator, not the file generator (keeps this chunk small).
import { isValidIfsc } from "@arad/hdfc-bulk-file/src/validate";
import { CircleCheck, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { api, errorMessage } from "../../api/client";
import { useToast } from "../../components/toast";
import { BottomBar, Field, Header, Page, Spinner } from "../../components/ui";
import { useT } from "../../i18n";
import { invalidate, useResource } from "../../lib/resource";

const BANKS: Record<string, string> = {
  SBIN: "State Bank of India",
  HDFC: "HDFC Bank",
  ICIC: "ICICI Bank",
  UTIB: "Axis Bank",
  PUNB: "Punjab National Bank",
  BKID: "Bank of India",
  CNRB: "Canara Bank",
  BARB: "Bank of Baroda",
  UBIN: "Union Bank of India",
  KKBK: "Kotak Mahindra Bank",
  IDIB: "Indian Bank",
  YESB: "Yes Bank",
  CBIN: "Central Bank of India",
  IOBA: "Indian Overseas Bank",
  IDFB: "IDFC First Bank",
  INDB: "IndusInd Bank",
  JSFB: "Jana Small Finance Bank",
};

const clean = (s: string) => s.replace(/\s+/g, "").toUpperCase();

export default function BankForm({ id }: { id: string }) {
  const t = useT();
  const toast = useToast();
  const [, navigate] = useLocation();
  const vendor = useResource(`vendors:detail:${id}`, () => api.vendor(id));
  const [acct, setAcct] = useState("");
  const [acct2, setAcct2] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [bankName, setBankName] = useState("");
  const [branch, setBranch] = useState("");
  const [bene, setBene] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const a = clean(acct);
  const a2 = clean(acct2);
  const i = clean(ifsc);
  const acctBad = a.length > 0 && !/^[A-Z0-9]{6,25}$/.test(a);
  const acctUnusual = !acctBad && a.length > 0 && !/^\d{9,18}$/.test(a);
  const mismatch = a2.length > 0 && a !== a2;
  const ifscBad = i.length > 0 && !isValidIfsc(i);
  const guessedBank = i.length >= 4 ? BANKS[i.slice(0, 4)] : undefined;
  const hdfc = i.startsWith("HDFC");
  const ok = a && a2 && a === a2 && !acctBad && i && !ifscBad && (!hdfc || clean(bene));

  async function save() {
    setTouched(true);
    if (!ok) return;
    setBusy(true);
    try {
      await api.addBank(id, { accountNumber: a, accountNumberConfirm: a2, ifsc: i, bankName: bankName.trim() || guessedBank, branchName: branch.trim() || undefined, beneCode: clean(bene) || undefined });
      invalidate("vendors", "dashboard", "payables");
      toast(t("bankForm.saved"));
      navigate(`/vendors/${id}`, { replace: true });
    } catch (e) {
      toast(errorMessage(e), { kind: "bad" });
      setBusy(false);
    }
  }

  return (
    <>
      <Header title={t("bankForm.title")} sub={vendor.data?.name} back />
      <Page>
        <div className="mb-5 flex items-start gap-3 rounded-[12px] bg-warn-soft p-3 text-body">
          <ShieldAlert size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-warn" />
          <span>{t("bankForm.safety")}</span>
        </div>
        <form
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label={t("bankForm.account")} htmlFor="bf-acct" error={acctBad ? t("bankForm.accountBad") : touched && !a ? t("form.required") : undefined} hint={acctUnusual ? t("bankForm.accountUnusual") : undefined}>
            <input id="bf-acct" className="input num tracking-wider" value={acct} onChange={(e) => setAcct(e.target.value)} inputMode="numeric" autoComplete="off" autoCorrect="off" spellCheck={false} name="acct-new" aria-invalid={acctBad} />
          </Field>
          <Field label={t("bankForm.accountAgain")} htmlFor="bf-acct2" error={mismatch ? t("bankForm.mismatch") : touched && !a2 ? t("form.required") : undefined} hint={a2 && a === a2 ? t("bankForm.match") : t("bankForm.noPaste")}>
            <input
              id="bf-acct2"
              className="input num tracking-wider"
              value={acct2}
              onChange={(e) => setAcct2(e.target.value)}
              onPaste={(e) => {
                e.preventDefault();
                toast(t("bankForm.pasteBlocked"), { kind: "info" });
              }}
              onDrop={(e) => e.preventDefault()}
              inputMode="numeric"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              name="acct-confirm"
              aria-invalid={mismatch}
            />
          </Field>
          <Field
            label={t("bankForm.ifsc")}
            htmlFor="bf-ifsc"
            error={ifscBad ? t("bankForm.ifscBad") : touched && !i ? t("form.required") : undefined}
            hint={guessedBank && !ifscBad ? (
              <span className="inline-flex items-center gap-1 text-ok">
                <CircleCheck size={13} strokeWidth={2} /> {guessedBank}
              </span>
            ) : (
              t("bankForm.ifscHint")
            )}
          >
            <input id="bf-ifsc" className="input num uppercase tracking-wider" value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase())} autoCapitalize="characters" maxLength={11} aria-invalid={ifscBad} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("bankForm.bankName")} htmlFor="bf-bank">
              <input id="bf-bank" className="input" value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder={guessedBank} />
            </Field>
            <Field label={t("bankForm.branch")} htmlFor="bf-branch">
              <input id="bf-branch" className="input" value={branch} onChange={(e) => setBranch(e.target.value)} />
            </Field>
          </div>
          <Field label={t("bank.beneCode")} htmlFor="bf-bene" hint={hdfc ? t("bankForm.beneNeeded") : t("bankForm.beneHint")} error={touched && hdfc && !clean(bene) ? t("bankForm.beneNeeded") : undefined}>
            <input id="bf-bene" className="input num uppercase" value={bene} onChange={(e) => setBene(e.target.value)} autoCapitalize="characters" maxLength={13} />
          </Field>
          <button type="submit" hidden />
        </form>
        <p className="text-cap text-muted">{t("bankForm.approvalNote")}</p>
      </Page>
      <BottomBar>
        <button type="button" className="btn btn-primary btn-block min-h-14" onClick={() => void save()} disabled={busy}>
          {busy && <Spinner />} {t("bankForm.submit")}
        </button>
      </BottomBar>
    </>
  );
}

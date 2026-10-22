import type { VendorInput } from "@arad/core";
import { isValidGstin, normalizeGstin } from "@arad/core";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { api, errorMessage } from "../../api/client";
import { useToast } from "../../components/toast";
import { BottomBar, Field, Header, ListSkeleton, Page, Spinner } from "../../components/ui";
import { useT } from "../../i18n";
import { invalidate, useResource } from "../../lib/resource";

export default function VendorForm({ id }: { id?: string }) {
  const t = useT();
  const toast = useToast();
  const [, navigate] = useLocation();
  const existing = useResource(id ? `vendors:detail:${id}` : null, () => api.vendor(id!));
  const [f, setF] = useState<VendorInput & { terms: string }>({ name: "", terms: "15" });
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    const v = existing.data;
    if (v) setF({ name: v.name, tradeName: v.tradeName, gstin: v.gstin, pan: v.pan, phone: v.phone, email: v.email, terms: String(v.paymentTermsDays) });
  }, [existing.data]);

  const gstin = normalizeGstin(f.gstin);
  const gstinBad = !!gstin && !isValidGstin(gstin);
  const terms = Number(f.terms);
  const termsBad = !Number.isInteger(terms) || terms < 0 || terms > 180;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save() {
    setTouched(true);
    if (!f.name.trim() || gstinBad || termsBad) return;
    setBusy(true);
    const input: VendorInput = { name: f.name.trim(), tradeName: f.tradeName?.trim() || undefined, gstin, pan: f.pan?.trim() || undefined, phone: f.phone?.trim() || undefined, email: f.email?.trim() || undefined, paymentTermsDays: terms };
    try {
      const v = id ? await api.updateVendor(id, input) : await api.createVendor(input);
      invalidate("vendors", "dashboard");
      toast(id ? t("vendorForm.saved") : t("vendorForm.created"));
      navigate(id ? `/vendors/${v.id}` : `/vendors/${v.id}/bank`, { replace: true });
    } catch (e) {
      toast(errorMessage(e), { kind: "bad" });
      setBusy(false);
    }
  }

  if (id && !existing.data)
    return (
      <>
        <Header title={t("vendorForm.editTitle")} back />
        <Page>
          <ListSkeleton rows={3} />
        </Page>
      </>
    );

  return (
    <>
      <Header title={id ? t("vendorForm.editTitle") : t("vendorForm.newTitle")} back />
      <Page>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label={t("vendorForm.name")} htmlFor="vf-name" hint={t("vendorForm.nameHint")} error={touched && !f.name.trim() ? t("form.required") : undefined}>
            <input id="vf-name" className="input" value={f.name} onChange={set("name")} autoComplete="organization" aria-invalid={touched && !f.name.trim()} />
          </Field>
          <Field label={t("vendorForm.tradeName")} htmlFor="vf-trade">
            <input id="vf-trade" className="input" value={f.tradeName ?? ""} onChange={set("tradeName")} />
          </Field>
          <Field label={t("header.gstin")} htmlFor="vf-gstin" error={gstinBad ? t("header.gstinBad") : undefined} hint={gstin && !gstinBad ? t("header.gstinOk") : undefined}>
            <input id="vf-gstin" className="input num uppercase tracking-wide" value={f.gstin ?? ""} onChange={set("gstin")} autoCapitalize="characters" autoComplete="off" maxLength={15} aria-invalid={gstinBad} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("vendor.pan")} htmlFor="vf-pan">
              <input id="vf-pan" className="input num uppercase" value={f.pan ?? ""} onChange={set("pan")} autoCapitalize="characters" maxLength={10} />
            </Field>
            <Field label={t("vendor.terms")} htmlFor="vf-terms" error={termsBad ? t("vendorForm.termsBad") : undefined}>
              <input id="vf-terms" className="input num" value={f.terms} onChange={set("terms")} inputMode="numeric" aria-invalid={termsBad} />
            </Field>
          </div>
          <Field label={t("vendor.phone")} htmlFor="vf-phone">
            <input id="vf-phone" className="input num" value={f.phone ?? ""} onChange={set("phone")} inputMode="tel" autoComplete="tel" />
          </Field>
          <Field label={t("vendor.email")} htmlFor="vf-email">
            <input id="vf-email" className="input" type="email" value={f.email ?? ""} onChange={set("email")} autoComplete="email" />
          </Field>
          <button type="submit" hidden />
        </form>
      </Page>
      <BottomBar>
        <button type="button" className="btn btn-primary btn-block min-h-14" onClick={() => void save()} disabled={busy}>
          {busy && <Spinner />} {id ? t("vendorForm.save") : t("vendorForm.next")}
        </button>
      </BottomBar>
    </>
  );
}

import type { Role, StoreInput, UserInput } from "@arad/core";
import { isValidGstin, normalizeGstin } from "@arad/core";
import { Bot, ChevronRight, Database, Download, Landmark, LogOut, Plus, RotateCcw, ShieldCheck, Store as StoreIcon, UserRound, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { api, errorMessage } from "../api/client";
import { isMockMode } from "../api/mode";
import { useSession } from "../app/session";
import { LangToggle } from "../components/LangToggle";
import { useToast } from "../components/toast";
import { Amount, Badge, Field, Header, ICON, ListSkeleton, Page, Section, Sheet, Spinner } from "../components/ui";
import { useI18n } from "../i18n";
import { invalidate, useResource } from "../lib/resource";

export default function More() {
  const { t } = useI18n();
  const { me, stores, logout } = useSession();
  const [, navigate] = useLocation();
  const owner = me?.role === "owner";
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Header title={t("more.title")} />
      <Page>
        <div className="card flex items-center gap-3 p-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-soft text-brand">
            <UserRound size={24} strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-lead font-semibold">{me?.name}</p>
            <p className="num text-cap text-muted">
              +91 {me?.phone} · {t(owner ? "role.owner" : "role.staff")}
            </p>
          </div>
        </div>

        <Section title={t("more.language")}>
          <div className="card flex items-center justify-between gap-3 p-3 pl-4">
            <span className="text-body">{t("lang.label")}</span>
            <LangToggle />
          </div>
        </Section>

        <Section title={t("more.app")}>
          <div className="card divide-y divide-line overflow-hidden">
            <LinkRow icon={<Download {...ICON} />} label={t("more.install")} onClick={() => navigate("/more/install")} />
          </div>
        </Section>

        {owner ? <StoresSection /> : (
          <Section title={t("more.stores")}>
            <div className="card divide-y divide-line">
              {stores.filter((s) => me?.storeIds.includes(s.id)).map((s) => (
                <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                  <StoreIcon {...ICON} className="text-muted" />
                  <span className="flex-1">{s.name}</span>
                </div>
              ))}
            </div>
          </Section>
        )}
        {owner && <UsersSection />}
        {owner && <SettingsSection />}

        {isMockMode() && <MockSection />}

        <button
          type="button"
          className="btn btn-secondary btn-block mt-8 text-bad"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await logout();
          }}
        >
          {busy ? <Spinner /> : <LogOut {...ICON} />} {t("more.logout")}
        </button>
        <p className="num mt-4 text-center text-cap text-muted">
          {t("app.name")} v{__APP_VERSION__} · {__BUILD_TIME__}
        </p>
      </Page>
    </>
  );
}

function LinkRow({ icon, label, onClick, right }: { icon: ReactNode; label: string; onClick?: () => void; right?: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex min-h-14 w-full items-center gap-3 px-4 text-left active:bg-surface-2">
      <span className="text-muted">{icon}</span>
      <span className="flex-1 font-semibold">{label}</span>
      {right}
      <ChevronRight size={18} strokeWidth={1.75} className="text-muted" />
    </button>
  );
}

function StoresSection() {
  const { t } = useI18n();
  const toast = useToast();
  const { stores, reloadStores } = useSession();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<StoreInput>({ code: "", name: "", gstin: "", address: "" });
  const [busy, setBusy] = useState(false);
  const g = normalizeGstin(f.gstin);
  const gBad = !!g && !isValidGstin(g);
  const save = async () => {
    if (!f.name.trim() || !f.code.trim() || gBad) return;
    setBusy(true);
    try {
      await api.createStore({ ...f, gstin: g });
      await reloadStores();
      invalidate("dashboard");
      toast(t("stores.added"));
      setOpen(false);
      setF({ code: "", name: "", gstin: "", address: "" });
    } catch (e) {
      toast(errorMessage(e), { kind: "bad" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title={t("more.stores")}
      count={stores.length}
      action={
        <button type="button" className="btn btn-ghost min-h-8 px-2 text-body" onClick={() => setOpen(true)}>
          <Plus size={18} strokeWidth={1.75} /> {t("stores.add")}
        </button>
      }
    >
      <div className="card divide-y divide-line">
        {stores.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-4 py-3">
            <span className="num flex h-9 w-12 items-center justify-center rounded-[8px] bg-surface-2 text-cap font-semibold text-muted">{s.code}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{s.name}</span>
              <span className="num block truncate text-cap text-muted">{s.gstin}</span>
            </span>
          </div>
        ))}
      </div>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={t("stores.add")}
        footer={
          <button type="button" className="btn btn-primary btn-block" onClick={() => void save()} disabled={busy || !f.name.trim() || !f.code.trim() || gBad}>
            {busy && <Spinner />} {t("stores.save")}
          </button>
        }
      >
        <Field label={t("stores.name")} htmlFor="st-name">
          <input id="st-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-autofocus />
        </Field>
        <Field label={t("stores.code")} htmlFor="st-code" hint={t("stores.codeHint")}>
          <input id="st-code" className="input uppercase" value={f.code} maxLength={6} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
        </Field>
        <Field label={t("header.gstin")} htmlFor="st-gstin" error={gBad ? t("header.gstinBad") : undefined}>
          <input id="st-gstin" className="input num uppercase" value={f.gstin} maxLength={15} onChange={(e) => setF({ ...f, gstin: e.target.value })} />
        </Field>
        <Field label={t("stores.address")} htmlFor="st-addr">
          <input id="st-addr" className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </Field>
      </Sheet>
    </Section>
  );
}

function UsersSection() {
  const { t } = useI18n();
  const toast = useToast();
  const { stores } = useSession();
  const res = useResource("users", () => api.users());
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<UserInput>({ name: "", phone: "", pin: "", role: "staff", storeIds: [] });
  const [busy, setBusy] = useState(false);
  const phoneOk = /^[6-9]\d{9}$/.test(f.phone);
  const pinOk = /^\d{4}$/.test(f.pin);
  const save = async () => {
    if (!f.name.trim() || !phoneOk || !pinOk || (f.role === "staff" && !f.storeIds.length)) return;
    setBusy(true);
    try {
      await api.createUser(f);
      await res.reload();
      toast(t("users.added"));
      setOpen(false);
      setF({ name: "", phone: "", pin: "", role: "staff", storeIds: [] });
    } catch (e) {
      toast(errorMessage(e), { kind: "bad" });
    } finally {
      setBusy(false);
    }
  };
  const name = (id: string) => stores.find((s) => s.id === id)?.name ?? id;
  return (
    <Section
      title={t("more.users")}
      count={res.data?.length}
      action={
        <button type="button" className="btn btn-ghost min-h-8 px-2 text-body" onClick={() => setOpen(true)}>
          <Plus size={18} strokeWidth={1.75} /> {t("users.add")}
        </button>
      }
    >
      {!res.data ? (
        <ListSkeleton rows={3} />
      ) : (
        <div className="card divide-y divide-line">
          {res.data.map((u) => (
            <div key={u.id} className="flex items-center gap-3 px-4 py-3">
              <Users size={18} strokeWidth={1.75} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{u.name}</span>
                <span className="block truncate text-cap text-muted">
                  {u.role === "owner" ? t("users.allStores") : u.storeIds.map(name).join(", ")}
                </span>
              </span>
              <Badge tone={u.role === "owner" ? "brand" : "muted"}>{t(u.role === "owner" ? "role.owner" : "role.staff")}</Badge>
            </div>
          ))}
        </div>
      )}
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={t("users.add")}
        footer={
          <button type="button" className="btn btn-primary btn-block" onClick={() => void save()} disabled={busy}>
            {busy && <Spinner />} {t("users.save")}
          </button>
        }
      >
        <Field label={t("users.name")} htmlFor="u-name">
          <input id="u-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-autofocus />
        </Field>
        <Field label={t("login.phone")} htmlFor="u-phone" error={f.phone && !phoneOk ? t("users.phoneBad") : undefined}>
          <input id="u-phone" className="input num" inputMode="numeric" maxLength={10} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, "") })} />
        </Field>
        <Field label={t("users.pin")} htmlFor="u-pin" hint={t("users.pinHint")} error={f.pin && !pinOk ? t("users.pinBad") : undefined}>
          <input id="u-pin" className="input num tracking-[0.4em]" inputMode="numeric" maxLength={4} value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, "") })} autoComplete="off" />
        </Field>
        <p className="label">{t("users.role")}</p>
        <div className="mb-4 flex gap-2">
          {(["staff", "owner"] as Role[]).map((r) => (
            <button key={r} type="button" className="chip" aria-pressed={f.role === r} onClick={() => setF({ ...f, role: r })}>
              {t(r === "owner" ? "role.owner" : "role.staff")}
            </button>
          ))}
        </div>
        {f.role === "staff" && (
          <>
            <p className="label">{t("users.stores")}</p>
            <div className="flex flex-wrap gap-2">
              {stores.map((s) => {
                const on = f.storeIds.includes(s.id);
                return (
                  <button key={s.id} type="button" className="chip" aria-pressed={on} onClick={() => setF({ ...f, storeIds: on ? f.storeIds.filter((x) => x !== s.id) : [...f.storeIds, s.id] })}>
                    {s.name}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </Sheet>
    </Section>
  );
}

function SettingsSection() {
  const { t } = useI18n();
  const res = useResource("settings", () => api.settings(), { staleMs: 300_000 });
  const s = res.data;
  return (
    <>
      <Section title={t("settings.ai")}>
        {!s ? (
          <ListSkeleton rows={2} />
        ) : (
          <div className="card divide-y divide-line">
            {s.aiProviders.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                <Bot size={18} strokeWidth={1.75} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{p.id}</span>
                  <span className="block truncate text-cap text-muted">
                    {[p.model, t("settings.keys", { n: p.keys }), p.trainsOnInput ? t("settings.trains") : t("settings.noTrain"), p.allowedForRealData ? t("settings.realOk") : t("settings.realBlocked")].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <Badge tone={p.enabled ? "ok" : "muted"}>{p.enabled ? t("settings.on") : t("settings.off")}</Badge>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title={t("settings.hdfc")}>
        {!s ? (
          <ListSkeleton rows={2} />
        ) : (
          <div className="card divide-y divide-line">
            {[
              [<Landmark key="i" size={18} strokeWidth={1.75} />, t("settings.clientCode"), <span key="v" className="num font-semibold">{s.hdfcClientCode ?? "–"}</span>],
              [<Landmark key="i" size={18} strokeWidth={1.75} />, t("settings.rtgsFrom"), <Amount key="v" paise={s.rtgsFromPaise} strong />],
              [<ShieldCheck key="i" size={18} strokeWidth={1.75} />, t("settings.cooling"), <span key="v" className="num font-semibold">{t("settings.hours", { n: s.coolingOffHours })}</span>],
              [<ShieldCheck key="i" size={18} strokeWidth={1.75} />, t("settings.twoPerson"), <span key="v" className="font-semibold">{s.requireDifferentApprover ? t("settings.yes") : t("settings.no")}</span>],
            ].map(([icon, k, v], i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <span className="text-muted">{icon}</span>
                <span className="flex-1 text-body">{k}</span>
                {v}
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 px-1 text-cap text-muted">{t("settings.readOnly")}</p>
      </Section>
    </>
  );
}

function MockSection() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <Section title={t("mock.title")}>
      <div className="card p-4">
        <p className="flex items-start gap-2 text-body text-muted">
          <Database size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" />
          {t("mock.text")}
        </p>
        <button
          type="button"
          className="btn btn-secondary btn-block mt-3"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const m = await import("../api/mock");
            m.resetMock();
            location.href = "/";
          }}
        >
          <RotateCcw {...ICON} /> {t("mock.reset")}
        </button>
      </div>
    </Section>
  );
}

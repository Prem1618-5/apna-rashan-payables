import { FileText, House, Menu, Store as StoreIcon, Wallet, WifiOff } from "lucide-react";
import { Component, lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Route, Switch, useLocation } from "wouter";
import { startOutbox } from "./app/outbox";
import { SessionProvider, useSession } from "./app/session";
import { BrandMark } from "./components/BrandMark";
import { ToastProvider } from "./components/toast";
import { Spinner } from "./components/ui";
import { LangProvider, translate, useT, type MessageKey } from "./i18n";
import { Home } from "./screens/Home";
import { Login } from "./screens/Login";

const Capture = lazy(() => import("./screens/capture/Capture"));
const Verify = lazy(() => import("./screens/verify/Verify"));
const Dashboard = lazy(() => import("./screens/owner/Dashboard"));
const Bills = lazy(() => import("./screens/owner/Bills"));
const BillDetail = lazy(() => import("./screens/owner/BillDetail"));
const Vendors = lazy(() => import("./screens/owner/Vendors"));
const VendorDetail = lazy(() => import("./screens/owner/VendorDetail"));
const VendorForm = lazy(() => import("./screens/owner/VendorForm"));
const BankForm = lazy(() => import("./screens/owner/BankForm"));
const Pay = lazy(() => import("./screens/owner/Pay"));
const Runs = lazy(() => import("./screens/owner/Runs"));
const RunDetail = lazy(() => import("./screens/owner/RunDetail"));
const More = lazy(() => import("./screens/More"));
const Install = lazy(() => import("./screens/Install"));

export function App() {
  return (
    <LangProvider>
      <ToastProvider>
        <ErrorBoundary>
          <SessionProvider>
            <Root />
          </SessionProvider>
        </ErrorBoundary>
      </ToastProvider>
    </LangProvider>
  );
}

function Root() {
  const { me } = useSession();
  useEffect(() => {
    if (me) startOutbox();
  }, [me]);
  if (me === undefined) return <Splash />;
  if (me === null) return <Login />;
  return <Shell />;
}

function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <BrandMark size={64} className="anim-fade" />
    </div>
  );
}

function Fallback() {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center text-muted">
      <Spinner size={28} />
    </div>
  );
}

interface Tab {
  href: string;
  key: MessageKey;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}
const STAFF_TABS: Tab[] = [
  { href: "/", key: "tab.home", icon: House },
  { href: "/bills", key: "tab.bills", icon: FileText },
  { href: "/more", key: "tab.more", icon: Menu },
];
const OWNER_TABS: Tab[] = [
  { href: "/", key: "tab.home", icon: House },
  { href: "/bills", key: "tab.bills", icon: FileText },
  { href: "/pay", key: "tab.pay", icon: Wallet },
  { href: "/vendors", key: "tab.vendors", icon: StoreIcon },
  { href: "/more", key: "tab.more", icon: Menu },
];

function Shell() {
  const { me } = useSession();
  const [location] = useLocation();
  const owner = me?.role === "owner";
  const tabs = owner ? OWNER_TABS : STAFF_TABS;
  const showTabs = tabs.some((t) => t.href === location);
  return (
    <div className="min-h-dvh">
      <OfflineBanner />
      <Suspense fallback={<Fallback />}>
        <Switch>
          <Route path="/">{owner ? <Dashboard /> : <Home />}</Route>
          <Route path="/capture" component={Capture} />
          <Route path="/home">
            <Home />
          </Route>
          <Route path="/verify/:id">{(p) => <Verify id={p.id} />}</Route>
          <Route path="/bills" component={Bills} />
          <Route path="/bills/:id">{(p) => <BillDetail id={p.id} />}</Route>
          <Route path="/vendors" component={Vendors} />
          <Route path="/vendors/new">
            <VendorForm />
          </Route>
          <Route path="/vendors/:id/edit">{(p) => <VendorForm id={p.id} />}</Route>
          <Route path="/vendors/:id/bank">{(p) => <BankForm id={p.id} />}</Route>
          <Route path="/vendors/:id">{(p) => <VendorDetail id={p.id} />}</Route>
          {owner && <Route path="/pay" component={Pay} />}
          {owner && <Route path="/runs" component={Runs} />}
          {owner && <Route path="/runs/:id">{(p) => <RunDetail id={p.id} />}</Route>}
          <Route path="/more" component={More} />
          <Route path="/more/install" component={Install} />
          <Route>
            <NotFound />
          </Route>
        </Switch>
      </Suspense>
      {showTabs && <TabBar tabs={tabs} />}
    </div>
  );
}

function TabBar({ tabs }: { tabs: Tab[] }) {
  const t = useT();
  const [location, navigate] = useLocation();
  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur" aria-label={t("tab.label")}>
      <ul className="mx-auto flex h-16 max-w-2xl">
        {tabs.map((tab) => {
          const active = location === tab.href;
          const Icon = tab.icon;
          return (
            <li key={tab.href} className="flex-1">
              <button
                type="button"
                onClick={() => navigate(tab.href)}
                aria-current={active ? "page" : undefined}
                className={`flex h-full w-full flex-col items-center justify-center gap-0.5 text-[12px] leading-4 font-semibold transition-colors ${active ? "text-brand" : "text-muted"}`}
              >
                <span className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors ${active ? "bg-brand-soft" : ""}`}>
                  <Icon size={22} strokeWidth={active ? 2 : 1.75} />
                </span>
                <span className="max-w-full truncate px-1">{t(tab.key)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function OfflineBanner() {
  const t = useT();
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return (
    <>
      {!online && (
        <div className="pt-safe sticky top-0 z-[45] bg-text text-bg" role="status">
          <div className="mx-auto flex max-w-2xl items-center gap-2 px-4 py-2 text-cap font-semibold">
            <WifiOff size={16} strokeWidth={2} />
            {t("offline.banner")}
          </div>
        </div>
      )}
    </>
  );
}

function NotFound() {
  const t = useT();
  const [, navigate] = useLocation();
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-title font-semibold">{t("common.notFound")}</p>
      <button type="button" className="btn btn-primary" onClick={() => navigate("/")}>
        {t("common.goHome")}
      </button>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    let lang: "en" | "hi" = "en";
    try {
      lang = localStorage.getItem("arad.lang") === "hi" ? "hi" : "en";
    } catch {
      /* ignore */
    }
    const isChunk = /dynamically imported module|Loading chunk|Importing a module script failed/i.test(this.state.error.message);
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center" role="alert">
        <BrandMark size={48} />
        <p className="mt-2 text-title font-semibold">{translate(lang, isChunk ? "error.update" : "error.title")}</p>
        <p className="max-w-xs text-body text-muted">{translate(lang, "error.text")}</p>
        <button type="button" className="btn btn-primary mt-2" onClick={() => location.reload()}>
          {translate(lang, "error.reload")}
        </button>
      </div>
    );
  }
}

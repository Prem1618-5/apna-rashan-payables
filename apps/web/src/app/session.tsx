import type { Lang, Me, Store } from "@arad/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, setUnauthorizedHandler } from "../api/client";
import { useI18n } from "../i18n";
import { clearCache } from "../lib/resource";

const ME_KEY = "arad.me";
const STORE_KEY = "arad.store";

interface Cached {
  me: Me;
  stores: Store[];
}
function readCache(): Cached | undefined {
  try {
    const raw = localStorage.getItem(ME_KEY);
    return raw ? (JSON.parse(raw) as Cached) : undefined;
  } catch {
    return undefined;
  }
}
function writeCache(c: Cached | undefined) {
  try {
    if (c) localStorage.setItem(ME_KEY, JSON.stringify(c));
    else localStorage.removeItem(ME_KEY);
  } catch {
    /* ignore */
  }
}

interface SessionCtx {
  /** undefined while checking, null when logged out. */
  me: Me | null | undefined;
  stores: Store[];
  storeId: string | undefined;
  store: Store | undefined;
  setStoreId: (id: string) => void;
  login: (phone: string, pin: string) => Promise<Me>;
  logout: () => Promise<void>;
  changeLang: (l: Lang) => void;
  reloadStores: () => Promise<void>;
}
const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const { lang, setLang } = useI18n();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreIdState] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem(STORE_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  });

  const setStoreId = useCallback((id: string) => {
    setStoreIdState(id);
    try {
      localStorage.setItem(STORE_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  const loadStores = useCallback(async (m: Me) => {
    const s = await api.stores();
    setStores(s);
    writeCache({ me: m, stores: s });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      writeCache(undefined);
      clearCache();
      setMe(null);
    });
    api
      .me()
      .then(async (m) => {
        setMe(m);
        await loadStores(m).catch(() => {});
      })
      .catch((e: unknown) => {
        // Offline start: keep working (capture queues locally) with the last known session.
        const cached = readCache();
        if (e instanceof ApiError && e.isNetwork && cached) {
          setMe(cached.me);
          setStores(cached.stores);
        } else setMe(null);
      });
  }, [loadStores]);

  // Keep the chosen store valid for this person.
  useEffect(() => {
    if (!me) return;
    const mine = stores.filter((s) => me.role === "owner" || me.storeIds.includes(s.id));
    if (mine.length && (!storeId || !mine.some((s) => s.id === storeId))) setStoreId(mine[0]!.id);
  }, [me, stores, storeId, setStoreId]);

  const login = useCallback(
    async (phone: string, pin: string) => {
      const m = await api.login({ phone, pin });
      clearCache();
      setMe(m);
      if (m.lang !== lang) void api.setLang(lang).catch(() => {});
      await loadStores(m).catch(() => {});
      return m;
    },
    [lang, loadStores],
  );

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    writeCache(undefined);
    clearCache();
    setMe(null);
  }, []);

  const changeLang = useCallback(
    (l: Lang) => {
      setLang(l);
      if (me) void api.setLang(l).then(setMe).catch(() => {});
    },
    [me, setLang],
  );

  const value = useMemo<SessionCtx>(
    () => ({
      me,
      stores,
      storeId,
      store: stores.find((s) => s.id === storeId),
      setStoreId,
      login,
      logout,
      changeLang,
      reloadStores: () => (me ? loadStores(me) : Promise.resolve()),
    }),
    [me, stores, storeId, setStoreId, login, logout, changeLang, loadStores],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession outside SessionProvider");
  return c;
}

/** Session for screens that only render when logged in. */
export function useMe(): Me {
  const { me } = useSession();
  if (!me) throw new Error("not logged in");
  return me;
}

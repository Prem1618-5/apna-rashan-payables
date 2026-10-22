/** Tiny stale-while-revalidate data hook: cached by key, shared across screens, invalidated after changes. */
import { useCallback, useEffect, useRef, useState } from "react";

interface Entry {
  data?: unknown;
  error?: unknown;
  at: number;
  promise?: Promise<unknown>;
}
const cache = new Map<string, Entry>();
const subs = new Map<string, Set<() => void>>();

function notify(key: string) {
  subs.get(key)?.forEach((f) => f());
}

/** Drop cached data whose key starts with any prefix, and refetch what's on screen. */
export function invalidate(...prefixes: string[]) {
  for (const key of [...cache.keys()]) {
    if (prefixes.some((p) => key.startsWith(p))) {
      const e = cache.get(key)!;
      e.at = 0;
      notify(key);
    }
  }
}

/** Put fresh data in the cache (e.g. a mutation returned the new object). */
export function setCached<T>(key: string, data: T) {
  cache.set(key, { data, at: Date.now() });
  notify(key);
}

export function clearCache() {
  cache.clear();
}

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  mutate: (data: T) => void;
}

export function useResource<T>(key: string | null, fetcher: () => Promise<T>, opts: { pollMs?: number; staleMs?: number } = {}): Resource<T> {
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const [, force] = useState(0);
  const staleMs = opts.staleMs ?? 15_000;

  const load = useCallback(
    async (k: string) => {
      let e = cache.get(k);
      if (!e) {
        e = { at: 0 };
        cache.set(k, e);
      }
      if (e.promise) return void (await e.promise.catch(() => {}));
      const p = fetchRef.current();
      e.promise = p;
      notify(k);
      try {
        e.data = await p;
        e.error = undefined;
        e.at = Date.now();
      } catch (err) {
        e.error = err;
        e.at = Date.now();
      } finally {
        e.promise = undefined;
        notify(k);
      }
    },
    [],
  );

  useEffect(() => {
    if (!key) return;
    const rerender = () => {
      force((n) => n + 1);
      const e = cache.get(key);
      if (e && e.at === 0 && !e.promise) void load(key);
    };
    let set = subs.get(key);
    if (!set) subs.set(key, (set = new Set()));
    set.add(rerender);
    const e = cache.get(key);
    if (!e || Date.now() - e.at > staleMs) void load(key);
    let timer: ReturnType<typeof setInterval> | undefined;
    if (opts.pollMs) {
      timer = setInterval(() => {
        if (document.visibilityState === "visible") void load(key);
      }, opts.pollMs);
    }
    return () => {
      set!.delete(rerender);
      if (timer) clearInterval(timer);
    };
  }, [key, load, opts.pollMs, staleMs]);

  const e = key ? cache.get(key) : undefined;
  return {
    data: e?.data as T | undefined,
    error: e?.data === undefined ? e?.error : undefined,
    loading: !!key && (!e || (e.data === undefined && e.error === undefined) || (!!e.promise && e.data === undefined)),
    reload: () => (key ? load(key) : Promise.resolve()),
    mutate: (data: T) => key && setCached(key, data),
  };
}

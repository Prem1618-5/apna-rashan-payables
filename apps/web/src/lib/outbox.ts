/**
 * Offline-first capture outbox. A capture is written to IndexedDB *before* the UI says "saved",
 * then uploaded when there is signal (app open, back online, app brought to front), with backoff.
 * Items are only deleted after the server confirms; a rejected item stays until a person discards it.
 */
import type { CaptureResponse } from "@arad/core";
import { idb, STORES } from "./idb";

export interface OutboxPage {
  type: string;
  /** Stored as ArrayBuffer (not Blob) because older iOS Safari could not keep Blobs in IndexedDB. */
  data: ArrayBuffer;
  bytes: number;
}
export interface OutboxItem {
  clientId: string;
  storeId: string;
  createdAt: string;
  pages: OutboxPage[];
  qr: string[];
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  /** The server refused it in a way that retrying will not fix. */
  stuck?: boolean;
}
export type OutboxMeta = Omit<OutboxItem, "pages"> & { pageCount: number; bytes: number; uploading: boolean };

export interface UploadError extends Error {
  status?: number;
}

export interface OutboxDeps {
  upload: (item: { storeId: string; clientId: string; qr: string[]; pages: Blob[] }) => Promise<CaptureResponse>;
  now?: () => number;
  isOnline?: () => boolean;
  onUploaded?: (item: OutboxMeta, res: CaptureResponse) => void;
  newId?: () => string;
}

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 10 * 60_000;
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/** 4xx means "fix it" unless it's auth/timeouts/rate limits, which can succeed later. */
export function isPermanent(status: number | undefined): boolean {
  return !!status && status >= 400 && status < 500 && ![401, 403, 408, 425, 429].includes(status);
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // RFC 4122 v4 fallback for very old browsers
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function createOutbox(deps: OutboxDeps) {
  const now = deps.now ?? Date.now;
  const online = deps.isOnline ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  let items: OutboxMeta[] = [];
  const uploading = new Set<string>();
  const listeners = new Set<(items: OutboxMeta[]) => void>();
  let draining: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loaded = false;

  const meta = (i: OutboxItem): OutboxMeta => {
    const { pages, ...rest } = i;
    return { ...rest, pageCount: pages.length, bytes: pages.reduce((s, p) => s + p.bytes, 0), uploading: uploading.has(i.clientId) };
  };
  const emit = () => listeners.forEach((f) => f(items));

  async function refresh() {
    const all = await idb.getAll<OutboxItem>(STORES.outbox);
    items = all.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(meta);
    loaded = true;
    emit();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    const next = items.filter((i) => !i.stuck).reduce((m, i) => Math.min(m, i.nextAttemptAt), Infinity);
    if (next === Infinity) return;
    timer = setTimeout(() => void drain(), Math.max(1000, next - now()));
  }

  async function uploadOne(item: OutboxItem) {
    uploading.add(item.clientId);
    await refresh();
    try {
      const res = await deps.upload({
        storeId: item.storeId,
        clientId: item.clientId,
        qr: item.qr,
        pages: item.pages.map((p) => new Blob([p.data], { type: p.type })),
      });
      await idb.delete(STORES.outbox, item.clientId);
      uploading.delete(item.clientId);
      deps.onUploaded?.(meta(item), res);
    } catch (e) {
      uploading.delete(item.clientId);
      const err = e as UploadError;
      const attempts = item.attempts + 1;
      const stuck = isPermanent(err.status);
      await idb.put<OutboxItem>(STORES.outbox, {
        ...item,
        attempts,
        stuck,
        lastError: err.message || "Upload failed",
        nextAttemptAt: now() + backoffMs(attempts) * (0.85 + Math.random() * 0.3),
      });
      // No connection (or server unreachable): stop the loop; 'online' or the backoff timer wakes us.
      if (!online() || !err.status) throw e;
    }
  }

  async function drainOnce(force = false) {
    if (!online()) return;
    const all = (await idb.getAll<OutboxItem>(STORES.outbox)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const item of all) {
      if (item.stuck && !force) continue;
      if (!force && item.nextAttemptAt > now()) continue;
      try {
        await uploadOne(item);
      } catch {
        break;
      }
    }
  }

  /** Upload everything that is due. Safe to call often; runs one at a time. */
  function drain(force = false): Promise<void> {
    if (!draining) {
      draining = drainOnce(force)
        .catch(() => {})
        .finally(async () => {
          draining = undefined;
          await refresh().catch(() => {});
          schedule();
        });
    }
    return draining;
  }

  return {
    /** Saves the capture durably, then starts uploading. Resolves once it is safely on the phone. */
    async add(input: { storeId: string; pages: Blob[]; qr: string[] }): Promise<OutboxMeta> {
      const pages: OutboxPage[] = [];
      for (const p of input.pages) pages.push({ type: p.type || "image/jpeg", data: await p.arrayBuffer(), bytes: p.size });
      const item: OutboxItem = { clientId: (deps.newId ?? uuid)(), storeId: input.storeId, createdAt: new Date(now()).toISOString(), pages, qr: input.qr, attempts: 0, nextAttemptAt: 0 };
      await idb.put(STORES.outbox, item);
      await refresh();
      void drain();
      return meta(item);
    },
    drain,
    /** Try one item now, ignoring backoff (and the "stuck" mark). */
    async retry(clientId: string) {
      const item = await idb.get<OutboxItem>(STORES.outbox, clientId);
      if (!item) return;
      await idb.put<OutboxItem>(STORES.outbox, { ...item, stuck: false, nextAttemptAt: 0 });
      await refresh();
      return drain();
    },
    /** Only when a person explicitly throws a capture away. */
    async discard(clientId: string) {
      await idb.delete(STORES.outbox, clientId);
      await refresh();
    },
    async firstPage(clientId: string): Promise<Blob | undefined> {
      const item = await idb.get<OutboxItem>(STORES.outbox, clientId);
      const p = item?.pages[0];
      return p ? new Blob([p.data], { type: p.type }) : undefined;
    },
    refresh,
    get items() {
      return items;
    },
    get loaded() {
      return loaded;
    },
    subscribe(fn: (items: OutboxMeta[]) => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    stop() {
      if (timer) clearTimeout(timer);
    },
  };
}

export type Outbox = ReturnType<typeof createOutbox>;

/** Ask the browser not to evict our storage (iOS/Android may still say no). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

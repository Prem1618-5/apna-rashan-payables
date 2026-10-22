/** Smallest useful IndexedDB wrapper: one database, a few key-path object stores. */

const DB_NAME = "arad";
const DB_VERSION = 1;
export const STORES = { outbox: "outbox" } as const;

let dbPromise: Promise<IDBDatabase> | undefined;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function openDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const open = factory.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(STORES.outbox)) db.createObjectStore(STORES.outbox, { keyPath: "clientId" });
      };
      open.onsuccess = () => {
        const db = open.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = undefined;
        };
        resolve(db);
      };
      open.onerror = () => {
        dbPromise = undefined;
        reject(open.error);
      };
      open.onblocked = () => reject(new Error("storage blocked by another tab"));
    });
  }
  return dbPromise;
}

/** For tests: forget the open connection. */
export function resetDbConnection() {
  dbPromise = undefined;
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    let result: T;
    r.onsuccess = () => (result = r.result);
    // Resolve only when the transaction has committed, so "saved" really means saved.
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error ?? r.error);
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
  });
}

export const idb = {
  getAll: <T>(store: string) => tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>),
  get: <T>(store: string, key: IDBValidKey) => tx<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>),
  put: <T>(store: string, value: T) => tx(store, "readwrite", (s) => s.put(value)),
  delete: (store: string, key: IDBValidKey) => tx(store, "readwrite", (s) => s.delete(key)),
  req,
};

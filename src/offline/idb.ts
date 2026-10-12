/** Tiny promise wrapper over IndexedDB (no dependency). */
const DB_NAME = 'vendora-offline';
const DB_VERSION = 1;
export const STORES = { queue: 'sale_queue', cache: 'cache' } as const;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.queue)) {
        const s = db.createObjectStore(STORES.queue, { keyPath: 'opId' });
        s.createIndex('businessId', 'businessId');
      }
      if (!db.objectStoreNames.contains(STORES.cache)) db.createObjectStore(STORES.cache);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut(store: string, value: unknown, key?: IDBValidKey) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  await wrap(key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key));
}

export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function idbDelete(store: string, key: IDBValidKey) {
  const db = await openDb();
  await wrap(db.transaction(store, 'readwrite').objectStore(store).delete(key));
}

export async function idbAllByIndex<T>(store: string, index: string, value: IDBValidKey): Promise<T[]> {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).index(index).getAll(value)) as Promise<T[]>;
}

/** For tests */
export function _resetDbHandle() {
  dbPromise = null;
}

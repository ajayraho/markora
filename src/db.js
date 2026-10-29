// Tiny IndexedDB wrapper — Markora's library of notes + recent files.
// IndexedDB (not localStorage) because it's async, holds far more data,
// and can store FileSystemFileHandles so disk files can be reopened later.

const DB_NAME = "markora";
const VERSION = 1;
export const MAX_ITEMS = 200;             // library cap (notes + recent files)
export const MAX_TEXT = 2 * 1024 * 1024;  // don't cache texts larger than ~2 MB

let dbp;
function open() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

export const db = {
  all: () => tx("docs", "readonly", (s) => s.getAll()),
  get: (id) => tx("docs", "readonly", (s) => s.get(id)),
  put: (doc) => tx("docs", "readwrite", (s) => s.put(doc)),
  // Deleting a synced note leaves a tombstone so the sync engine trashes it in Drive too
  del: async (id, { fromSync = false } = {}) => {
    if (!fromSync) {
      const r = await db.get(id).catch(() => null);
      if (r?.remoteId) {
        const meta = (await db.getMeta("sync").catch(() => null)) || {};
        await db.setMeta("sync", { ...meta, tombstones: [...(meta.tombstones || []), r.remoteId] });
      }
    }
    return tx("docs", "readwrite", (s) => s.delete(id));
  },
  getMeta: (k) => tx("meta", "readonly", (s) => s.get(k)),
  setMeta: (k, v) => tx("meta", "readwrite", (s) => s.put(v, k)),
};

// Ask the browser not to evict our storage under pressure (best effort)
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}

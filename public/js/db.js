/**
 * FR-10：結果を IndexedDB に保存する。
 * サーバが落ちていても、一度開いたジョブは閲覧できる（オフライン時は閲覧のみ）。
 */
const DB_NAME = 'koe-note';
const DB_VERSION = 1;
const STORE = 'jobs';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    const request = fn(store);
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
  })).catch(() => null); // IndexedDB が使えない環境でも本体は動かす
}

export const cache = {
  put: (payload) => tx('readwrite', (store) => store.put({ ...payload, cachedAt: Date.now() })),
  get: (id) => tx('readonly', (store) => store.get(id)),
  all: () => tx('readonly', (store) => store.getAll()),
  remove: (id) => tx('readwrite', (store) => store.delete(id)),
};

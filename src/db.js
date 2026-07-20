const DB_NAME = "pabbly_code_extractor";
const DB_VERSION = 1;
const STORE = "results";

let dbPromise = null;

const open = () => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("runId", "runId", { unique: false });
        store.createIndex("failed", "failed", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
};

const request = async (mode, fn) => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    if (!req) {
      t.oncomplete = () => resolve();
      return;
    }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
};

export const putResult = (record) =>
  request("readwrite", (s) => s.put({ ...record, failed: record.error ? 1 : 0 }));

export const getAllResults = () => request("readonly", (s) => s.getAll());

export const countResults = () => request("readonly", (s) => s.count());

export const clearResults = () => request("readwrite", (s) => s.clear());

export const getFailedResults = async () => (await getAllResults()).filter((r) => r.error);

export const getResultsForRun = async (runId) =>
  runId ? (await getAllResults()).filter((r) => r.runId === runId) : getAllResults();

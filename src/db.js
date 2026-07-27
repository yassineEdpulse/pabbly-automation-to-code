const DB_NAME = "pabbly_code_extractor";
const DB_VERSION = 2;
const STORE = "results";

let dbPromise = null;

// Pabbly workflow ids and Zapier Zap ids are both opaque strings and can collide, so the stored key
// is namespaced by platform while `nativeId` keeps the id the platform itself uses for navigation.
export const recordId = (platform, nativeId) => `${platform || "pabbly"}:${nativeId}`;

const open = () => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      let store;

      if (!db.objectStoreNames.contains(STORE)) {
        store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("runId", "runId", { unique: false });
        store.createIndex("failed", "failed", { unique: false });
      } else {
        store = req.transaction.objectStore(STORE);
      }

      if (!store.indexNames.contains("platform")) {
        store.createIndex("platform", "platform", { unique: false });
      }

      // v1 rows predate multi-platform support. They are all Pabbly, and their bare ids would now
      // collide with a Zapier id, so re-key them rather than leaving two id schemes in one store.
      if (event.oldVersion > 0 && event.oldVersion < 2) {
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const rec = cursor.value;
          if (!rec.platform) {
            cursor.delete();
            store.put({ ...rec, platform: "pabbly", nativeId: rec.id, id: recordId("pabbly", rec.id) });
          }
          cursor.continue();
        };
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

export const putResult = (record) => {
  const platform = record.platform || "pabbly";
  const nativeId = record.nativeId != null ? record.nativeId : record.id;
  return request("readwrite", (s) =>
    s.put({ ...record, platform, nativeId, id: recordId(platform, nativeId), failed: record.error ? 1 : 0 })
  );
};

const allRows = () => request("readonly", (s) => s.getAll());

export const getAllResults = async (platform) => {
  const rows = await allRows();
  if (!platform) return rows;
  return rows.filter((r) => (r.platform || "pabbly") === platform);
};

export const countResults = () => request("readonly", (s) => s.count());

export const clearResults = () => request("readwrite", (s) => s.clear());

export const getFailedResults = async (platform) => (await getAllResults(platform)).filter((r) => r.error);

export const getResultsForRun = async (runId) =>
  runId ? (await allRows()).filter((r) => r.runId === runId) : allRows();

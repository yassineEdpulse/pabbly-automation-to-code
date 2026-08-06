// Which workflows the rewrite pass has already handled.
//
// An ES module, imported by background.js and popup.js. Backed by chrome.storage.local so it survives
// a service-worker restart, a browser restart, and the gap between a scan run and a later apply run.
//
// This exists because the Task History table is a run log, not a workflow list: 24k rows over 15 days
// for on the order of a hundred distinct workflows. A workflow fixed on page 1 keeps reappearing on
// page 900 from an execution days earlier. Without a durable record, paging deeper re-opens, re-writes
// and re-saves workflows that were already done — which is both wasted hours and needless writes to a
// live account. With it, the crawler can stop as soon as pages stop yielding unseen ids.
//
// Every visit is recorded, not just the ones that changed something: a workflow scanned and found
// clean must not be revisited either, or the pass never converges.
const KEY = "rewrite_ledger";
const MAX_ENTRIES = 5000;

export const OUTCOMES = {
  fixed: "fixed",
  clean: "clean",
  failed: "failed",
  skipped: "skipped"
};

const readAll = async () => {
  try {
    const store = await chrome.storage.local.get(KEY);
    const led = store[KEY];
    return led && typeof led === "object" ? led : {};
  } catch (_) {
    return {};
  }
};

const writeAll = async (led) => {
  try {
    await chrome.storage.local.set({ [KEY]: led });
  } catch (_) {}
};

export const readLedger = readAll;

export const isProcessed = async (id) => {
  if (!id) return false;
  const led = await readAll();
  return Object.prototype.hasOwnProperty.call(led, id);
};

// A failed visit is deliberately NOT treated as processed: a workflow that errored should be retried
// on the next pass, whereas one that was fixed or found clean should never be opened again.
export const isSettled = async (id) => {
  if (!id) return false;
  const entry = (await readAll())[id];
  if (!entry) return false;
  return entry.outcome === OUTCOMES.fixed || entry.outcome === OUTCOMES.clean;
};

export const settledIds = async () => {
  const led = await readAll();
  return new Set(
    Object.keys(led).filter(
      (id) => led[id].outcome === OUTCOMES.fixed || led[id].outcome === OUTCOMES.clean
    )
  );
};

export const recordVisit = async (entry) => {
  if (!entry || !entry.id) return null;
  const led = await readAll();
  const prev = led[entry.id];
  const next = {
    id: entry.id,
    name: entry.name || (prev && prev.name) || null,
    folder: entry.folder || (prev && prev.folder) || null,
    outcome: entry.outcome || OUTCOMES.clean,
    fieldsChanged: entry.fieldsChanged != null ? entry.fieldsChanged : 0,
    stepsChanged: entry.stepsChanged != null ? entry.stepsChanged : 0,
    error: entry.error || null,
    runId: entry.runId || null,
    at: entry.at || null,
    visits: ((prev && prev.visits) || 0) + 1
  };
  led[entry.id] = next;

  // Oldest-first eviction, and only ever of settled entries, so a pending retry can't be dropped.
  const ids = Object.keys(led);
  if (ids.length > MAX_ENTRIES) {
    ids
      .filter((id) => led[id].outcome === OUTCOMES.fixed || led[id].outcome === OUTCOMES.clean)
      .sort((a, b) => (led[a].at || 0) - (led[b].at || 0))
      .slice(0, ids.length - MAX_ENTRIES)
      .forEach((id) => delete led[id]);
  }

  await writeAll(led);
  return next;
};

export const ledgerStats = async () => {
  const led = await readAll();
  const counts = { fixed: 0, clean: 0, failed: 0, skipped: 0 };
  let fieldsChanged = 0;
  Object.values(led).forEach((e) => {
    if (counts[e.outcome] != null) counts[e.outcome] += 1;
    fieldsChanged += e.fieldsChanged || 0;
  });
  return { total: Object.keys(led).length, counts, fieldsChanged };
};

export const clearLedger = async () => {
  try {
    await chrome.storage.local.remove(KEY);
  } catch (_) {}
};

// Splits a freshly scraped history page into work and noise. `queue` is what the crawler should open;
// `alreadyDone` is what the ledger has settled. A page whose every row is already settled contributes
// nothing — enough consecutive such pages is the signal to stop paging rather than a page budget.
export const partitionByLedger = (workflows, settled) => {
  const queue = [];
  const alreadyDone = [];
  for (const w of workflows || []) {
    if (settled.has(w.id)) alreadyDone.push(w);
    else queue.push(w);
  }
  return { queue, alreadyDone, freshCount: queue.length };
};

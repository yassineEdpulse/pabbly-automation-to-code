import { putResult, clearResults, getFailedResults, countResults } from "./db.js";

const keyFor = (tabId) => `captures_${tabId}`;
const MAX_CAPTURES = 400;
const BULK_KEY = "bulk_state";
const MAPPING_BASE = "https://connect.pabbly.com/workflow/mapping/";
const PER_WORKFLOW_MS = 240000;
const STALL_MS = 300000;
const DEFAULT_BATCH = 50;
const BASE_THROTTLE = 1500;
const MAX_THROTTLE = 30000;
const BACKOFF_AFTER = 3;
const PAUSE_AFTER = 6;
const LOG_LIMIT = 50;

const getState = async () => (await chrome.storage.local.get(BULK_KEY))[BULK_KEY] || null;
const setState = (state) => chrome.storage.local.set({ [BULK_KEY]: state });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
const notify = (m) => {
  try {
    chrome.runtime.sendMessage(m);
  } catch (_) {}
};

let processing = false;

const sendWhenReady = async (tabId, msg, tries = 20, gap = 600) => {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, msg);
      if (res) return res;
    } catch (_) {}
    await delay(gap);
  }
  return null;
};

const navigateTo = (tabId, id) => {
  try {
    chrome.tabs.update(tabId, { url: MAPPING_BASE + id });
  } catch (_) {}
};

const tabUrl = async (tabId) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    return (tab && tab.url) || "";
  } catch (_) {
    return "";
  }
};

// Pabbly bounces to a login/signin page once the session dies. Over a multi-hour run this is the
// single most likely failure, and without detection it silently produces hundreds of empty results.
const looksLoggedOut = (url) => /\/(login|signin|sign-in|auth)\b/i.test(url || "");

const pushLog = (state, entry) => {
  state.log = state.log || [];
  state.log.unshift(entry);
  if (state.log.length > LOG_LIMIT) state.log.length = LOG_LIMIT;
};

const pauseRun = async (state, reason) => {
  state.paused = true;
  state.pauseReason = reason;
  await setState(state);
  notify({ type: "bulkPaused", index: state.index, total: state.queue.length, reason });
};

const finalize = async (state) => {
  state.active = false;
  state.finishedAt = Date.now();
  await setState(state);
  try {
    chrome.alarms.clear("bulkWatch");
  } catch (_) {}
  notify({ type: "bulkDone", count: state.done });
};

const advance = async (state, result) => {
  // Written one at a time to IndexedDB: a crash mid-run never costs the whole run, and the
  // 1044-workflow payload never has to fit in chrome.storage.local's ~10MB quota.
  try {
    await putResult({ ...result, runId: state.runId });
  } catch (e) {
    pushLog(state, { name: result.name, error: `db write failed: ${(e && e.message) || e}`, at: Date.now() });
  }

  state.done = (state.done || 0) + 1;
  state.index += 1;
  state.lastProgressAt = Date.now();

  if (result.error) {
    state.errors = (state.errors || 0) + 1;
    state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;
    pushLog(state, { id: result.id, name: result.name, error: result.error, at: Date.now() });
  } else {
    state.consecutiveErrors = 0;
    state.throttleMs = Math.max(BASE_THROTTLE, Math.round((state.throttleMs || BASE_THROTTLE) * 0.7));
  }

  // Adaptive backoff: repeated failures usually mean Pabbly is throttling us or the session is sick.
  if (state.consecutiveErrors >= BACKOFF_AFTER) {
    state.throttleMs = Math.min(MAX_THROTTLE, (state.throttleMs || BASE_THROTTLE) * 2);
  }

  await setState(state);
  notify({ type: "bulkProgress", index: state.index, total: state.queue.length });

  if (state.consecutiveErrors >= PAUSE_AFTER) {
    return pauseRun(state, `${state.consecutiveErrors} failures in a row — check the tab, then Resume`);
  }

  if (state.index >= state.queue.length) return finalize(state);

  if (state.batchSize && state.index % state.batchSize === 0) {
    return pauseRun(state, `batch of ${state.batchSize} complete`);
  }

  await delay(state.throttleMs || BASE_THROTTLE);
  navigateTo(state.tabId, state.queue[state.index].id);
};

const processCurrent = async () => {
  if (processing) return;
  const state = await getState();
  if (!state || !state.active || state.paused) return;
  processing = true;
  try {
    const item = state.queue[state.index];
    if (!item) return finalize(state);
    const tabId = state.tabId;

    const url = await tabUrl(tabId);
    if (looksLoggedOut(url)) {
      return pauseRun(state, "Pabbly session expired — log back in on this tab, then Resume");
    }

    let result;
    const ready = await sendWhenReady(tabId, { type: "ping" });
    if (!ready) {
      const after = await tabUrl(tabId);
      if (looksLoggedOut(after)) {
        return pauseRun(state, "Pabbly session expired — log back in on this tab, then Resume");
      }
      result = { id: item.id, name: item.name, error: "page not ready", steps: [] };
    } else {
      await delay(state.settleMs || 1500);
      try {
        const parsed = await withTimeout(
          chrome.tabs.sendMessage(tabId, { type: "expandAndParse", stepDelay: state.stepDelay || 1200 }),
          state.perWorkflowMs || PER_WORKFLOW_MS
        );
        result =
          parsed && parsed.steps
            ? { id: item.id, name: item.name || parsed.name, url: parsed.url, steps: parsed.steps }
            : { id: item.id, name: item.name, error: "parse failed", steps: [] };
      } catch (e) {
        result = { id: item.id, name: item.name, error: String((e && e.message) || e), steps: [] };
      }
    }
    await advance(state, result);
  } finally {
    processing = false;
  }
};

const watchdog = async () => {
  const state = await getState();
  if (!state || !state.active || state.paused) return;
  const stalled = Date.now() - (state.lastProgressAt || 0) > (state.stallMs || STALL_MS);
  if (stalled) {
    processing = false;
    const item = state.queue[state.index];
    if (item) {
      await advance(state, { id: item.id, name: item.name, error: "watchdog timeout", steps: [] });
    }
    return;
  }
  if (!processing) processCurrent();
};

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "bulkWatch") watchdog();
});

const newRun = (msg, queue) => ({
  active: true,
  paused: false,
  pauseReason: null,
  runId: `run_${Date.now()}`,
  tabId: msg.tabId,
  queue,
  index: 0,
  done: 0,
  errors: 0,
  consecutiveErrors: 0,
  log: [],
  startedAt: Date.now(),
  stepDelay: msg.stepDelay || 1200,
  throttleMs: msg.throttleMs || BASE_THROTTLE,
  settleMs: msg.settleMs || 1500,
  perWorkflowMs: msg.perWorkflowMs || PER_WORKFLOW_MS,
  stallMs: msg.stallMs || STALL_MS,
  batchSize: msg.batchSize || DEFAULT_BATCH,
  lastProgressAt: Date.now(),
  finishedAt: null
});

const startRun = async (state, sendResponse) => {
  await setState(state);
  try {
    chrome.alarms.create("bulkWatch", { periodInMinutes: 1 });
  } catch (_) {}
  navigateTo(state.tabId, state.queue[0].id);
  sendResponse({ started: true, total: state.queue.length });
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "capture") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    const key = keyFor(tabId);
    chrome.storage.session.get(key).then((store) => {
      const list = store[key] || [];
      list.push(msg.payload);
      if (list.length > MAX_CAPTURES) list.splice(0, list.length - MAX_CAPTURES);
      chrome.storage.session.set({ [key]: list });
    });
    return;
  }

  if (msg.type === "startBulk") {
    clearResults()
      .catch(() => {})
      .then(() => startRun(newRun(msg, msg.workflows), sendResponse));
    return true;
  }

  if (msg.type === "retryFailed") {
    getFailedResults().then((failed) => {
      if (!failed.length) return sendResponse({ started: false, reason: "no failed workflows" });
      const queue = failed.map((f) => ({ id: f.id, name: f.name }));
      startRun(newRun(msg, queue), sendResponse);
    });
    return true;
  }

  if (msg.type === "resumeBulk") {
    getState().then((state) => {
      if (!state) return sendResponse({ resumed: false });
      state.paused = false;
      state.pauseReason = null;
      state.active = true;
      state.consecutiveErrors = 0;
      state.lastProgressAt = Date.now();
      if (msg.tabId) state.tabId = msg.tabId;
      setState(state).then(() => {
        try {
          chrome.alarms.create("bulkWatch", { periodInMinutes: 1 });
        } catch (_) {}
        if (state.index < state.queue.length) navigateTo(state.tabId, state.queue[state.index].id);
        sendResponse({ resumed: true, index: state.index, total: state.queue.length });
      });
    });
    return true;
  }

  if (msg.type === "getBulk") {
    getState().then(async (state) => {
      if (!state) return sendResponse(null);
      let stored = 0;
      try {
        stored = await countResults();
      } catch (_) {}
      sendResponse({ ...state, stored });
    });
    return true;
  }

  if (msg.type === "cancelBulk") {
    getState().then((state) => {
      if (state) {
        state.active = false;
        state.paused = false;
        setState(state);
      }
      try {
        chrome.alarms.clear("bulkWatch");
      } catch (_) {}
      sendResponse({ cancelled: true });
    });
    return true;
  }

  if (msg.type === "clearBulk") {
    processing = false;
    try {
      chrome.alarms.clear("bulkWatch");
    } catch (_) {}
    Promise.all([chrome.storage.local.remove(BULK_KEY), clearResults().catch(() => {})]).then(() =>
      sendResponse({ cleared: true })
    );
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  getState().then((state) => {
    if (!state || !state.active || state.paused || state.tabId !== tabId) return;
    processCurrent();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(keyFor(tabId));
});

try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
} catch (_) {}

// Fallback: if setPanelBehavior didn't take, onClicked still fires and opens the panel by hand.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (_) {}
});

// Versions before 0.10.0 accumulated every captured workflow into state.results inside
// chrome.storage.local, which overruns its quota ("Resource::kQuotaBytes quota exceeded") partway
// through a large account. Results now live in IndexedDB; drop the legacy payload on upgrade,
// along with any oversized per-tab popup snapshots.
const migrateLegacyStorage = async () => {
  try {
    const all = await chrome.storage.local.get(null);
    const drop = [];
    const state = all[BULK_KEY];

    if (state && Array.isArray(state.results)) {
      const { results, ...rest } = state;
      await chrome.storage.local.set({
        [BULK_KEY]: { ...rest, done: rest.done != null ? rest.done : results.length, migrated: true }
      });
    }

    Object.keys(all).forEach((k) => {
      if (!k.startsWith("popupState_")) return;
      try {
        if (JSON.stringify(all[k]).length > 2_000_000) drop.push(k);
      } catch (_) {
        drop.push(k);
      }
    });

    if (drop.length) await chrome.storage.local.remove(drop);
  } catch (_) {}
};

chrome.runtime.onInstalled.addListener(migrateLegacyStorage);
chrome.runtime.onStartup.addListener(migrateLegacyStorage);
migrateLegacyStorage();

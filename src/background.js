const keyFor = (tabId) => `captures_${tabId}`;
const MAX_CAPTURES = 400;
const BULK_KEY = "bulk_state";
const MAPPING_BASE = "https://connect.pabbly.com/workflow/mapping/";
const PER_WORKFLOW_MS = 240000;
const STALL_MS = 300000;
const DEFAULT_BATCH = 50;

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

const finalize = async (state) => {
  state.active = false;
  state.finishedAt = true;
  await setState(state);
  try {
    chrome.alarms.clear("bulkWatch");
  } catch (_) {}
  notify({ type: "bulkDone", count: state.results.length });
};

const advance = async (state, result) => {
  state.results.push(result);
  state.index += 1;
  state.lastProgressAt = Date.now();
  await setState(state);
  notify({ type: "bulkProgress", index: state.index, total: state.queue.length });

  if (state.index >= state.queue.length) return finalize(state);

  if (state.batchSize && state.index % state.batchSize === 0) {
    state.paused = true;
    await setState(state);
    notify({ type: "bulkPaused", index: state.index, total: state.queue.length });
    return;
  }

  await delay(state.throttleMs || 1500);
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

    let result;
    const ready = await sendWhenReady(tabId, { type: "ping" });
    if (!ready) {
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
    const state = {
      active: true,
      paused: false,
      tabId: msg.tabId,
      queue: msg.workflows,
      index: 0,
      results: [],
      stepDelay: msg.stepDelay || 1200,
      throttleMs: msg.throttleMs || 1500,
      settleMs: msg.settleMs || 1500,
      perWorkflowMs: msg.perWorkflowMs || PER_WORKFLOW_MS,
      stallMs: msg.stallMs || STALL_MS,
      batchSize: msg.batchSize || DEFAULT_BATCH,
      lastProgressAt: Date.now(),
      finishedAt: false
    };
    setState(state).then(() => {
      try {
        chrome.alarms.create("bulkWatch", { periodInMinutes: 1 });
      } catch (_) {}
      navigateTo(msg.tabId, state.queue[0].id);
      sendResponse({ started: true, total: state.queue.length });
    });
    return true;
  }

  if (msg.type === "resumeBulk") {
    getState().then((state) => {
      if (!state) return sendResponse({ resumed: false });
      state.paused = false;
      state.active = true;
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
    getState().then((state) => sendResponse(state));
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

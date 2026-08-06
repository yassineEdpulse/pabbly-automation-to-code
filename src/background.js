import { putResult, clearResults, getFailedResults, countResults } from "./db.js";
import { PLATFORMS, NEUTRAL, detectPlatform, platformById } from "./platforms/registry.js";
import { OUTCOMES, recordVisit, settledIds, ledgerStats, clearLedger } from "./rewrite-ledger.js";

const keyFor = (tabId) => `captures_${tabId}`;
const MAX_CAPTURES = 400;

// chrome.storage.session is ~10MB for the WHOLE area, shared across every tab. Capping the capture
// buffer by count alone was not enough: a scan clicks every step, and each step's config response
// carries the full step HTML — mapping <select> blocks included — which runs to tens of KB apiece. 400
// of those exceed the area on their own, and the write then rejected on every subsequent capture.
const SESSION_BUDGET = 4_000_000;

// Evicts oldest until the serialized list fits. A quarter at a time so this costs a handful of
// stringifies rather than one per dropped entry.
const fitToSessionBudget = (list) => {
  let out = list;
  while (out.length > 1) {
    let bytes;
    try {
      bytes = JSON.stringify(out).length;
    } catch (_) {
      bytes = Infinity;
    }
    if (bytes <= SESSION_BUDGET) break;
    out = out.slice(Math.ceil(out.length / 4));
  }
  return out;
};
const BULK_KEY = "bulk_state";
const PER_WORKFLOW_MS = 240000;
const STALL_MS = 300000;
const DEFAULT_BATCH = 50;
const BASE_THROTTLE = 1500;
const MAX_THROTTLE = 30000;
const BACKOFF_AFTER = 3;
const PAUSE_AFTER = 6;
const LOG_LIMIT = 50;
const LOOP_GUARD = 10000;

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

const platformOf = (state) => platformById(state && state.platform) || PLATFORMS.pabbly;

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

const navigateTo = (tabId, id, platform) => {
  try {
    chrome.tabs.update(tabId, { url: (platform || PLATFORMS.pabbly).editorUrl(id) });
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

// Both sites bounce to a login page once the session dies. Over a long run this is the single most
// likely failure, and without detection it silently produces hundreds of empty results.
const isLoggedOut = (platform, url) => !!platform.loggedOutRe && platform.loggedOutRe.test(url || "");
const sessionExpired = (platform) =>
  `${platform.label} session expired — log back in on this tab, then Resume`;

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

// Records the result and decides what the run does next. Returns "continue" | "paused" | "done" so
// the caller owns the actual navigation or next fetch — that split is what lets one loop drive an
// in-place run and the tab-navigation callback drive the other.
const advance = async (state, result, item) => {
  if (state.mode === "rewrite") {
    try {
      await advanceRewrite(state, item || { id: result.id, name: result.name }, result);
    } catch (e) {
      pushLog(state, { name: result.name, error: `ledger write failed: ${(e && e.message) || e}`, at: Date.now() });
    }
  } else {
    // Written one at a time to IndexedDB: a crash mid-run never costs the whole run, and a
    // 1000-workflow payload never has to fit in chrome.storage.local's ~10MB quota.
    try {
      await putResult({ ...result, runId: state.runId });
    } catch (e) {
      pushLog(state, { name: result.name, error: `db write failed: ${(e && e.message) || e}`, at: Date.now() });
    }
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
    state.throttleMs = Math.max(state.baseThrottleMs || BASE_THROTTLE, Math.round((state.throttleMs || BASE_THROTTLE) * 0.7));
  }

  // Adaptive backoff: repeated failures usually mean the site is throttling us or the session is sick.
  if (state.consecutiveErrors >= BACKOFF_AFTER) {
    state.throttleMs = Math.min(MAX_THROTTLE, (state.throttleMs || BASE_THROTTLE) * 2);
  }

  await setState(state);
  notify({ type: "bulkProgress", index: state.index, total: state.queue.length });

  if (state.consecutiveErrors >= PAUSE_AFTER) {
    await pauseRun(state, `${state.consecutiveErrors} failures in a row — check the tab, then Resume`);
    return "paused";
  }

  if (state.index >= state.queue.length) {
    await finalize(state);
    return "done";
  }

  // The batch checkpoint exists so a human can look before more changes land. A scan changes nothing, so
  // pausing it every 50 just means a 430-workflow run stops 8 times waiting for someone to click Resume —
  // and silently idles overnight. Apply runs still checkpoint: those are writing to a live account.
  const checkpoints = state.mode !== "rewrite" || state.apply;
  if (checkpoints && state.batchSize && state.index % state.batchSize === 0) {
    await pauseRun(state, `batch of ${state.batchSize} complete`);
    return "paused";
  }

  return "continue";
};

const errorResult = (item, platform, error) => ({
  id: item.id,
  platform: platform.id,
  name: item.name,
  error,
  steps: []
});

// In-place capture: the adapter fetches the automation from the site's own API with the session
// cookie, so the tab never moves. Only used when prepareBulk said it could.
const captureDirect = async (state, platform, item) => {
  try {
    const res = await withTimeout(
      chrome.tabs.sendMessage(state.tabId, { type: "captureById", id: item.id, name: item.name }),
      state.perWorkflowMs || PER_WORKFLOW_MS
    );
    if (res && res.steps) {
      return {
        id: item.id,
        platform: platform.id,
        name: item.name || res.name,
        url: res.url,
        steps: res.steps
      };
    }
    if (res && res.needsNavigation) {
      return errorResult(item, platform, res.error || "in-place capture unavailable for this item");
    }
    return errorResult(item, platform, (res && res.error) || "capture failed");
  } catch (e) {
    return errorResult(item, platform, String((e && e.message) || e));
  }
};

// Navigation capture: the crawler has already pointed the tab at this item, so wait for the content
// script and ask it to expand and parse whatever is on screen.
const captureNavigated = async (state, platform, item) => {
  const ready = await sendWhenReady(state.tabId, { type: "ping" });
  if (!ready) {
    const after = await tabUrl(state.tabId);
    if (isLoggedOut(platform, after)) return { loggedOut: true };
    return errorResult(item, platform, "page not ready");
  }

  await delay(state.settleMs || 1500);
  try {
    const parsed = await withTimeout(
      chrome.tabs.sendMessage(state.tabId, { type: "expandAndParse", stepDelay: state.stepDelay || 1200 }),
      state.perWorkflowMs || PER_WORKFLOW_MS
    );
    if (parsed && parsed.steps) {
      return {
        id: item.id,
        platform: platform.id,
        name: item.name || parsed.name,
        url: parsed.url,
        steps: parsed.steps
      };
    }
    return errorResult(item, platform, (parsed && parsed.error) || "parse failed");
  } catch (e) {
    return errorResult(item, platform, String((e && e.message) || e));
  }
};

// --- Rewrite mode ---------------------------------------------------------------------------------
// Same navigate-per-workflow crawler as a capture run, but each page gets the find-and-replace pass
// instead of the extractor. Results go to the ledger (so a workflow is never opened twice) plus a
// bounded in-state report for review; they deliberately do NOT go into the capture result store,
// whose keys would collide with captured workflows and which a capture run clears wholesale.
const REPORT_LIMIT = 400;

// Only the match context travels into storage, never the full before/after: a code body runs to
// kilobytes, and a few hundred of those would overrun chrome.storage.local's quota mid-run.
const compactStep = (s) => ({
  indexLabel: s.indexLabel || null,
  app: s.app || null,
  title: s.title || null,
  routeName: s.routeName || null,
  saved: s.saved != null ? s.saved : null,
  saveError: s.saveError || null,
  fields: (s.fields || []).map((f) => ({
    field: f.field,
    count: f.count,
    code: !!f.code,
    contexts: (f.contexts || []).slice(0, 3),
    applied: f.applied != null ? f.applied : null,
    verified: f.verified != null ? f.verified : null,
    error: f.error || null
  }))
});

const outcomeFor = (res, apply) => {
  if (!res || res.error) return OUTCOMES.failed;
  // A workflow with steps whose config never loaded was not fully read, so "no matches" is not a
  // finding. Marking it failed is what keeps it unsettled and eligible for the next pass — settling it
  // as clean would hide it permanently on the strength of steps nobody looked at.
  if (res.incomplete) return OUTCOMES.failed;
  if (!res.counts || !res.counts.fields) return OUTCOMES.clean;
  if (!apply) return OUTCOMES.skipped;
  if (res.counts.failed) return OUTCOMES.failed;
  return res.counts.applied ? OUTCOMES.fixed : OUTCOMES.failed;
};

const rewriteNavigated = async (state, platform, item) => {
  const ready = await sendWhenReady(state.tabId, { type: "ping" });
  if (!ready) {
    if (isLoggedOut(platform, await tabUrl(state.tabId))) return { loggedOut: true };
    return { ...errorResult(item, platform, "page not ready"), rewrite: null };
  }

  await delay(state.settleMs || 1500);
  try {
    const res = await withTimeout(
      chrome.tabs.sendMessage(state.tabId, {
        type: "rewriteWorkflow",
        rule: state.rule,
        apply: !!state.apply,
        stepDelay: state.stepDelay || 250,
        deadlineMs: state.deadlineMs || null
      }),
      state.perWorkflowMs || PER_WORKFLOW_MS
    );
    if (!res || res.error) {
      return { id: item.id, platform: platform.id, name: item.name, error: (res && res.error) || "rewrite failed" };
    }
    return {
      id: item.id,
      platform: platform.id,
      name: item.name || res.name,
      url: res.url,
      rewrite: res
    };
  } catch (e) {
    return { id: item.id, platform: platform.id, name: item.name, error: String((e && e.message) || e) };
  }
};

const advanceRewrite = async (state, item, result) => {
  const res = result.rewrite;
  const outcome = outcomeFor(res, state.apply);

  await recordVisit({
    id: item.id,
    name: result.name || item.name,
    folder: item.folder || null,
    outcome,
    fieldsChanged: res && res.counts ? (state.apply ? res.counts.applied : res.counts.fields) : 0,
    stepsChanged: res && res.counts ? res.counts.steps : 0,
    error:
      result.error ||
      (res && res.error) ||
      (res && res.timedOut
        ? `ran out of time after ${res.counts.scanned} step(s) — partial, will retry`
        : res && res.incomplete
          ? `${res.counts.unloaded} step(s) never loaded — not scanned, will retry`
          : null),
    runId: state.runId,
    at: Date.now()
  });

  state.report = state.report || [];
  if (result.error || (res && res.counts && res.counts.fields)) {
    if (state.report.length < REPORT_LIMIT) {
      state.report.push({
        id: item.id,
        name: result.name || item.name,
        folder: item.folder || null,
        outcome,
        counts: (res && res.counts) || { steps: 0, fields: 0, applied: 0, failed: 0 },
        error: result.error || (res && res.error) || null,
        steps: res ? (res.steps || []).map(compactStep) : []
      });
    } else {
      state.reportTruncated = (state.reportTruncated || 0) + 1;
    }
  }

  state.tally = state.tally || { fixed: 0, clean: 0, failed: 0, skipped: 0 };
  state.tally[outcome] = (state.tally[outcome] || 0) + 1;
  state.fieldTotal = (state.fieldTotal || 0) + (res && res.counts ? res.counts.fields : 0);
  state.appliedTotal = (state.appliedTotal || 0) + (res && res.counts ? res.counts.applied || 0 : 0);
};

const processCurrent = async () => {
  if (processing) return;
  processing = true;
  try {
    // An in-place run drives itself round this loop; a navigation run does one item and returns,
    // and tabs.onUpdated calls back in once the next page has loaded.
    for (let guard = 0; guard < LOOP_GUARD; guard++) {
      const state = await getState();
      if (!state || !state.active || state.paused) return;

      const item = state.queue[state.index];
      if (!item) return finalize(state);

      const platform = platformOf(state);

      if (isLoggedOut(platform, await tabUrl(state.tabId))) {
        return pauseRun(state, sessionExpired(platform));
      }

      const result =
        state.mode === "rewrite"
          ? await rewriteNavigated(state, platform, item)
          : state.direct
            ? await captureDirect(state, platform, item)
            : await captureNavigated(state, platform, item);

      if (result.loggedOut) return pauseRun(state, sessionExpired(platform));

      if (await advance(state, result, item) !== "continue") return;

      await delay(state.throttleMs || BASE_THROTTLE);
      if (!state.direct) {
        navigateTo(state.tabId, state.queue[state.index].id, platform);
        return;
      }
    }
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
      await advance(state, errorResult(item, platformOf(state), "watchdog timeout"), item);
    }
    return;
  }
  if (!processing) processCurrent();
};

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "bulkWatch") watchdog();
});

const newRun = (msg, queue, platform, direct) => {
  const pacing = platform.bulk || PLATFORMS.pabbly.bulk;
  const throttle = msg.throttleMs || pacing.throttleMs;
  return {
    active: true,
    paused: false,
    pauseReason: null,
    runId: `run_${Date.now()}`,
    platform: platform.id,
    direct: !!direct,
    tabId: msg.tabId,
    queue,
    index: 0,
    done: 0,
    errors: 0,
    consecutiveErrors: 0,
    log: [],
    startedAt: Date.now(),
    stepDelay: msg.stepDelay || pacing.stepDelay,
    throttleMs: throttle,
    baseThrottleMs: throttle,
    settleMs: msg.settleMs || pacing.settleMs,
    perWorkflowMs: msg.perWorkflowMs || pacing.perWorkflowMs,
    stallMs: msg.stallMs || STALL_MS,
    batchSize: msg.batchSize || pacing.batchSize || DEFAULT_BATCH,
    lastProgressAt: Date.now(),
    finishedAt: null
  };
};

const startRun = async (state, sendResponse) => {
  await setState(state);
  try {
    chrome.alarms.create("bulkWatch", { periodInMinutes: 1 });
  } catch (_) {}
  sendResponse({ started: true, total: state.queue.length, direct: state.direct });
  if (state.direct) processCurrent();
  else navigateTo(state.tabId, state.queue[0].id, platformOf(state));
};

// Asks the page whether it can read every item in place. Only platforms that advertise the
// capability are asked; anything else (or a "no") keeps the navigate-and-parse crawler.
const resolveDirect = async (msg, platform) => {
  if (!platform.directCapture) return false;
  const prep = await sendWhenReady(msg.tabId, { type: "prepareBulk" }, 10, 500);
  if (prep && prep.direct) return true;
  if (prep && prep.reason) notify({ type: "bulkNote", message: prep.reason });
  return false;
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "capture") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    const key = keyFor(tabId);
    chrome.storage.session
      .get(key)
      .then((store) => {
        const list = store[key] || [];
        list.push(msg.payload);
        if (list.length > MAX_CAPTURES) list.splice(0, list.length - MAX_CAPTURES);
        return chrome.storage.session.set({ [key]: fitToSessionBudget(list) });
      })
      .catch(() => {
        // This buffer is a diagnostics convenience — the rewrite pass reads the live DOM and the
        // extractor reads the page's own in-memory copy, so losing it costs nothing but visibility. What
        // it must not do is surface as an unhandled rejection on every capture for the rest of a run, so
        // the tab's buffer is dropped and the next capture starts from empty.
        chrome.storage.session.remove(key).catch(() => {});
      });
    return;
  }

  if (msg.type === "startBulk") {
    const platform = platformById(msg.platform) || PLATFORMS.pabbly;
    clearResults()
      .catch(() => {})
      .then(() => resolveDirect(msg, platform))
      .then((direct) => startRun(newRun(msg, msg.workflows, platform, direct), sendResponse));
    return true;
  }

  // A rewrite run never touches the capture result store and never clears it. The queue is filtered
  // against the ledger first, so an old execution row for an already-handled workflow costs nothing.
  if (msg.type === "startRewrite") {
    const platform = platformById(msg.platform) || PLATFORMS.pabbly;
    settledIds()
      .then(async (settled) => {
        const incoming = msg.workflows || [];
        const queue = msg.ignoreLedger ? incoming : incoming.filter((w) => !settled.has(w.id));
        if (!queue.length) {
          return sendResponse({
            started: false,
            reason: incoming.length
              ? `all ${incoming.length} already handled — nothing new on this page`
              : "no workflows queued",
            skipped: incoming.length
          });
        }
        const state = newRun(msg, queue, platform, false);
        state.mode = "rewrite";
        // 1200ms per step was the extractor's pacing, from before waitForBody could report readiness.
        // With the gate in place this only needs to cover the click registering; a step that is slow to
        // arrive is still waited for, and one that never arrives is reported rather than assumed clean.
        state.stepDelay = msg.stepDelay || 250;
        // A scan of an 80-step workflow with routers legitimately runs for minutes. These must stay
        // ordered: the adapter's soft deadline fires first and returns partial results, the message
        // timeout is the backstop, and the watchdog must be the last thing to fire — otherwise it
        // declares a stall and kills a workflow that was progressing normally, because lastProgressAt
        // only advances BETWEEN workflows.
        state.perWorkflowMs = msg.perWorkflowMs || 900000;
        state.deadlineMs = msg.deadlineMs || state.perWorkflowMs - 45000;
        state.stallMs = msg.stallMs || state.perWorkflowMs + 300000;
        state.apply = !!msg.apply;
        state.rule = msg.rule;
        state.report = [];
        state.tally = { fixed: 0, clean: 0, failed: 0, skipped: 0 };
        state.skippedByLedger = incoming.length - queue.length;
        await startRun(state, sendResponse);
      })
      .catch((e) => sendResponse({ started: false, reason: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === "ledgerStats") {
    ledgerStats().then(sendResponse);
    return true;
  }

  if (msg.type === "clearLedger") {
    clearLedger().then(() => sendResponse({ cleared: true }));
    return true;
  }

  if (msg.type === "retryFailed") {
    const platform = platformById(msg.platform) || PLATFORMS.pabbly;
    getFailedResults(platform.id).then(async (failed) => {
      if (!failed.length) return sendResponse({ started: false, reason: "no failed items" });
      const queue = failed.map((f) => ({ id: f.nativeId != null ? f.nativeId : f.id, name: f.name }));
      const direct = await resolveDirect(msg, platform);
      startRun(newRun(msg, queue, platform, direct), sendResponse);
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
        sendResponse({ resumed: true, index: state.index, total: state.queue.length });
        if (state.index >= state.queue.length) return;
        if (state.direct) processCurrent();
        else navigateTo(state.tabId, state.queue[state.index].id, platformOf(state));
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

// The toolbar button carries the detected platform's colours and name, so the extension identifies
// the site before the panel is even open.
const applyTabBranding = async (tabId, url) => {
  const p = detectPlatform(url) || NEUTRAL;
  try {
    await chrome.action.setIcon({ tabId, path: p.icons });
  } catch (_) {}
  try {
    await chrome.action.setTitle({
      tabId,
      title: p.id ? `${p.label} — Code Extractor` : "Automation Code Extractor (opens side panel)"
    });
  } catch (_) {}
};

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading" || info.url) applyTabBranding(tabId, (tab && tab.url) || info.url);
  if (info.status !== "complete") return;
  applyTabBranding(tabId, tab && tab.url);
  getState().then((state) => {
    if (!state || !state.active || state.paused || state.tabId !== tabId) return;
    // An in-place run drives its own loop; a stray page load must not start a second one.
    if (state.direct) return;
    processCurrent();
  });
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    applyTabBranding(tabId, tab && tab.url);
  } catch (_) {}
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

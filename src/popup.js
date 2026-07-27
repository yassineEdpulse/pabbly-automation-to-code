import {
  detectWorkflows,
  buildExport,
  buildInventoryExport,
  buildBulkExport,
  buildAppReport,
  domWorkflow,
  workflowFromParsed
} from "./normalizer.js";
import { getAllResults, getFailedResults } from "./db.js";
import { levelPill } from "./health.js";
import { makeZip } from "./zip.js";
import { platformOrNeutral, NEUTRAL, exportName } from "./platforms/registry.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const listEl = $("list");
const previewEl = $("preview");
const searchEl = $("search");
const inventoryEl = $("inventory");
const bulkEl = $("bulk");
const filtersEl = $("filters");
const toastsEl = $("toasts");
const brandEl = $("brand");

const RENDER_CHUNK = 100;

let state = {
  platform: NEUTRAL,
  workflows: [],
  captures: [],
  dom: null,
  selectedId: null,
  query: "",
  source: "single",
  levels: [],
  renderLimit: RENDER_CHUNK
};

const terms = () => state.platform.terms;
const platformId = () => state.platform.id;
const supported = () => !!state.platform.id;

const setStatus = (text, cls = "") => {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
};

const toast = (msg, cls = "") => {
  const t = document.createElement("div");
  t.className = `toast ${cls}`;
  t.textContent = msg;
  toastsEl.appendChild(t);
  setTimeout(() => t.remove(), 2200);
};

const activeTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

// Everything the panel says about the current site — colours, brand word, nouns — comes from here.
// The theme itself is CSS: stamping data-platform on <html> swaps the whole variable block.
const applyPlatform = (tab) => {
  const next = platformOrNeutral(tab && tab.url);
  const changed = next.id !== state.platform.id;
  state.platform = next;

  if (next.id) document.documentElement.dataset.platform = next.id;
  else delete document.documentElement.dataset.platform;

  brandEl.textContent = next.label;
  document.title = `${next.label} Code Extractor`;
  $("captureSteps").textContent = `Auto-capture steps (this ${next.terms.unit})`;
  $("exportAll").textContent = `Export ALL ${next.terms.unitPlural}`;
  searchEl.placeholder = `Search ${next.terms.unitPlural}…`;
  return changed;
};

const notSupported = () => setStatus("not a Pabbly or Zapier tab", "err");

const EXPECTED_CONTENT_VERSION = "0.11.4";

const checkContentVersion = async (tabId) => {
  const ping = await sendTab(tabId, { type: "ping" });
  if (!ping) {
    setStatus("no script on page — hard-reload it (Ctrl+Shift+R)", "err");
    previewEl.textContent =
      `The content script isn't responding on this tab. Press Ctrl+Shift+R on the ${state.platform.label} page, then try again.`;
    return false;
  }
  if (ping.version !== EXPECTED_CONTENT_VERSION) {
    setStatus(`old script v${ping.version || "?"} — hard-reload (Ctrl+Shift+R)`, "err");
    previewEl.textContent =
      `The ${state.platform.label} page is running content script v${ping.version || "unknown"}, but this panel ` +
      `expects v${EXPECTED_CONTENT_VERSION}. The page kept the old script. Press Ctrl+Shift+R on the ` +
      `${state.platform.label} page (a normal F5 is not always enough), then try again.`;
    return false;
  }
  return true;
};

const getCaptures = async (tabId) => {
  const key = `captures_${tabId}`;
  const store = await chrome.storage.session.get(key);
  return store[key] || [];
};

const STATE_KEY = (tabId) => `popupState_${tabId}`;

// Bulk results live in IndexedDB, never in storage.local — 1000+ deep workflow trees would blow
// past its ~10MB quota. For a bulk view we persist only the lightweight view settings.
const saveState = async () => {
  const tab = await activeTab();
  if (!tab || !supported()) return;
  const light = { source: state.source, selectedId: state.selectedId, query: state.query, levels: state.levels };
  const payload =
    state.source === "bulk" ? light : { ...light, workflows: state.workflows, dom: state.dom };

  try {
    // A single workflow snapshot is small, but never let a pathological one overrun the quota —
    // falling back to the view settings keeps the panel usable instead of throwing on every save.
    if (state.source !== "bulk" && JSON.stringify(payload).length > 2_000_000) {
      await chrome.storage.local.set({ [STATE_KEY(tab.id)]: light });
      return;
    }
    await chrome.storage.local.set({ [STATE_KEY(tab.id)]: payload });
  } catch (e) {
    try {
      await chrome.storage.local.set({ [STATE_KEY(tab.id)]: light });
    } catch (_) {}
  }
};

const loadState = async (tabId) => {
  const key = STATE_KEY(tabId);
  const store = await chrome.storage.local.get(key);
  return store[key] || null;
};

const sendTab = (tabId, msg) =>
  new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(res || null);
    });
  });

const sendRuntime = (msg) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(res || null);
    });
  });

const copy = async (text, label = "Copied to clipboard") => {
  await navigator.clipboard.writeText(text);
  toast(label);
};

const saveBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Downloaded ${filename}`);
};

// charset must be declared or Windows tools open the file as ANSI and accented text (é, «, —)
// renders as mojibake even though the bytes are valid UTF-8.
const download = (text, filename) =>
  saveBlob(new Blob([text], { type: "application/json;charset=utf-8" }), filename);

const fileFor = (suffix, ext = "json") => exportName(state.platform, suffix, ext);
const unitsSlug = () => terms().unitPlural.toLowerCase();

const safeName = (name) =>
  (name || "workflow").replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "workflow";

const exportJson = (wf) => JSON.stringify(buildExport(wf, state.platform), null, 2);

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  children.forEach((c) => node.appendChild(c));
  return node;
};

const SVG_NS = "http://www.w3.org/2000/svg";
const makeIcon = (d, size = 13) => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
};
const ICON_DOWNLOAD = "M8 2.5v7M5 7l3 3 3-3M3 13h10";

const countAllSteps = (steps) => {
  let n = 0;
  for (const s of steps || []) {
    n++;
    if (s.routes) for (const r of s.routes) n += countAllSteps(r.steps);
  }
  return n;
};

const fmtDuration = (ms) => {
  if (!ms || ms < 0 || !isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
};

const buildCard = (wf) => {
  const name = el("div", { className: "name", textContent: wf.workflowName || wf.name });
  const health = wf.health || null;
  const pillCls = health ? levelPill(health.level) : wf.confidence;
  const pillText = health ? `${health.level} ${health.score}%` : wf.confidence;
  const pill = el("span", { className: `pill ${pillCls}`, textContent: pillText });

  const total = countAllSteps(wf.steps);
  const stepCount = wf.stepCount != null ? wf.stepCount : (wf.steps || []).length;
  const label = total > stepCount ? `${stepCount} steps (${total} incl. routes)` : `${stepCount} steps`;
  const meta = el("div", { className: "meta", textContent: label });
  meta.appendChild(pill);

  const info = el("div", { className: "info" }, [name, meta]);
  if (health && health.warnings.length) {
    info.appendChild(
      el("div", {
        className: "warns",
        textContent: `${health.warnings.length} warning${health.warnings.length > 1 ? "s" : ""}: ${health.warnings[0].message}`
      })
    );
  }

  const exportBtn = el("button", { type: "button", className: "primary", textContent: "Export" });
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    copy(exportJson(wf), `${terms().Unit} JSON copied`);
  });

  const dlBtn = el("button", { type: "button", className: "ghost icon-btn", title: "Download JSON" });
  dlBtn.appendChild(makeIcon(ICON_DOWNLOAD));
  dlBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    download(exportJson(wf), `${safeName(wf.workflowName || wf.name)}.json`);
  });

  const actions = el("div", { className: "actions" }, [exportBtn, dlBtn]);
  const card = el("div", { className: `card${wf.id === state.selectedId ? " active" : ""}` }, [info, actions]);
  card.addEventListener("click", () => select(wf.id));
  return card;
};

const filtered = () => {
  const q = state.query.trim().toLowerCase();
  return state.workflows.filter((w) => {
    if (state.levels.length) {
      const level = (w.health && w.health.level) || "failed";
      if (!state.levels.includes(level)) return false;
    }
    if (!q) return true;
    const name = (w.workflowName || w.name || "").toLowerCase();
    if (name.includes(q)) return true;
    return (w.steps || []).some((s) => (s.app || "").toLowerCase().includes(q));
  });
};

const LEVELS = [
  ["complete", "Complete"],
  ["partial", "Partial"],
  ["poor", "Poor"],
  ["failed", "Failed"]
];

const renderFilters = () => {
  filtersEl.textContent = "";
  if (state.workflows.length < 2) return;

  const counts = {};
  state.workflows.forEach((w) => {
    const level = (w.health && w.health.level) || "failed";
    counts[level] = (counts[level] || 0) + 1;
  });

  LEVELS.forEach(([key, text]) => {
    if (!counts[key]) return;
    const on = state.levels.includes(key);
    const chip = el("button", {
      type: "button",
      className: `chip${on ? " on" : ""}`,
      textContent: `${text} ${counts[key]}`
    });
    chip.addEventListener("click", () => {
      state.levels = on ? state.levels.filter((l) => l !== key) : [...state.levels, key];
      state.renderLimit = RENDER_CHUNK;
      renderFilters();
      renderList();
      saveState();
    });
    filtersEl.appendChild(chip);
  });
};

const renderList = () => {
  listEl.textContent = "";
  const items = filtered();
  if (!items.length) {
    listEl.appendChild(
      el("div", {
        className: "empty",
        textContent: state.workflows.length
          ? `No ${terms().unitPlural} match your search/filter.`
          : supported()
            ? `Nothing parsed yet. Open a ${state.platform.label} ${terms().unit}, then use Auto-capture steps.`
            : "Open a Pabbly Connect or Zapier tab to begin."
      })
    );
    return;
  }

  // Thousands of cards will not render acceptably, so the list grows in chunks on demand.
  const shown = items.slice(0, state.renderLimit);
  shown.forEach((wf) => listEl.appendChild(buildCard(wf)));

  if (items.length > shown.length) {
    const more = el("button", {
      type: "button",
      className: "more",
      textContent: `Show ${Math.min(RENDER_CHUNK, items.length - shown.length)} more (${items.length - shown.length} hidden)`
    });
    more.addEventListener("click", () => {
      state.renderLimit += RENDER_CHUNK;
      renderList();
    });
    listEl.appendChild(more);
  }
};

const select = (id) => {
  state.selectedId = id;
  const wf = state.workflows.find((w) => w.id === id);
  previewEl.textContent = wf ? exportJson(wf) : "";
  renderList();
  saveState();
};

const renderInventory = () => {
  inventoryEl.textContent = "";
  const inv = state.dom && state.dom.inventory ? state.dom.inventory : [];
  if (!inv.length) return;

  const payload = () => JSON.stringify(buildInventoryExport(inv, state.dom.url, state.platform), null, 2);
  const label = el("div", {
    className: "inv-label",
    textContent: `All ${terms().unitPlural} in account: ${inv.length}`
  });
  const copyBtn = el("button", { type: "button", className: "primary", textContent: "Export list" });
  copyBtn.addEventListener("click", () => copy(payload(), "Inventory copied"));
  const dlBtn = el("button", { type: "button", className: "ghost icon-btn", title: "Download list" });
  dlBtn.appendChild(makeIcon(ICON_DOWNLOAD));
  dlBtn.addEventListener("click", () => download(payload(), fileFor(`${terms().unit.toLowerCase()}-inventory`)));
  const actions = el("div", { className: "actions" }, [copyBtn, dlBtn]);
  inventoryEl.appendChild(el("div", { className: "inv-row" }, [label, actions]));
};

const storedResults = () => getAllResults(platformId() || undefined);

const resultsToWorkflows = (results) =>
  results.map((r, i) => ({
    ...workflowFromParsed(r.name, r.url, r.steps, r.error),
    id: r.id || `res_${i}`,
    name: r.name,
    platform: r.platform || platformId(),
    host: state.platform.host || null,
    stepArrayPath: "(bulk capture)",
    rawBody: {
      note: "Bulk capture. schema.steps holds the full captured detail.",
      ...(r.error ? { error: r.error } : {})
    }
  }));

const loadResultsIntoList = async () => {
  const results = await storedResults();
  if (!results.length) return false;
  state.workflows = resultsToWorkflows(results);
  state.source = "bulk";
  state.renderLimit = RENDER_CHUNK;
  if (!state.workflows.find((w) => w.id === state.selectedId)) state.selectedId = null;
  renderFilters();
  renderList();
  return true;
};

const bulkExportPayload = async () => {
  const results = await storedResults();
  return buildBulkExport(
    results.map((r) => workflowFromParsed(r.name, r.url, r.steps, r.error)),
    state.platform
  );
};

const renderBulk = (bulk) => {
  bulkEl.textContent = "";
  if (!bulk) return;

  const done = bulk.index || 0;
  const total = bulk.queue ? bulk.queue.length : 0;
  const errors = bulk.errors || 0;
  const running = bulk.active && !bulk.paused;

  const headText = running
    ? `Bulk capture: ${done}/${total}…`
    : bulk.paused
      ? `Paused at ${done}/${total}`
      : `Bulk done: ${bulk.done || done} ${terms().unitPlural}`;
  bulkEl.appendChild(
    el("div", { className: "bulk-head", textContent: errors ? `${headText} · ${errors} errors` : headText })
  );

  const bar = el("div", { className: "bulk-bar" });
  bar.appendChild(el("span", { style: `width:${total ? Math.round((done / total) * 100) : 0}%` }));
  bulkEl.appendChild(bar);

  if (bulk.direct) {
    bulkEl.appendChild(
      el("div", { className: "bulk-note", textContent: "Reading in place via the site API — the tab stays put." })
    );
  }

  if (bulk.startedAt && done > 0) {
    const elapsed = Date.now() - bulk.startedAt;
    const eta = running ? (elapsed / done) * (total - done) : 0;
    const parts = [`elapsed ${fmtDuration(elapsed)}`];
    if (running) parts.push(`~${fmtDuration(eta)} remaining`);
    parts.push(`${(elapsed / done / 1000).toFixed(1)}s/${terms().unit.toLowerCase()}`);
    if (bulk.throttleMs && bulk.throttleMs > (bulk.baseThrottleMs || 1500)) {
      parts.push(`throttled ${Math.round(bulk.throttleMs / 1000)}s`);
    }
    bulkEl.appendChild(el("div", { className: "bulk-sub", textContent: parts.join(" · ") }));
  }

  if (bulk.paused && bulk.pauseReason) {
    bulkEl.appendChild(el("div", { className: "bulk-reason", textContent: bulk.pauseReason }));
  }

  const row = el("div", { className: "row" });

  if (bulk.paused) {
    const resume = el("button", { type: "button", className: "primary", textContent: "Resume" });
    resume.addEventListener("click", async () => {
      const tab = await activeTab();
      await sendRuntime({ type: "resumeBulk", tabId: tab && tab.id });
      pollBulk();
    });
    row.appendChild(resume);
  }

  if (bulk.active) {
    const cancel = el("button", { type: "button", className: "ghost", textContent: "Cancel" });
    cancel.addEventListener("click", async () => {
      await sendRuntime({ type: "cancelBulk" });
      pollBulk();
    });
    row.appendChild(cancel);
  }

  if (bulk.stored) {
    const copyAll = el("button", { type: "button", className: "primary", textContent: "Copy all" });
    copyAll.addEventListener("click", async () =>
      copy(JSON.stringify(await bulkExportPayload(), null, 2), `All ${terms().unitPlural} copied`)
    );
    const dlAll = el("button", { type: "button", className: "ghost", textContent: "Download all" });
    dlAll.addEventListener("click", async () =>
      download(JSON.stringify(await bulkExportPayload(), null, 2), fileFor(`all-${unitsSlug()}`))
    );
    row.appendChild(copyAll);
    row.appendChild(dlAll);
  }

  bulkEl.appendChild(row);

  if (bulk.stored) {
    const row2 = el("div", { className: "row" });

    // One file per item: a single account-wide JSON will not fit any model's context window.
    const zipBtn = el("button", { type: "button", className: "ghost", textContent: "ZIP (1 file each)" });
    zipBtn.addEventListener("click", async () => {
      const results = await storedResults();
      const seen = new Map();
      const files = results.map((r) => {
        const base = safeName(r.name);
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        const wf = workflowFromParsed(r.name, r.url, r.steps, r.error);
        return {
          name: `${base}${n > 1 ? `-${n}` : ""}.json`,
          data: JSON.stringify(
            buildExport(
              {
                ...wf,
                name: wf.workflowName,
                rawBody: { note: "Bulk capture. schema.steps holds the full captured detail." }
              },
              state.platform
            ),
            null,
            2
          )
        };
      });
      saveBlob(makeZip(files), fileFor(unitsSlug(), "zip"));
    });

    const ndBtn = el("button", { type: "button", className: "ghost", textContent: "NDJSON" });
    ndBtn.addEventListener("click", async () => {
      const results = await storedResults();
      const lines = results
        .map((r) => JSON.stringify(workflowFromParsed(r.name, r.url, r.steps, r.error)))
        .join("\n");
      saveBlob(
        new Blob([lines], { type: "application/x-ndjson;charset=utf-8" }),
        fileFor(unitsSlug(), "ndjson")
      );
    });

    const reportBtn = el("button", { type: "button", className: "ghost", textContent: "App report" });
    reportBtn.addEventListener("click", async () => {
      const results = await storedResults();
      const wfs = results.map((r) => workflowFromParsed(r.name, r.url, r.steps, r.error));
      download(JSON.stringify(buildAppReport(wfs, state.platform), null, 2), fileFor("app-report"));
    });

    row2.appendChild(zipBtn);
    row2.appendChild(ndBtn);
    row2.appendChild(reportBtn);
    bulkEl.appendChild(row2);

    const row3 = el("div", { className: "row" });
    const loadBtn = el("button", { type: "button", className: "ghost", textContent: "Load results into list" });
    loadBtn.addEventListener("click", async () => {
      const ok = await loadResultsIntoList();
      setStatus(ok ? `${state.workflows.length} results loaded` : "no stored results", ok ? "ok" : "warn");
      saveState();
    });
    row3.appendChild(loadBtn);

    if (errors) {
      const retry = el("button", { type: "button", className: "ghost", textContent: `Retry ${errors} failed` });
      retry.addEventListener("click", async () => {
        const tab = await activeTab();
        if (!supported()) return notSupported();
        const failed = await getFailedResults(platformId());
        if (!failed.length) return toast(`No failed ${terms().unitPlural} to retry`, "err");
        await sendRuntime({ type: "retryFailed", tabId: tab.id, platform: platformId(), batchSize: 50 });
        toast(`Retrying ${failed.length} failed ${terms().unitPlural}`);
        pollBulk();
      });
      row3.appendChild(retry);
    }
    bulkEl.appendChild(row3);
  }

  if (bulk.log && bulk.log.length) {
    const det = el("details", { className: "errlog" });
    det.appendChild(el("summary", { textContent: `Error log (${bulk.log.length})` }));
    const ul = el("ul");
    bulk.log.forEach((e) => {
      const li = el("li");
      li.appendChild(el("b", { textContent: e.name || e.id || "?" }));
      li.appendChild(document.createTextNode(` — ${e.error}`));
      ul.appendChild(li);
    });
    det.appendChild(ul);
    bulkEl.appendChild(det);
  }
};

let bulkTimer = null;
const pollBulk = async () => {
  const bulk = await sendRuntime({ type: "getBulk" });
  renderBulk(bulk);
  if (bulk && bulk.active && !bulk.paused) {
    if (!bulkTimer) bulkTimer = setInterval(pollBulk, 1500);
  } else if (bulkTimer) {
    clearInterval(bulkTimer);
    bulkTimer = null;
  }
};

const refresh = async () => {
  setStatus("reading…");
  const tab = await activeTab();
  applyPlatform(tab);
  if (!supported()) {
    notSupported();
    state.workflows = [];
    state.dom = null;
    inventoryEl.textContent = "";
    filtersEl.textContent = "";
    renderList();
    return;
  }
  const captures = await getCaptures(tab.id);
  const dom = await sendTab(tab.id, { type: "scrapeDom" });
  const last = await sendTab(tab.id, { type: "getLastResult" });
  state.captures = captures;

  const lastHasData =
    last && last.steps && last.steps.some((s) => (s.mappings && s.mappings.length) || s.routes || s.filter);
  state.dom = lastHasData
    ? { url: last.url, currentWorkflowName: last.name, inventory: (dom && dom.inventory) || [], steps: last.steps }
    : dom;

  const fromDom = domWorkflow(state.dom, state.platform);
  const fromJson = !fromDom ? detectWorkflows(captures) : [];
  state.workflows = fromDom ? [fromDom] : fromJson;
  state.source = "single";
  state.renderLimit = RENDER_CHUNK;
  if (!state.workflows.find((w) => w.id === state.selectedId)) state.selectedId = null;

  const invCount = dom && dom.inventory ? dom.inventory.length : 0;
  const cls = state.workflows.length ? "ok" : invCount ? "warn" : "err";
  setStatus(`${state.workflows.length} parsed · ${invCount} listed · ${captures.length} captures`, cls);

  renderInventory();
  renderFilters();
  renderList();
  if (state.selectedId) select(state.selectedId);
  else previewEl.textContent = "";
  saveState();
};

$("captureSteps").addEventListener("click", async () => {
  const tab = await activeTab();
  applyPlatform(tab);
  if (!supported()) return notSupported();
  if (!(await checkContentVersion(tab.id))) return;
  setStatus(
    platformId() === "zapier" ? "reading the Zap definition…" : "expanding steps + routes… please wait",
    "warn"
  );

  const res = await sendTab(tab.id, { type: "expandAndParse", stepDelay: 1300 });
  if (!res || !res.steps) return setStatus("capture failed — reload the page", "err");

  const dom = await sendTab(tab.id, { type: "scrapeDom" });
  state.dom = {
    url: res.url,
    currentWorkflowName: res.name,
    inventory: (dom && dom.inventory) || [],
    steps: res.steps
  };
  state.captures = await getCaptures(tab.id);

  const wf = domWorkflow(state.dom, state.platform);
  state.workflows = wf ? [wf] : [];
  state.source = "single";
  state.selectedId = wf ? wf.id : null;

  const total = wf ? countAllSteps(wf.steps) : 0;
  setStatus(
    `${wf ? wf.stepCount : 0} top-level · ${total} total steps · ${state.dom.inventory.length} listed`,
    total ? "ok" : "warn"
  );

  renderInventory();
  renderFilters();
  renderList();
  if (wf) select(wf.id);
  else saveState();

  if (!total) {
    previewEl.textContent =
      "DIAGNOSTIC — nothing parsed. Copy this whole block and send it.\n" +
      (platformId() === "zapier"
        ? "If `error` mentions no definition found, open the Zap in the editor and let it finish loading, " +
          "then capture again. `capturedUrls` shows what the page actually fetched.\n\n"
        : "If census.before.webhook_api_mapping_div is 0, the new content script isn't running " +
          "(hard-reload the page with Ctrl+Shift+R). If it's >0 but debug rows show app:null, " +
          "the step bodies didn't load in time.\n\n") +
      JSON.stringify(res.expand, null, 2);
  }
});

$("exportAll").addEventListener("click", async () => {
  const tab = await activeTab();
  applyPlatform(tab);
  if (!supported()) return notSupported();
  if (!(await checkContentVersion(tab.id))) return;
  const dom = state.dom || (await sendTab(tab.id, { type: "scrapeDom" }));
  const inv = dom && dom.inventory ? dom.inventory : [];
  if (!inv.length) return setStatus(`no ${terms().unit} list found`, "err");

  // No confirm() here on purpose: native dialogs tear down the extension popup,
  // which kills this handler before startBulk is ever sent.
  const workflows = inv.map((i) => ({ id: i.id, name: i.name }));
  const started = await sendRuntime({
    type: "startBulk",
    tabId: tab.id,
    platform: platformId(),
    workflows,
    batchSize: state.platform.bulk.batchSize
  });
  setStatus(`bulk capture started · ${inv.length} ${terms().unitPlural}`, "warn");
  toast(
    started && started.direct
      ? `Reading ${inv.length} ${terms().unitPlural} in place`
      : `Capturing ${inv.length} ${terms().unitPlural} — leave this tab alone`
  );
  pollBulk();
});

$("diagnose").addEventListener("click", async () => {
  const tab = await activeTab();
  applyPlatform(tab);
  if (!supported()) return notSupported();
  const diag = await sendTab(tab.id, { type: "diagnostics" });
  const payload = {
    panelExpectsContentVersion: EXPECTED_CONTENT_VERSION,
    tabUrl: tab.url,
    detectedPlatform: platformId(),
    ...(diag || { error: "content script did not respond — hard-reload the page (Ctrl+Shift+R)" })
  };
  previewEl.textContent = JSON.stringify(payload, null, 2);
  await copy(JSON.stringify(payload, null, 2), "Diagnostics copied");
});

searchEl.addEventListener("input", () => {
  state.query = searchEl.value;
  state.renderLimit = RENDER_CHUNK;
  renderList();
  saveState();
});

$("refresh").addEventListener("click", refresh);

$("clear").addEventListener("click", async () => {
  const tab = await activeTab();
  if (tab) {
    await chrome.storage.session.remove(`captures_${tab.id}`);
    await chrome.storage.local.remove(STATE_KEY(tab.id));
  }
  await sendRuntime({ type: "clearBulk" });
  if (bulkTimer) {
    clearInterval(bulkTimer);
    bulkTimer = null;
  }
  state = {
    platform: state.platform,
    workflows: [],
    captures: [],
    dom: null,
    selectedId: null,
    query: searchEl.value,
    source: "single",
    levels: [],
    renderLimit: RENDER_CHUNK
  };
  setStatus("cleared");
  inventoryEl.textContent = "";
  bulkEl.textContent = "";
  filtersEl.textContent = "";
  renderList();
  previewEl.textContent = "";
  toast("Cleared");
});

$("copyRaw").addEventListener("click", () => copy(JSON.stringify(state.captures, null, 2), "Raw captures copied"));
$("dlRaw").addEventListener("click", () =>
  download(JSON.stringify(state.captures, null, 2), fileFor("raw-captures"))
);

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "bulkProgress" || msg.type === "bulkDone" || msg.type === "bulkPaused") pollBulk();
  if (msg.type === "bulkDone") toast(`Bulk capture finished · ${msg.count} ${terms().unitPlural}`);
  if (msg.type === "bulkPaused" && msg.reason) toast(msg.reason, "err");
  if (msg.type === "bulkNote" && msg.message) toast(msg.message);
});

// The side panel outlives tab switches, so it re-themes and re-reads whenever the active tab
// changes platform — otherwise a Zapier panel would stay orange over a Pabbly page.
const onTabChanged = async () => {
  const tab = await activeTab();
  if (applyPlatform(tab)) refresh();
};

chrome.tabs.onActivated.addListener(onTabChanged);
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === "complete") onTabChanged();
});

const init = async () => {
  const tab = await activeTab();
  applyPlatform(tab);
  const saved = tab && supported() ? await loadState(tab.id) : null;

  if (saved) {
    state.selectedId = saved.selectedId || null;
    state.query = saved.query || "";
    state.levels = saved.levels || [];
    searchEl.value = state.query;
  }

  if (saved && saved.source === "bulk") {
    const ok = await loadResultsIntoList();
    if (ok) {
      if (state.selectedId) select(state.selectedId);
      setStatus(`${state.workflows.length} results restored`, "ok");
    } else {
      refresh();
    }
  } else if (saved && (saved.workflows?.length || saved.dom)) {
    state.workflows = saved.workflows || [];
    state.dom = saved.dom || null;
    state.source = "single";
    renderInventory();
    renderFilters();
    renderList();
    if (state.selectedId) select(state.selectedId);
    const total = state.workflows.reduce((n, w) => n + countAllSteps(w.steps), 0);
    setStatus(
      `${state.workflows.length} parsed · ${total} steps (restored — click Refresh to re-read)`,
      state.workflows.length ? "ok" : "warn"
    );
  } else {
    refresh();
  }

  pollBulk();
};

init();

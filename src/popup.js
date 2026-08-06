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

const EXPECTED_CONTENT_VERSION = "0.13.0";

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
  // Clear the failure text a previous check left behind: it outlived the problem and read as a live
  // error while collection was in fact running normally.
  if (/content script/i.test(previewEl.textContent || "")) previewEl.textContent = "";
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

  // The two inventory sources mean different things and must not read alike: the editor's switcher is
  // the whole account, the Task History tab is a 15-day run log of which this DOM is one page.
  const hist = state.dom.history;
  const cov = hist && hist.coverage;
  const label = el("div", {
    className: "inv-label",
    textContent:
      state.dom.inventorySource === "task-history"
        ? `${inv.length} ${terms().unitPlural} in Task History` +
          (cov ? ` · from ${cov.seenRows} of ${cov.totalRows.toLocaleString()} run rows` : "")
        : `All ${terms().unitPlural} in account: ${inv.length}`
  });
  if (cov && !cov.complete) label.title = "This page only. Paging continues until no new workflows appear.";
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

  // A rewrite run drives the same crawler, so it lands here too — and must not describe itself as a
  // capture, least of all while it is writing to the account.
  const rewriting = bulk.mode === "rewrite";
  const verb = rewriting ? (bulk.apply ? "Applying fixes" : "Scanning") : "Bulk capture";
  const headText = running
    ? `${verb}: ${done}/${total}…`
    : bulk.paused
      ? `Paused at ${done}/${total}`
      : rewriting
        ? `${bulk.apply ? "Apply" : "Scan"} done: ${bulk.done || done} ${terms().unitPlural}`
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

  if (bulk.stored && !rewriting) {
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

  if (bulk.stored && !rewriting) {
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

  // Findings stream in as they are discovered. Waiting for completion meant a 430-workflow scan gave no
  // signal for hours — long enough to spend a whole run learning the rule matched nothing. Apply stays
  // disabled while the scan is still going: a partial report is for watching, not for acting on.
  if (bulk && bulk.mode === "rewrite" && bulk.report) {
    fxReport = await collectFxRun(!!bulk.apply);
    if (fxReport) fxReport.partialRun = !!bulk.active;
    renderFxReport();
    if (bulk.active) fxApplyBtn.disabled = true;
  }

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
  // Checked here, not just before an action. Reloading the extension swaps the panel and the service
  // worker but leaves the content script already injected in an open tab, so the panel can be new while
  // the page is old. That combination silently answers scrapeDom with the previous version's shape —
  // which read as "nothing to list" rather than "hard-reload the page", and cost a debugging round trip.
  if (!(await checkContentVersion(tab.id))) {
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
    ? {
        url: last.url,
        currentWorkflowName: last.name,
        inventory: (dom && dom.inventory) || [],
        inventorySource: dom && dom.inventorySource,
        history: dom && dom.history,
        steps: last.steps
      }
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
  // Every tab's snapshot, not just this one: they are the bulk of what fills storage.local, they are all
  // re-derivable with Refresh, and a quota error is exactly when someone reaches for Clear.
  const freed = await pruneLocalStorage();
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
  const left = await localBytes();
  setStatus(
    `cleared${freed ? ` · freed ${freed} cached snapshot${freed === 1 ? "" : "s"}` : ""}` +
      (left != null ? ` · ${Math.round(left / 1024)} KB still in use` : ""),
    "ok"
  );
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
  if (msg.type === "bulkDone") toast(`Run finished · ${msg.count} ${terms().unitPlural}`);
  if (msg.type === "bulkPaused" && msg.reason) toast(msg.reason, "err");
  if (msg.type === "bulkNote" && msg.message) toast(msg.message);
});

// The side panel outlives tab switches, so it re-themes and re-reads whenever the active tab
// changes platform — otherwise a Zapier panel would stay orange over a Pabbly page.
const onTabChanged = async () => {
  const tab = await activeTab();
  if (applyPlatform(tab)) refresh();
};

// --- Find & replace pass --------------------------------------------------------------------------
// Two passes over the same queue and the same rule: Scan writes nothing and produces a report; Apply
// replays it, writing and saving each field. Apply stays disabled until a scan has found something,
// so the destructive button is never the first one reachable.
const FX_DEFAULT = { find: "secure.tutorcruncher.com", replace: "app.tutorcruncher.com" };

const fxFind = $("fxFind");
const fxReplace = $("fxReplace");
const fxScanBtn = $("fxScan");
const fxApplyBtn = $("fxApply");
const fxLedgerEl = $("fxLedger");
const fxReportEl = $("fxReport");

let fxReport = null;

const fxRule = () => ({
  find: (fxFind.value || "").trim() || FX_DEFAULT.find,
  replace: (fxReplace.value || "").trim() || FX_DEFAULT.replace
});

// A collected queue wins over whatever a single history page happens to show: the run log paginates at
// 10 rows, so the visible page is never the work list.
let fxCollected = null;
let fxCollecting = false;

const fxQueue = () => {
  if (fxCollected && fxCollected.workflows.length) {
    const activeOnly = $("fxActiveOnly").checked;
    return fxCollected.workflows
      // `active === false` only: a null means the source never said, and dropping those would quietly
      // shrink the queue on any endpoint that omits the field.
      .filter((w) => !activeOnly || w.active !== false)
      .map((w) => ({ id: w.id, name: w.name, folder: w.folder || null }));
  }
  const inv = (state.dom && state.dom.inventory) || [];
  return inv.map((i) => ({ id: i.id, name: i.name, folder: i.folder || null }));
};

const FX_QUEUE_KEY = "fx_collected_queue";
const DRY_PAGES = 12;
const MAX_PAGES = 400;

// chrome.storage.local is one shared ~10MB budget: every tab's popup snapshot, the bulk run's report and
// this queue all live in it. A rejected write used to abort the collect handler AFTER the fetch had
// already succeeded, so the panel kept the previous status and a stale queue and looked exactly like an
// API failure. Persisting the queue is a convenience, never a precondition — losing it costs one refetch.
const QUEUE_FIELDS = (w) => ({
  id: w.id,
  name: w.name,
  folder: w.folder || null,
  active: w.active != null ? w.active : null,
  tasks: w.tasks != null ? w.tasks : null
});

const localBytes = async () => {
  try {
    return await chrome.storage.local.getBytesInUse(null);
  } catch (_) {
    return null;
  }
};

// Per-tab popup snapshots are the big, disposable occupants: they hold whole captured workflows and are
// re-derivable by clicking Refresh. Nothing else is dropped without being asked.
const pruneLocalStorage = async () => {
  try {
    const all = await chrome.storage.local.get(null);
    const drop = Object.keys(all).filter((k) => k.startsWith("popupState_"));
    if (drop.length) await chrome.storage.local.remove(drop);
    return drop.length;
  } catch (_) {
    return 0;
  }
};

const persistQueue = async (queue) => {
  // Projected explicitly rather than stored as-received: whatever a source hands back, only these five
  // fields are ever needed, and an endpoint that starts returning fat records must not fill the budget.
  const payload = { ...queue, workflows: (queue.workflows || []).map(QUEUE_FIELDS) };
  try {
    await chrome.storage.local.set({ [FX_QUEUE_KEY]: payload });
    return { stored: true };
  } catch (first) {
    const pruned = await pruneLocalStorage();
    try {
      await chrome.storage.local.set({ [FX_QUEUE_KEY]: payload });
      return { stored: true, pruned };
    } catch (second) {
      return { stored: false, pruned, error: String((second && second.message) || second), bytes: await localBytes() };
    }
  }
};

const renderQueueInfo = () => {
  const info = $("fxQueueInfo");
  if (!fxCollected) {
    info.textContent = "";
    return;
  }
  const { workflows, via, counts, pages, stoppedBecause, pageSize, partial } = fxCollected;

  if (via === "api") {
    const c = counts || {};
    info.textContent =
      `Queue: ${workflows.length} workflows from Pabbly's API in one request` +
      (c.active != null ? ` · ${c.active} active, ${c.inactive} inactive` : "") +
      (c.withUsage ? ` · task counts for ${c.withUsage}` : "") +
      (partial ? " · INCOMPLETE — usage endpoint only, idle workflows missing" : "");
    return;
  }

  info.textContent =
    `Queue: ${workflows.length} workflows from ${pages} page${pages === 1 ? "" : "s"}` +
    (pageSize ? ` at ${pageSize}/page` : "") +
    ` — stopped because ${stoppedBecause}. Paged from the DOM because the API failed` +
    (fxCollected.apiError ? `: ${fxCollected.apiError}` : ".");
};

// Paging is driven from here rather than inside one long content-script call, so progress is visible and
// it can be stopped. Collection must finish before a scan starts: scanning navigates the tab to each
// workflow editor, which destroys the history page the paging depends on.
const collectFromHistory = async (tabId) => {
  const byId = new Map();
  let pages = 0;
  let dry = 0;
  let stoppedBecause = "reached the page limit";

  const size = await sendTab(tabId, { type: "setHistoryPageSize", target: 100 });
  const pageSize = size && size.pageSize ? size.pageSize : null;

  while (pages < MAX_PAGES) {
    if (!fxCollecting) {
      stoppedBecause = "you stopped it";
      break;
    }

    const h = await sendTab(tabId, { type: "scrapeHistory" });
    if (!h || !h.workflows) {
      stoppedBecause = "the page stopped responding";
      break;
    }

    let fresh = 0;
    h.workflows.forEach((w) => {
      if (byId.has(w.id)) return;
      byId.set(w.id, w);
      fresh += 1;
    });
    pages += 1;
    setStatus(`collecting… page ${pages} · ${byId.size} workflows · ${fresh} new`, "warn");

    // The convergence rule: stop when pages stop yielding workflows we haven't seen, not at some
    // arbitrary depth. 24k rows fold to a couple of hundred workflows, so this goes quiet quickly.
    dry = fresh ? 0 : dry + 1;
    if (dry >= DRY_PAGES) {
      stoppedBecause = `${DRY_PAGES} pages in a row had nothing new`;
      break;
    }

    const adv = await sendTab(tabId, { type: "advanceHistoryPage" });
    if (!adv || !adv.advanced) {
      stoppedBecause = adv && adv.reason === "no next page" ? "it reached the last page" : "paging stalled";
      break;
    }
  }

  return { workflows: [...byId.values()], pages, stoppedBecause, pageSize, at: Date.now() };
};

$("fxActiveOnly").addEventListener("change", () => {
  if (!fxCollected) return;
  renderQueueInfo();
  setStatus(`${fxQueue().length} workflows queued`, "ok");
});

$("fxCollect").addEventListener("click", async () => {
  const btn = $("fxCollect");
  if (fxCollecting) {
    fxCollecting = false;
    btn.textContent = "Collect from history";
    return;
  }

  const tab = await activeTab();
  applyPlatform(tab);
  if (!supported()) return notSupported();
  if (platformId() !== "pabbly") return setStatus("the find & replace pass is Pabbly-only", "err");
  if (!(await checkContentVersion(tab.id))) return;
  if (!/\/history\/task-history/.test(tab.url || "")) {
    return setStatus("open the Task History page first", "err");
  }

  fxCollecting = true;
  btn.textContent = "Stop collecting";
  let apiError = null;
  try {
    // The API is the whole catalogue in one request, including workflows idle long enough to be absent
    // from the usage tab. DOM paging is only for when it is unavailable.
    setStatus("asking Pabbly's API for the workflow list…", "warn");
    const cat = await sendTab(tab.id, { type: "fetchCatalogue" });

    if (cat && cat.workflows && cat.workflows.length) {
      fxCollected = {
        via: "api",
        workflows: cat.workflows,
        counts: cat.counts || null,
        partial: !!cat.partial,
        errors: cat.errors && cat.errors.length ? cat.errors : null,
        at: Date.now()
      };
    } else {
      // A failure arrives in three different shapes, and reading only one of them turned a real error
      // into "no response" — leaving nothing to diagnose from.
      apiError =
        (cat && cat.error) ||
        (cat && cat.errors && cat.errors.length
          ? cat.errors.map((e) => `${e.source || "?"}: ${e.error}`).join(" | ")
          : null) ||
        (cat ? "API returned no workflows" : "no response from the page");

      if (!/\/history\//.test(tab.url || "")) {
        previewEl.textContent = [
          "Collect failed.",
          "",
          `API: ${apiError}`,
          "",
          "Open the Task History page if you want to fall back to paging the table instead."
        ].join("\n");
        return setStatus("API unavailable — details in the box below", "err");
      }
      setStatus("API unavailable — paging the table instead", "warn");
      fxCollected = { via: "dom", apiError, ...(await collectFromHistory(tab.id)) };
    }

    // An empty collection is not a queue. Persisting one produced "0 workflows from 0 pages — stopped
    // because you stopped it", which reads like a result rather than a failure, and left Scan pointing
    // at nothing.
    if (!fxCollected.workflows.length) {
      const why = fxCollected.stoppedBecause || "nothing was collected";
      previewEl.textContent = [
        "Collect produced no workflows.",
        "",
        `API: ${apiError || "(not attempted)"}`,
        `DOM paging: ${why}`
      ].join("\n");
      fxCollected = null;
      try {
        await chrome.storage.local.remove(FX_QUEUE_KEY);
      } catch (_) {}
      renderQueueInfo();
      return setStatus(`collected nothing — ${why}`, "err");
    }

    // Render and report BEFORE persisting, so a storage failure can never hide a successful collect.
    renderQueueInfo();
    const queued = fxQueue().length;
    setStatus(`${queued} workflows queued — now Scan`, "ok");

    const persisted = await persistQueue(fxCollected);
    if (!persisted.stored) {
      toast("Queue held in memory only — storage is full", "err");
      previewEl.textContent = [
        "The queue was collected but could not be saved.",
        "",
        persisted.error,
        persisted.bytes != null ? `storage.local in use: ${persisted.bytes} bytes` : null,
        "",
        "It still works for Scan and Apply right now, but closing the panel loses it.",
        "Click Clear to free space, then Collect again if you want it to survive a reload."
      ]
        .filter((line) => line != null)
        .join("\n");
      setStatus(`${queued} workflows queued (in memory only — storage full)`, "warn");
    } else if (persisted.pruned) {
      toast(`Freed ${persisted.pruned} cached tab snapshot(s) to save the queue`);
    }
  } finally {
    fxCollecting = false;
    btn.textContent = "Collect workflows";
  }
});

const renderLedgerLine = async () => {
  const stats = await sendRuntime({ type: "ledgerStats" });
  if (!stats || !stats.total) {
    fxLedgerEl.textContent = "No workflows handled yet.";
    return;
  }
  const c = stats.counts;
  fxLedgerEl.textContent =
    `Handled so far: ${stats.total} — ${c.fixed} fixed, ${c.clean} already clean, ` +
    `${c.failed} failed (will retry), ${c.fieldsChanged || stats.fieldsChanged} fields changed. ` +
    `These are skipped on the next run.`;
};

const fieldLine = (f) => {
  const bits = [el("span", { className: "fx-field-name", textContent: f.field })];
  if (f.code) bits.push(document.createTextNode(" (code)"));
  bits.push(document.createTextNode(` ×${f.count}`));

  if (f.applied === true && f.verified === true) bits.push(el("span", { className: "fx-ok", textContent: " ✓ saved" }));
  else if (f.applied === true && f.verified === null) bits.push(el("span", { className: "fx-warn", textContent: " ~ saved, unverified" }));
  else if (f.error) bits.push(el("span", { className: "fx-bad", textContent: ` ✗ ${f.error}` }));

  const line = el("div", { className: "fx-field" }, bits);
  (f.contexts || []).slice(0, 2).forEach((c) => {
    line.appendChild(el("div", { className: "fx-ctx", textContent: c }));
  });
  return line;
};

const renderFxReport = () => {
  fxReportEl.textContent = "";
  if (!fxReport) return;

  const { rows, counts, applied, skippedByLedger, truncated } = fxReport;
  // "Found 0 fields" is only meaningful alongside how much was actually read, so a single-workflow test
  // reports steps read and steps that never loaded rather than just the finding count.
  const one = fxReport.singleWorkflow ? rows[0] : null;
  const readNote = one
    ? ` · ${one.counts.scanned || 0} step(s) read` +
      (one.counts.unloaded ? `, ${one.counts.unloaded} never loaded` : "")
    : "";
  const head =
    (fxReport.partialRun ? "so far — " : "") +
    (applied
      ? `Applied: ${counts.applied} of ${counts.fields} fields in ${counts.workflows} workflows` +
        (counts.failed ? ` · ${counts.failed} failed` : "")
      : fxReport.singleWorkflow
        ? `This workflow: ${counts.fields} field(s) to change${readNote}`
        : `Found ${counts.fields} fields to change in ${counts.workflows} workflows`);
  fxReportEl.appendChild(el("div", { className: "fx-wf-name", textContent: head }));

  if (skippedByLedger) {
    fxReportEl.appendChild(
      el("div", { className: "fx-ctx", textContent: `${skippedByLedger} already handled, skipped.` })
    );
  }

  rows.forEach((wf) => {
    const box = el("div", { className: "fx-wf" }, [
      el("div", { className: "fx-wf-name", textContent: wf.name || wf.id }),
      el("div", { className: "fx-wf-folder", textContent: wf.folder || "(no folder)" })
    ]);
    if (wf.error) box.appendChild(el("div", { className: "fx-bad", textContent: `✗ ${wf.error}` }));
    (wf.steps || []).forEach((s) => {
      const label = [s.routeName ? `route ${s.routeName} →` : null, s.indexLabel ? `${s.indexLabel}.` : null, s.title || s.app]
        .filter(Boolean)
        .join(" ");
      box.appendChild(el("div", { className: "fx-field", textContent: label }));
      (s.fields || []).forEach((f) => box.appendChild(fieldLine(f)));
      if (s.saved === false) {
        box.appendChild(el("div", { className: "fx-bad", textContent: `✗ save failed: ${s.saveError || "unknown"}` }));
      }
    });
    fxReportEl.appendChild(box);
  });

  if (truncated) {
    fxReportEl.appendChild(
      el("div", { className: "fx-warn", textContent: `+${truncated} more workflows not shown in this report.` })
    );
  }
};

// Reads the finished run out of background state and folds it into something reviewable. Both passes
// use this, so the apply report is the scan report with outcomes filled in.
const collectFxRun = async (applied) => {
  const bulk = await sendRuntime({ type: "getBulk" });
  if (!bulk) return null;
  const rows = bulk.report || [];
  const counts = rows.reduce(
    (acc, r) => ({
      workflows: acc.workflows + (r.counts.fields ? 1 : 0),
      fields: acc.fields + r.counts.fields,
      applied: acc.applied + (r.counts.applied || 0),
      failed: acc.failed + (r.counts.failed || 0)
    }),
    { workflows: 0, fields: 0, applied: 0, failed: 0 }
  );
  return {
    rows,
    counts,
    applied,
    rule: bulk.rule || fxRule(),
    skippedByLedger: bulk.skippedByLedger || 0,
    truncated: bulk.reportTruncated || 0,
    finishedAt: bulk.finishedAt || null
  };
};

const startFxRun = async (apply) => {
  const tab = await activeTab();
  applyPlatform(tab);
  if (!supported()) return notSupported();
  if (platformId() !== "pabbly") return setStatus("the find & replace pass is Pabbly-only", "err");
  if (!(await checkContentVersion(tab.id))) return;

  const rule = fxRule();
  if (rule.find === rule.replace) return setStatus("current and replacement values are identical", "err");

  const queue = fxQueue();
  if (!queue.length) {
    // An empty queue has three quite different causes, and saying which one saves a round trip.
    const onHistory = /\/history\/task-history/.test((tab && tab.url) || "");
    if (!state.dom) return setStatus("nothing read from the page yet — click Capture / Refresh", "err");
    if (onHistory && state.dom.inventorySource !== "task-history") {
      return setStatus("the history reader didn't run — hard-reload the page (Ctrl+Shift+R)", "err");
    }
    return setStatus(
      onHistory
        ? "no workflow rows on this history page — check the date filter, then Capture / Refresh"
        : "no workflows listed — open Task History, then Capture / Refresh",
      "err"
    );
  }

  const res = await sendRuntime({
    type: "startRewrite",
    tabId: tab.id,
    platform: platformId(),
    workflows: queue,
    rule,
    apply,
    batchSize: state.platform.bulk.batchSize
  });

  if (!res || !res.started) {
    setStatus(res && res.reason ? res.reason : "could not start", "warn");
    await renderLedgerLine();
    return;
  }

  setStatus(
    `${apply ? "applying" : "scanning"} ${res.total} workflows — the tab will navigate through them`,
    "warn"
  );
  fxApplyBtn.disabled = true;
};

// Runs the rewrite pass against the workflow already open, with no queue, no navigation and no ledger
// write. This exists because "0 findings across 27 workflows" is indistinguishable from a detector that
// silently matches nothing — a positive control needs one workflow you KNOW contains the string, checked
// in seconds. It also isolates a single slow workflow for diagnosis without re-running a 430-item queue.
// Both single-workflow actions share this. Deliberately does NOT touch the ledger: these are manual,
// one-off operations on the workflow in front of you, and a queue run should reach its own conclusions.
const runOnCurrentWorkflow = async (apply) => {
  const tab = await activeTab();
  applyPlatform(tab);
  if (!supported()) return notSupported();
  if (platformId() !== "pabbly") return setStatus("the find & replace pass is Pabbly-only", "err");
  if (!/\/workflow\/mapping\//.test(tab.url || "")) {
    return setStatus(`open a workflow first (this ${apply ? "applies to" : "tests"} the one on screen)`, "err");
  }
  if (!(await checkContentVersion(tab.id))) return;

  const rule = fxRule();
  if (rule.find === rule.replace) return setStatus("current and replacement values are identical", "err");

  setStatus(
    apply ? "applying to this workflow — writing and saving each step…" : "testing the rule on this workflow…",
    "warn"
  );
  const started = Date.now();
  const res = await sendTab(tab.id, {
    type: "rewriteWorkflow",
    rule,
    apply,
    stepDelay: 250,
    deadlineMs: 240000
  });
  const took = Math.round((Date.now() - started) / 1000);

  if (!res || res.error) {
    setStatus(`test failed: ${(res && res.error) || "no response"}`, "err");
    previewEl.textContent = JSON.stringify(res || { error: "no response" }, null, 2);
    return;
  }

  const c = res.counts || {};
  fxReport = {
    rows: [
      {
        id: res.url,
        name: res.name,
        folder: null,
        counts: c,
        error: res.error || null,
        steps: res.steps || []
      }
    ],
    counts: {
      workflows: c.fields ? 1 : 0,
      fields: c.fields || 0,
      applied: c.applied || 0,
      failed: c.failed || 0
    },
    applied: apply,
    singleWorkflow: true,
    rule
  };
  renderFxReport();
  fxApplyBtn.disabled = true;

  // "Apply to this one" only unlocks once a scan on THIS workflow found something to change, so the
  // destructive single-shot can never be the first button that does anything.
  $("fxApplyOne").disabled = apply || !(c.fields > 0);

  // Steps read vs steps that never loaded is the number that says whether "0 found" means anything.
  const detail = [
    `${c.scanned || 0} step(s) read`,
    c.unloaded ? `${c.unloaded} never loaded` : null,
    res.timedOut ? "hit the time limit" : null,
    `${took}s`
  ]
    .filter(Boolean)
    .join(" · ");

  if (!apply) {
    setStatus(
      c.fields ? `found ${c.fields} field(s) here · ${detail}` : `no matches here · ${detail}`,
      c.fields ? "ok" : c.unloaded || res.timedOut ? "warn" : "ok"
    );
    previewEl.textContent = JSON.stringify(res, null, 2);
    return;
  }

  // On an apply, "written" is not the claim that matters — "verified" is. Each field is re-read after the
  // save and only counts if the old value is genuinely gone.
  const allFields = (res.steps || []).flatMap((s) => s.fields || []);
  const verified = allFields.filter((f) => f.verified === true).length;
  const unverified = allFields.filter((f) => f.applied && f.verified !== true).length;
  const failedFields = allFields.filter((f) => f.error && !f.skipped).length;
  setStatus(
    `applied ${c.applied || 0} of ${c.fields} · ${verified} verified` +
      (unverified ? ` · ${unverified} unverified` : "") +
      (failedFields ? ` · ${failedFields} failed` : "") +
      ` · ${detail}`,
    failedFields || unverified ? "warn" : verified ? "ok" : "err"
  );
  previewEl.textContent = JSON.stringify(res, null, 2);
};

$("fxTestOne").addEventListener("click", () => runOnCurrentWorkflow(false));

$("fxApplyOne").addEventListener("click", async () => {
  if (!fxReport || !fxReport.singleWorkflow || !fxReport.counts.fields) {
    return setStatus("test this workflow first", "warn");
  }
  await runOnCurrentWorkflow(true);
});

fxScanBtn.addEventListener("click", () => startFxRun(false));

fxApplyBtn.addEventListener("click", async () => {
  if (!fxReport || !fxReport.counts.fields) return setStatus("run a scan first", "warn");
  // No confirm(): a native dialog tears down the panel and kills this handler before the message is
  // ever sent. The button being disabled until a scan exists is the guard instead.
  await startFxRun(true);
});

$("fxExport").addEventListener("click", () => {
  if (!fxReport) return setStatus("nothing to export — run a scan first", "warn");
  copy(JSON.stringify(fxReport, null, 2), "Report copied");
  download(JSON.stringify(fxReport, null, 2), fileFor("find-replace-report"));
});

$("fxReset").addEventListener("click", async () => {
  await sendRuntime({ type: "clearLedger" });
  await chrome.storage.local.remove(FX_QUEUE_KEY);
  fxCollected = null;
  fxReport = null;
  renderQueueInfo();
  renderFxReport();
  await renderLedgerLine();
  toast("Ledger and queue cleared — every workflow is eligible again");
});

// A rewrite run finishing is what turns Apply on, and it is also how an apply run reports back.
const onFxRunDone = async () => {
  const bulk = await sendRuntime({ type: "getBulk" });
  if (!bulk || bulk.mode !== "rewrite") return;
  fxReport = await collectFxRun(!!bulk.apply);
  renderFxReport();
  await renderLedgerLine();
  const hasWork = fxReport && fxReport.counts.fields > 0;
  fxApplyBtn.disabled = !hasWork || !!bulk.apply;
  setStatus(
    bulk.apply
      ? `applied ${fxReport.counts.applied} of ${fxReport.counts.fields} fields` +
          (fxReport.counts.failed ? ` · ${fxReport.counts.failed} failed` : "")
      : hasWork
        ? `scan found ${fxReport.counts.fields} fields in ${fxReport.counts.workflows} workflows — review, then Apply`
        : "scan found nothing to change",
    fxReport.counts.failed ? "warn" : hasWork || bulk.apply ? "ok" : "warn"
  );
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "bulkDone") onFxRunDone();
});

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

  fxFind.value = FX_DEFAULT.find;
  fxReplace.value = FX_DEFAULT.replace;
  if (supported() && platformId() === "pabbly") {
    // A collected queue outlives the panel being closed: collecting is minutes of paging, and losing it
    // to a stray panel close would mean doing all of it again.
    const stored = await chrome.storage.local.get(FX_QUEUE_KEY);
    if (stored[FX_QUEUE_KEY] && stored[FX_QUEUE_KEY].workflows) {
      fxCollected = stored[FX_QUEUE_KEY];
      renderQueueInfo();
    }
    await renderLedgerLine();
  }

  // A rewrite run that finished while the panel was closed still has its report in background state.
  const bulk = await sendRuntime({ type: "getBulk" });
  if (bulk && bulk.mode === "rewrite" && !bulk.active) await onFxRunDone();

  pollBulk();
};

init();

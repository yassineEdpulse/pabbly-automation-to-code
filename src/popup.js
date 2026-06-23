import {
  detectWorkflows,
  buildExport,
  buildInventoryExport,
  buildBulkExport,
  domWorkflow,
  workflowFromParsed
} from "./normalizer.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const listEl = $("list");
const previewEl = $("preview");
const searchEl = $("search");
const inventoryEl = $("inventory");
const bulkEl = $("bulk");

let state = { workflows: [], captures: [], dom: null, selectedId: null, query: "" };

const setStatus = (text, cls = "") => {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
};

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const activeTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

const isPabbly = (tab) => tab && /pabbly\.com/.test(tab.url || "");

const EXPECTED_CONTENT_VERSION = "0.9.2";

const checkContentVersion = async (tabId) => {
  const ping = await sendTab(tabId, { type: "ping" });
  if (!ping) {
    setStatus("no script on page — hard-reload it (Ctrl+Shift+R)", "err");
    previewEl.textContent =
      "The content script isn't responding on this tab. Press Ctrl+Shift+R on the Pabbly page, then try again.";
    return false;
  }
  if (ping.version !== EXPECTED_CONTENT_VERSION) {
    setStatus(`old script v${ping.version || "?"} — hard-reload (Ctrl+Shift+R)`, "err");
    previewEl.textContent =
      `The Pabbly page is running content script v${ping.version || "unknown"}, but this popup expects ` +
      `v${EXPECTED_CONTENT_VERSION}. The page kept the old script. Press Ctrl+Shift+R on the Pabbly page ` +
      `(a normal F5 is not always enough), then click Auto-capture again.`;
    return false;
  }
  return true;
};

const getCaptures = async (tabId) => {
  const key = `captures_${tabId}`;
  const store = await chrome.storage.session.get(key);
  return store[key] || [];
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

const copy = async (text, btn) => {
  await navigator.clipboard.writeText(text);
  if (!btn) return;
  const old = btn.textContent;
  btn.textContent = "Copied";
  setTimeout(() => (btn.textContent = old), 1200);
};

const download = (text, filename) => {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const safeName = (name) =>
  (name || "workflow").replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "workflow";

const exportJson = (wf) => JSON.stringify(buildExport(wf), null, 2);

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

const buildCard = (wf) => {
  const name = el("div", { className: "name", textContent: wf.name });
  const pill = el("span", { className: `pill ${wf.confidence}`, textContent: wf.confidence });
  const total = countAllSteps(wf.steps);
  const label =
    total > wf.stepCount ? `${wf.stepCount} steps (${total} incl. routes)` : `${wf.stepCount} steps`;
  const meta = el("div", { className: "meta", textContent: `${label} · ${wf.host}` });
  meta.appendChild(pill);
  const info = el("div", { className: "info" }, [name, meta]);

  const exportBtn = el("button", { type: "button", className: "primary", textContent: "Export" });
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    copy(exportJson(wf), exportBtn);
  });

  const dlBtn = el("button", { type: "button", className: "ghost icon-btn", title: "Download JSON" });
  dlBtn.appendChild(makeIcon(ICON_DOWNLOAD));
  dlBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    download(exportJson(wf), `${safeName(wf.name)}.json`);
  });

  const actions = el("div", { className: "actions" }, [exportBtn, dlBtn]);
  const card = el("div", { className: `card${wf.id === state.selectedId ? " active" : ""}` }, [info, actions]);
  card.addEventListener("click", () => select(wf.id));
  return card;
};

const filtered = () => {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.workflows;
  return state.workflows.filter(
    (w) => w.name.toLowerCase().includes(q) || w.steps.some((s) => (s.app || "").toLowerCase().includes(q))
  );
};

const renderList = () => {
  listEl.textContent = "";
  const items = filtered();
  if (!items.length) {
    listEl.appendChild(
      el("div", {
        className: "empty",
        textContent: state.workflows.length
          ? "No workflows match your search."
          : "No workflow parsed. Open a Pabbly workflow, then use Auto-capture steps."
      })
    );
    return;
  }
  items.forEach((wf) => listEl.appendChild(buildCard(wf)));
};

const select = (id) => {
  state.selectedId = id;
  const wf = state.workflows.find((w) => w.id === id);
  previewEl.textContent = wf ? exportJson(wf) : "";
  renderList();
};

const renderInventory = () => {
  inventoryEl.textContent = "";
  const inv = state.dom && state.dom.inventory ? state.dom.inventory : [];
  if (!inv.length) return;

  const label = el("div", { className: "inv-label", textContent: `All workflows in account: ${inv.length}` });
  const copyBtn = el("button", { type: "button", className: "primary", textContent: "Export list" });
  copyBtn.addEventListener("click", (e) =>
    copy(JSON.stringify(buildInventoryExport(inv, state.dom.url), null, 2), e.target)
  );
  const dlBtn = el("button", { type: "button", className: "ghost icon-btn", title: "Download list" });
  dlBtn.appendChild(makeIcon(ICON_DOWNLOAD));
  dlBtn.addEventListener("click", () =>
    download(JSON.stringify(buildInventoryExport(inv, state.dom.url), null, 2), "pabbly-workflow-inventory.json")
  );
  const actions = el("div", { className: "actions" }, [copyBtn, dlBtn]);
  inventoryEl.appendChild(el("div", { className: "inv-row" }, [label, actions]));
};

const bulkWorkflows = (bulk) =>
  (bulk.results || []).map((r) => workflowFromParsed(r.name, r.url, r.steps));

const renderBulk = (bulk) => {
  bulkEl.textContent = "";
  if (!bulk) return;

  const done = bulk.index || 0;
  const total = bulk.queue ? bulk.queue.length : 0;
  const errors = (bulk.results || []).filter((r) => r.error).length;
  const running = bulk.active && !bulk.paused;
  const headText = running
    ? `Bulk capture: ${done}/${total}…`
    : bulk.paused
      ? `Paused at ${done}/${total}`
      : `Bulk done: ${bulk.results.length} workflows`;
  const head = el("div", { className: "bulk-head", textContent: errors ? `${headText} · ${errors} errors` : headText });

  const bar = el("div", { className: "bulk-bar" });
  bar.appendChild(el("span", { style: `width:${total ? Math.round((done / total) * 100) : 0}%` }));

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

  if (bulk.results && bulk.results.length) {
    const copyAll = el("button", { type: "button", className: "primary", textContent: "Copy all" });
    copyAll.addEventListener("click", (e) =>
      copy(JSON.stringify(buildBulkExport(bulkWorkflows(bulk)), null, 2), e.target)
    );
    const dlAll = el("button", { type: "button", className: "ghost", textContent: "Download all" });
    dlAll.addEventListener("click", () =>
      download(JSON.stringify(buildBulkExport(bulkWorkflows(bulk)), null, 2), "pabbly-all-workflows.json")
    );
    row.appendChild(copyAll);
    row.appendChild(dlAll);
  }

  bulkEl.appendChild(head);
  bulkEl.appendChild(bar);
  bulkEl.appendChild(row);
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
  if (!isPabbly(tab)) {
    setStatus("not a Pabbly tab", "err");
    state.workflows = [];
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

  const fromDom = domWorkflow(state.dom);
  const fromJson = !fromDom ? detectWorkflows(captures) : [];
  state.workflows = fromDom ? [fromDom] : fromJson;
  if (!state.workflows.find((w) => w.id === state.selectedId)) state.selectedId = null;

  const invCount = dom && dom.inventory ? dom.inventory.length : 0;
  const cls = state.workflows.length ? "ok" : invCount ? "warn" : "err";
  setStatus(`${state.workflows.length} parsed · ${invCount} listed · ${captures.length} captures`, cls);

  renderInventory();
  renderList();
  if (state.selectedId) select(state.selectedId);
  else previewEl.textContent = "";
};

$("captureSteps").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!isPabbly(tab)) return setStatus("not a Pabbly tab", "err");
  if (!(await checkContentVersion(tab.id))) return;
  setStatus("expanding steps + routes… please wait", "warn");

  const res = await sendTab(tab.id, { type: "expandAndParse", stepDelay: 1300 });
  if (!res || !res.steps) return setStatus("expand failed — reload the page", "err");

  const dom = await sendTab(tab.id, { type: "scrapeDom" });
  state.dom = {
    url: res.url,
    currentWorkflowName: res.name,
    inventory: (dom && dom.inventory) || [],
    steps: res.steps
  };
  state.captures = await getCaptures(tab.id);

  const wf = domWorkflow(state.dom);
  state.workflows = wf ? [wf] : [];
  state.selectedId = wf ? wf.id : null;

  const total = wf ? countAllSteps(wf.steps) : 0;
  setStatus(
    `${wf ? wf.stepCount : 0} top-level · ${total} total steps · ${state.dom.inventory.length} listed`,
    total ? "ok" : "warn"
  );

  renderInventory();
  renderList();
  if (wf) select(wf.id);

  if (!mapped) {
    previewEl.textContent =
      "DIAGNOSTIC — nothing parsed. Copy this whole block and send it.\n" +
      "If census.before.webhook_api_mapping_div is 0, the new content script isn't running " +
      "(hard-reload the page with Ctrl+Shift+R). If it's >0 but debug rows show app:null, " +
      "the step bodies didn't load in time.\n\n" +
      JSON.stringify(res.expand, null, 2);
  }
});

$("exportAll").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!isPabbly(tab)) return setStatus("not a Pabbly tab", "err");
  if (!(await checkContentVersion(tab.id))) return;
  const dom = state.dom || (await sendTab(tab.id, { type: "scrapeDom" }));
  const inv = dom && dom.inventory ? dom.inventory : [];
  if (!inv.length) return setStatus("no workflow list found", "err");

  const ok = confirm(
    `This will navigate THIS tab through all ${inv.length} workflows, deep-capturing each (routes + nested routers). ` +
      `This is slow — potentially hours. It runs in batches of 50 and pauses between them (click Resume to continue), ` +
      `auto-skips any workflow that stalls, and survives restarts. Don't use this tab while it runs. Continue?`
  );
  if (!ok) return;

  const workflows = inv.map((i) => ({ id: i.id, name: i.name }));
  await sendRuntime({ type: "startBulk", tabId: tab.id, workflows, batchSize: 50 });
  setStatus("bulk capture started", "warn");
  pollBulk();
});

searchEl.addEventListener("input", () => {
  state.query = searchEl.value;
  renderList();
});

$("refresh").addEventListener("click", refresh);
$("clear").addEventListener("click", async () => {
  const tab = await activeTab();
  if (tab) await chrome.storage.session.remove(`captures_${tab.id}`);
  await sendRuntime({ type: "clearBulk" });
  if (bulkTimer) {
    clearInterval(bulkTimer);
    bulkTimer = null;
  }
  state = { workflows: [], captures: [], dom: null, selectedId: null, query: searchEl.value };
  setStatus("cleared");
  inventoryEl.textContent = "";
  bulkEl.textContent = "";
  renderList();
  previewEl.textContent = "";
});

$("copyRaw").addEventListener("click", (e) => copy(JSON.stringify(state.captures, null, 2), e.target));
$("dlRaw").addEventListener("click", () => download(JSON.stringify(state.captures, null, 2), "pabbly-raw-captures.json"));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && (msg.type === "bulkProgress" || msg.type === "bulkDone" || msg.type === "bulkPaused")) pollBulk();
});

refresh();
pollBulk();

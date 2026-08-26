// Pabbly Connect page adapter.
//
// Loaded by the manifest immediately before src/content.js, in the same isolated-world scope, and
// only on *.pabbly.com. It registers itself on __PCE_ADAPTER; the shell in content.js routes
// messages to it. Load order is deliberately NOT relied on: the shared capture buffer is grabbed
// by the ensure-then-reuse idiom below, so either file may create it.
//
// Pabbly Connect is a server-rendered jQuery/Bootstrap app, not an SPA. There is no JSON document
// describing a workflow — each step's config is fetched as `{status, html}` only when its header is
// clicked. Everything here exists to drive that: click a step, wait for its body, parse the HTML.
(() => {
  const localCaptures = (globalThis.__PCE_CAPTURES = globalThis.__PCE_CAPTURES || []);

  const LOG = (...a) => {
    try {
      console.log("%c[PCE]", "color:#5b8cff;font-weight:bold", ...a);
    } catch (_) {}
  };
  const ERR = (...a) => {
    try {
      console.error("%c[PCE ERROR]", "color:#ff5b5b;font-weight:bold", ...a);
    } catch (_) {}
  };

  const cleanText = (el) => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const currentName = () =>
    (document.title || "").replace(/\s*\|\s*Pabbly Connect\s*$/i, "").trim() || null;

  const scrapeInventory = () => {
    const list = [];
    document.querySelectorAll("#select_change_workflow_id option").forEach((o) => {
      const id = o.value;
      if (!id) return;
      list.push({
        id,
        name: (o.getAttribute("title") || o.textContent || "").trim(),
        webhookUrl: o.getAttribute("data-tokens") || ""
      });
    });
    return list;
  };

  // The switcher <select> above only exists on a workflow editor page, so on the v2 Task History tab
  // the panel had nothing to list and reported "no workflow list found". Fall back to the run log,
  // which yields the same {id, name} shape plus the run metadata that makes triage possible.
  //
  // The run log is NOT an account inventory and must never be presented as one: it covers 15 days,
  // lists one row per execution, and a single DOM page is a slice of tens of thousands of rows. The
  // coverage figures travel with it so the panel can say which it is showing.
  const resolveInventory = () => {
    const editor = scrapeInventory();
    if (editor.length) return { inventory: editor, inventorySource: "editor", history: null };

    const h = globalThis.__PCE_HISTORY;
    if (!h || !h.isHistoryPage()) return { inventory: [], inventorySource: null, history: null };

    const hist = h.scrapeHistory();
    return {
      inventory: hist.workflows.map((w) => ({
        id: w.id,
        name: w.name,
        folder: w.folder,
        runs: w.runs,
        lastRun: w.lastRun,
        statuses: w.statuses,
        stepCount: w.stepCount
      })),
      inventorySource: "task-history",
      history: {
        rowCount: hist.rowCount,
        folders: hist.folders,
        pagination: hist.pagination,
        coverage: hist.coverage
      }
    };
  };

  const parseIndex = (raw) => {
    const m = (raw || "").match(/\d+(?:\.\d+)*/);
    if (!m) return { order: null, indexLabel: null };
    return { order: parseFloat(m[0]), indexLabel: m[0] };
  };

  // "Response Received" is the captured test-run payload, not configuration — it leaks either a
  // sample value or Pabbly's internal path encoding into mappings. The full payload stays in `text`.
  const SKIP_LABELS = /^(choose app|action event|response received|connect .*|reconnect.*)$/i;

  // Pabbly encodes field paths as `0<=-+*/@/*+-=>events<=-+($@$)+-=>0<=-+($@$)+-=>action`.
  // If one of these reaches a mapping value it is an internal token, never a user-set value.
  const INTERNAL_TOKEN = /<=-\+[\s\S]*?\+-=>/;

  const TEXT_LIMIT = 2500;

  // A <span> tag with quote-aware attribute matching. Both parts matter:
  //
  //   - Attribute ORDER is not assumed. The old pattern required class="dynamic_value" to appear before
  //     data-attr; when Pabbly emitted them the other way round the strip missed entirely.
  //   - A quoted attribute may contain `>`. data-attr holds field paths like
  //     `0<=-+*/@/*+-=>events<=-+($@$)+-=>id`, and `[^>]*` stops at that inner `>`, leaving the rest of
  //     the attribute behind as if it were text.
  //
  // Either failure leaves Pabbly's internal path token in the cleaned value, and pushMapping used to
  // discard the whole field on sight of one — so a code body or an Asana request body simply vanished
  // from the export while every static field beside it came through, making the loss invisible.
  const SPAN_TAG = /<\/?span\b[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/gi;
  const LINEBREAK_SPAN = /<span\b[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*class="pabbly-connect-linebreak"[\s\S]*?<\/span>/gi;

  const cleanValue = (v) => {
    if (typeof v !== "string") return v;
    return v
      .replace(LINEBREAK_SPAN, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<!--endofdynamic_value-->/gi, "")
      .replace(SPAN_TAG, "")
      .replace(/\{\{\{_map_val_\{\{\{/g, "")
      .replace(/\}\}\}_map_val_\}\}\}/g, "")
      .replace(/data_sign="endofdynamic_value"/gi, "")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  };

  // Last resort when a token still leaks through: keep the field with the token removed rather than
  // dropping it. A field that is entirely internal encoding is still worth nothing and is skipped, but
  // a 200-line code body must never disappear because eight characters of markup were unexpected.
  const salvageInternal = (v) =>
    v
      .replace(/<=-\+[\s\S]*?\+-=>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

  const extractRefs = (val) => {
    if (typeof val !== "string") return null;
    const re = /(\d+)\.\s+([A-Za-z][A-Za-z0-9 ]*?)\s*:/g;
    const refs = [];
    const seen = new Set();
    let m;
    while ((m = re.exec(val))) {
      const step = Number(m[1]);
      const field = m[2].trim();
      const key = `${step}|${field}`;
      if (field.length < 2 || seen.has(key)) continue;
      seen.add(key);
      refs.push({ step, field });
    }
    return refs.length ? refs : null;
  };

  const valueFromGroup = (group) => {
    const ce = group.querySelector("[contenteditable]");
    if (ce && cleanText(ce)) return cleanText(ce);

    const ta = group.querySelector("textarea");
    if (ta && (ta.value || ta.textContent || "").trim()) return (ta.value || ta.textContent).trim();

    // A URL-bearing input wins over any sibling <select>: the "Webhook URL" group also contains
    // the "Select Response" dropdown, and reading the select yielded "Response A" as the URL.
    const urlInput = [...group.querySelectorAll("input:not([type=hidden])")].find((i) =>
      /^https?:\/\//i.test(i.value || i.getAttribute("value") || "")
    );
    if (urlInput) return urlInput.value || urlInput.getAttribute("value");

    const sel = group.querySelector("select");
    if (sel) {
      const opt =
        (sel.options && sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]) ||
        sel.querySelector("option[selected]");
      if (opt && cleanText(opt)) return cleanText(opt);
    }

    const input = group.querySelector("input:not([type=hidden])");
    if (input) {
      const v = input.value || input.getAttribute("value");
      if (v) return v;
    }
    return null;
  };

  const parseStepEl = (root) => {
    const id = root.getAttribute("data_curr_api_index") || null;
    let { order, indexLabel } = parseIndex(root.querySelector(".gbl_module_index")?.textContent);
    if (!indexLabel) {
      const headerTxt = cleanText(root.querySelector(".card-header"));
      const m = headerTxt.match(/(?:^|\s)(\d+(?:\.\d+)*)\.\s/);
      if (m) {
        indexLabel = m[1];
        order = parseFloat(m[1]);
      } else if (/Trigger\s*:/i.test(headerTxt)) {
        indexLabel = "1";
        order = 1;
      }
    }
    const app = cleanText(root.querySelector(".choose_app_name_ele")) || null;

    let event = null;
    const methodSel = root.querySelector('select[name="api_method"], .choose_app_method');
    if (methodSel) {
      const opt =
        (methodSel.options && methodSel.selectedIndex >= 0 && methodSel.options[methodSel.selectedIndex]) ||
        methodSel.querySelector("option[selected]");
      event = cleanText(opt) || null;
    }

    const mappings = [];
    const seenMap = new Set();
    const pushMapping = (field, rawVal) => {
      if (!field || rawVal == null) return;
      let clean = cleanValue(rawVal);
      if (clean === "") return;
      if (INTERNAL_TOKEN.test(clean)) {
        // Salvage rather than discard. Dropping the field made a missing code body indistinguishable
        // from a step that genuinely has none — the failure was completely silent in the export.
        const salvaged = salvageInternal(clean);
        if (salvaged.length < 3) return;
        clean = salvaged;
      }
      const key = `${field}::${clean}`;
      if (seenMap.has(key)) return;
      seenMap.add(key);
      const refs = extractRefs(clean);
      mappings.push(refs ? { field, value: clean, references: refs } : { field, value: clean });
    };

    // Structured app-action parameters (SMTP, API, email, Slack, etc.): label + value live in separate nodes.
    root.querySelectorAll(".card-body .api_mapping_curr_params_con").forEach((row) => {
      const field =
        cleanText(row.querySelector(".map_data_label")) ||
        (row.querySelector(".map_data_key") && row.querySelector(".map_data_key").value) ||
        null;
      const ta = row.querySelector("textarea.map_data_value");
      pushMapping(field, ta ? ta.value || ta.textContent : null);
    });

    // Custom request headers, if any are filled in.
    root.querySelectorAll(".card-body .api_header_div .header_data").forEach((row) => {
      const k = row.querySelector(".curr_header_key") && row.querySelector(".curr_header_key").value;
      const v = row.querySelector(".curr_header_value") && row.querySelector(".curr_header_value").value;
      if (k || v) pushMapping(k ? `Header: ${k}` : "Header", v || "");
    });

    // Generic form-group fields (other step types). Skip the app/event pickers, the parameter/header
    // containers (handled above), per-param inner groups, and the test-response preview.
    root.querySelectorAll(".card-body .form-group").forEach((g) => {
      const cl = g.classList;
      if (cl && (cl.contains("form-group-choose_app_method") || cl.contains("api_mapping_con") || cl.contains("api_header_con") || cl.contains("api_response_con"))) return;
      if (g.querySelector(".choose_app_ele_con")) return;
      if (g.closest(".api_mapping_curr_params_con") || g.closest(".api_response_con")) return;
      const label = cleanText(g.querySelector("label"));
      if (!label || SKIP_LABELS.test(label)) return;
      pushMapping(label, valueFromGroup(g));
    });

    // `text` is the fallback for steps whose config did not parse into mappings, and it is capped to keep
    // exports usable. It used to cut mid-word with no indication, so a reader relying on it could not tell
    // a truncated code body from a complete one — the cut is now stated.
    const bodyEl = root.querySelector(".card-body");
    const fullText = bodyEl ? cleanText(bodyEl) : "";
    const text =
      fullText.length > TEXT_LIMIT ? `${fullText.slice(0, TEXT_LIMIT)}…[truncated — read mappings]` : fullText;
    const filter = root.querySelector(".filter_mapping_con") ? parseFilter(root) : null;
    const routes = root.querySelector(".router_mapping_main_div") ? parseRoutesStatic(root) : null;
    // Carried on the step so the export can say WHOSE gap it is: Pabbly showing its own
    // "mapping detected" error is a broken filter in the account, not a capture that failed.
    const filterBroken = !!(filter || root.querySelector(".filter_mapping_con")) && FILTER_MAPPING_BROKEN.test(fullText);
    return { id, order, indexLabel, app, event, mappings, filter, filterBroken, routes, text };
  };

  const parseRoutesStatic = (root) =>
    [...root.querySelectorAll(".all_router_mapping")].map((rEl, i) => ({
      routeOrder: i + 1,
      routeName: cleanText(rEl.querySelector(".route_sequence_ele")) || `Route ${i + 1}`,
      routeId: rEl.querySelector(".curr_route_id")?.value || null,
      stepCount: Number(cleanText(rEl.querySelector(".route_contain_step_ele"))) || null,
      steps: []
    }));

  const scoreStep = (s) =>
    (s.mappings ? s.mappings.length : 0) + (s.filter ? 10 : 0) + (s.routes ? 5 : 0) + (s.app ? 1 : 0);

  const parseCaptures = () => {
    const dp = new DOMParser();
    const byKey = new Map();
    const byId = new Map();
    for (const c of localCaptures) {
      const html = c && c.body && typeof c.body === "object" ? c.body.html : null;
      if (!html || typeof html !== "string") continue;
      const doc = dp.parseFromString(html, "text/html");
      doc.querySelectorAll(".webhook_api_mapping_div").forEach((root) => {
        const s = parseStepEl(root);
        if (s.id) {
          const prevId = byId.get(s.id);
          if (!prevId || scoreStep(s) > scoreStep(prevId)) byId.set(s.id, s);
        }
        const key = s.indexLabel || s.id;
        if (!key) return;
        const prev = byKey.get(key);
        if (!prev || scoreStep(s) > scoreStep(prev)) byKey.set(key, s);
      });
    }
    return { byKey, byId };
  };

  const selectedLabel = (row, cls) => {
    const wrap = row.querySelector(`.bootstrap-select.${cls}`);
    if (wrap) {
      const t = cleanText(wrap.querySelector(".filter-option-inner-inner"));
      if (t && t !== "Map Data" && t !== "Nothing selected") return t;
    }
    const sel = row.querySelector(`select.${cls}`);
    if (sel) {
      const opt =
        (sel.options && sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]) ||
        sel.querySelector("option[selected]");
      if (opt && cleanText(opt)) return cleanText(opt);
    }
    return null;
  };

  // Pabbly's own words when a filter's mapped source is gone. It renders the row with an empty Select
  // Label and empty Value and shows this banner — so there is genuinely nothing on screen to read, and
  // reporting it as a parse failure blamed the capture for a broken filter in the account.
  const FILTER_MAPPING_BROKEN = /Error in filter mapping detected/i;

  const parseFilter = (root) => {
    const groups = [];
    root.querySelectorAll(".filter_mapping_con .all_condition_filter_mapping").forEach((groupEl) => {
      const joiner = groupEl.classList.contains("or_condition_filter_mapping") ? "OR" : "AND";
      const conditions = [];
      groupEl.querySelectorAll(".filter_mapping_row_div").forEach((rowEl) => {
        const field =
          selectedLabel(rowEl, "source_map_data") ||
          cleanText(rowEl.querySelector("textarea.source_map_data_key")) ||
          null;
        const operator = selectedLabel(rowEl, "logic_map_data");
        const valTa = rowEl.querySelector("textarea.map_data_value");
        const value = valTa ? (valTa.value || valTa.textContent || "").trim() : null;

        if (field || value) {
          conditions.push({ field, operator, value });
          return;
        }
        // A row that exists but has neither operand is still evidence: it says how many conditions the
        // branch has and how they combine. Dropping it left the filter looking like it had none at all.
        if (operator) conditions.push({ field: null, operator, value: null, unresolved: true });
      });
      if (conditions.length) groups.push({ joiner, conditions });
    });
    return groups.length ? groups : null;
  };

  const scrapeOutline = () => {
    const outline = [];
    const seen = new Set();
    document.querySelectorAll(".gbl_module_index").forEach((idxEl) => {
      const { order, indexLabel } = parseIndex(idxEl.textContent);
      if (!indexLabel || seen.has(indexLabel)) return;
      const header = idxEl.closest("h1,h2,h3,h4,.curr_app_name") || idxEl.parentElement;
      if (!header) return;
      const method = cleanText(header.querySelector(".curr_apps_method_name"));
      const label = cleanText(header).replace(/^[\d.]+\s*/, "");
      if (!label) return;
      seen.add(indexLabel);
      outline.push({ order, indexLabel, label, method: method || null });
    });
    return outline;
  };

  const mergeWithOutline = (rich, outlineArg) => {
    const outline = outlineArg || scrapeOutline();
    const labels = [...new Set([...outline.map((o) => o.indexLabel), ...rich.keys()])];
    labels.sort((a, b) => parseFloat(a) - parseFloat(b));

    return labels.map((indexLabel) => {
      const o = outline.find((x) => x.indexLabel === indexLabel) || {};
      const r = rich.get(indexLabel);
      if (r) {
        return {
          order: r.order,
          indexLabel,
          app: r.app || o.label || null,
          event: r.event || o.method || null,
          mappings: r.mappings,
          filter: r.filter,
          filterBroken: r.filterBroken,
          text: r.text,
          routes: r.routes,
          id: r.id,
          expanded: true
        };
      }
      return {
        order: o.order,
        indexLabel,
        app: o.label || null,
        event: o.method || null,
        mappings: [],
        expanded: false
      };
    });
  };

  const richFromDom = () => {
    const rich = new Map();
    document.querySelectorAll(".webhook_api_mapping_div").forEach((root) => {
      const s = parseStepEl(root);
      if (s.indexLabel && (s.app || s.mappings.length)) rich.set(s.indexLabel, s);
    });
    return rich;
  };

  const parseWorkflow = () => mergeWithOutline(richFromDom());

  const scrapeDom = () => {
    const inv = resolveInventory();
    return {
      url: location.href,
      title: currentName(),
      currentWorkflowName: currentName(),
      inventory: inv.inventory,
      inventorySource: inv.inventorySource,
      history: inv.history,
      steps: parseWorkflow(),
      fullText: (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 30000)
    };
  };

  // Returns whether the body actually loaded. That answer matters: a step whose config never arrived
  // parses as having no fields, which a scan would otherwise report as "clean" and the ledger would
  // settle — permanently hiding a workflow that was never really looked at. Callers must check it.
  //
  // Polls fast and often rather than slowly: this is the real readiness gate, so the caller's fixed
  // delay can be small and most steps resolve on the first or second poll.
  const waitForBody = async (card, tries = 30, gap = 150) => {
    for (let i = 0; i < tries; i++) {
      // A detached node can never become ready: when a step's config arrives Pabbly swaps the whole
      // step out via jQuery replaceWith, so any reference taken before the click is now off-document and
      // its stale subtree will report offsetParent === null forever. Polling one for the full timeout is
      // what turned 48 healthy steps into "never loaded" and burned 4.5s apiece doing it.
      if (card.isConnected === false) return false;
      const body = card.querySelector(".card-body");
      if (
        body &&
        body.offsetParent !== null &&
        (body.querySelector(".choose_app_name_ele") || body.querySelector(".form-group"))
      ) {
        return true;
      }
      await delay(gap);
    }
    return false;
  };

  const stepRoots = (scope) => [...(scope || document).querySelectorAll(".webhook_api_mapping_div")];

  const bodyReady = (el) => {
    if (!el || el.isConnected === false) return false;
    const body = el.querySelector(".card-body");
    return !!(
      body &&
      body.offsetParent !== null &&
      (body.querySelector(".choose_app_name_ele") || body.querySelector(".form-group"))
    );
  };

  // Re-finds a step AFTER its header was clicked. Necessary because the arriving config replaces the
  // step's node, so the element that was clicked is gone — reusing it silently reads a detached subtree.
  // `data_curr_api_index` survives the swap and is the reliable handle; the trigger step has no such
  // attribute, so position within the step list is the fallback.
  const reacquireStep = async (id, index, scope, tries = 40, gap = 150) => {
    for (let i = 0; i < tries; i++) {
      const fresh = id
        ? (scope || document).querySelector(`.webhook_api_mapping_div[data_curr_api_index="${id}"]`)
        : stepRoots(scope)[index];
      if (bodyReady(fresh)) return fresh;
      await delay(gap);
    }
    // One last look: the body may be present but not yet laid out, and a usable element beats nothing.
    const last = id
      ? (scope || document).querySelector(`.webhook_api_mapping_div[data_curr_api_index="${id}"]`)
      : stepRoots(scope)[index];
    return last && last.isConnected !== false && last.querySelector(".card-body") ? last : null;
  };

  const isRouterRoot = (root) => !!root.querySelector(".router_mapping_main_div");

  const looksLikeRouter = (root) =>
    /Router \(Pabbly\)/i.test(cleanText(root.querySelector(".curr_app_name")) || "");

  const waitForRouter = async (root, tries = 18, gap = 400) => {
    for (let i = 0; i < tries; i++) {
      if (root.querySelector(".router_mapping_main_div .all_router_mapping")) return true;
      await delay(gap);
    }
    return false;
  };

  const readStepHeader = (div) => {
    const { order, indexLabel } = parseIndex(div.querySelector(".gbl_module_index")?.textContent);
    const h = div.querySelector(".curr_app_name");
    const method = cleanText(div.querySelector(".curr_apps_method_name"));
    const label = h ? cleanText(h).replace(/^[\d.]+\s*/, "") : null;
    return {
      order,
      indexLabel,
      app: label,
      event: method || null,
      id: div.getAttribute("data_curr_api_index") || null,
      isRouter: /Router \(Pabbly\)/i.test(label || "")
    };
  };

  const isShown = (el) =>
    !!el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);

  const visibleRouteModals = () =>
    [...document.querySelectorAll(".main_router_div_con")].filter(isShown);

  const closeRouteModal = (modal) => {
    const btn =
      modal.querySelector(".close_main_router_div_con") ||
      modal.querySelector(".modal-footer button") ||
      modal.querySelector(".close");
    if (btn) btn.click();
    else LOG("closeRouteModal: no close button found");
  };

  const crawlRouters = async (stepDelay) => {
    const visibleRows = () =>
      [...document.querySelectorAll(".router_mapping_main_div .all_router_mapping")].filter(isShown);
    let routeEls = visibleRows();
    LOG(`crawlRouters: visible route rows = ${routeEls.length}`);
    if (!routeEls.length) {
      const routerWrap = [...document.querySelectorAll(".webhook_api_mapping_div")].find(looksLikeRouter);
      const h = routerWrap && routerWrap.querySelector(".card-header");
      if (h) {
        LOG("crawlRouters: no visible routes — clicking router header to expand…");
        h.click();
        for (let i = 0; i < 30 && !routeEls.length; i++) {
          await delay(400);
          routeEls = visibleRows();
        }
        LOG(`crawlRouters: after expand, visible route rows = ${routeEls.length}`);
      }
    }
    if (!routeEls.length) return { routes: [], debug: [{ error: "no visible route rows found" }] };
    const result = await parseRouterRoutes(routeEls, stepDelay);
    await closeAllRouteModals();
    return result;
  };

  const closeAllRouteModals = async () => {
    for (let i = 0; i < 6; i++) {
      const open = visibleRouteModals();
      if (!open.length) return;
      open.forEach(closeRouteModal);
      try {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      } catch (_) {}
      await delay(400);
    }
    LOG("closeAllRouteModals: some modals may still be open");
  };

  const MAX_ROUTER_DEPTH = 3;

  const directRouteSteps = (modal) => {
    const con = modal.querySelector(".router_div_con");
    if (!con) return [];
    return [...con.children].filter((c) => c.classList && c.classList.contains("webhook_api_mapping_div"));
  };

  const openRouteModal = async (rowEl, stepDelay) => {
    const btn = rowEl.querySelector('button[onclick^="edit_curr_route"]');
    if (!btn) return { modal: null, btn: false };
    const before = new Set(visibleRouteModals());
    btn.scrollIntoView({ block: "center" });
    await delay(250);
    btn.click();
    for (let i = 0; i < 24; i++) {
      const fresh = visibleRouteModals().filter((m) => !before.has(m));
      if (fresh.length) {
        const modal = fresh[fresh.length - 1];
        for (let j = 0; j < 24 && !directRouteSteps(modal).length; j++) await delay(350);
        return { modal, btn: true };
      }
      await delay(300);
    }
    return { modal: null, btn: true };
  };

  const readModalSteps = async (modal, stepDelay, depth) => {
    const childDivs = directRouteSteps(modal);
    const steps = [];
    for (const cd of childDivs) {
      const s = readStepHeader(cd);
      const header = cd.querySelector(".card-header");
      if (header) {
        header.click();
        await delay(stepDelay);
      }
      if (s.isRouter && s.id && depth < MAX_ROUTER_DEPTH) {
        const fresh = modal.querySelector(`[data_curr_api_index="${s.id}"]`) || cd;
        let rows = [];
        for (let i = 0; i < 25; i++) {
          rows = [...fresh.querySelectorAll(".router_mapping_main_div .all_router_mapping")].filter(isShown);
          if (rows.length) break;
          await delay(400);
        }
        if (rows.length) {
          LOG(`nested router (depth ${depth + 1}): ${rows.length} sub-route(s)`);
          const { routes } = await parseRouterRoutes(rows, stepDelay, depth + 1);
          s.routes = routes;
        } else {
          LOG(`nested router (depth ${depth + 1}): no sub-routes loaded`);
        }
      }
      steps.push(s);
    }
    return steps;
  };

  const enrichRouteChildren = (routes, byId) => {
    for (const rt of routes || []) {
      for (const ch of rt.steps || []) {
        const cap = ch.id ? byId.get(ch.id) : null;
        if (cap) {
          if (cap.mappings && cap.mappings.length) ch.mappings = cap.mappings;
          if (cap.filter) ch.filter = cap.filter;
          if (!ch.event && cap.event) ch.event = cap.event;
          if (!ch.app && cap.app) ch.app = cap.app;
        }
        if (ch.routes) enrichRouteChildren(ch.routes, byId);
      }
    }
  };

  const parseRouterRoutes = async (routeEls, stepDelay, depth = 1) => {
    LOG(`parseRouterRoutes (depth ${depth}): crawling ${routeEls.length} route(s)`);
    const routes = [];
    const debug = [];
    for (let i = 0; i < routeEls.length; i++) {
      const rEl = routeEls[i];
      const routeName = cleanText(rEl.querySelector(".route_sequence_ele")) || `Route ${i + 1}`;
      const routeId = rEl.querySelector(".curr_route_id")?.value || null;
      const stepCount = Number(cleanText(rEl.querySelector(".route_contain_step_ele"))) || null;

      let steps = [];
      let modalFound = false;
      let error = null;
      LOG(`route #${i + 1} "${routeName}" (depth ${depth}, expected ${stepCount} steps)`);
      try {
        const { modal, btn } = await openRouteModal(rEl, stepDelay);
        if (!btn) throw new Error("no edit_curr_route button on route element");
        modalFound = !!modal;
        LOG(`route "${routeName}" (depth ${depth}): modal opened = ${modalFound}`);
        if (modal) {
          steps = await readModalSteps(modal, stepDelay, depth);
          LOG(
            `route "${routeName}" (depth ${depth}): ${steps.length} child steps` +
              (steps.some((s) => s.routes) ? " (incl. nested router)" : "")
          );
          closeRouteModal(modal);
          await delay(500);
        }
      } catch (e) {
        error = String(e && e.message ? e.message : e);
        ERR(`route "${routeName}" (depth ${depth}) failed:`, e);
      }
      debug.push({ routeName, depth, modalFound, steps: steps.length, error });
      routes.push({ routeOrder: i + 1, routeName, routeId, stepCount, steps });
    }
    return { routes, debug };
  };

  const census = () => ({
    webhook_api_mapping_div: document.querySelectorAll(".webhook_api_mapping_div").length,
    card: document.querySelectorAll(".card").length,
    card_header: document.querySelectorAll(".card-header").length,
    gbl_module_index: document.querySelectorAll(".gbl_module_index").length,
    curr_app_name: document.querySelectorAll(".curr_app_name").length,
    router_mapping_main_div: document.querySelectorAll(".router_mapping_main_div").length,
    all_router_mapping: document.querySelectorAll(".all_router_mapping").length,
    edit_curr_route_btn: document.querySelectorAll('button[onclick^="edit_curr_route"]').length,
    filter_mapping_con: document.querySelectorAll(".filter_mapping_con").length,
    choose_app_name_ele: document.querySelectorAll(".choose_app_name_ele").length
  });

  const expandAndParseAll = async (stepDelay = 1200) => {
    const before = census();
    const outline0 = scrapeOutline();
    const roots = [...document.querySelectorAll(".webhook_api_mapping_div")];
    LOG(`expandAndParseAll: ${roots.length} top-level step wrapper(s) found`, before);
    const rich = new Map();
    const debug = [];
    let unloaded = 0;
    for (let idx0 = 0; idx0 < roots.length; idx0++) {
      const idx = idx0 + 1;
      let root = roots[idx0];
      if (!root || root.isConnected === false) root = stepRoots()[idx0];
      if (!root) continue;

      const stepId = root.getAttribute("data_curr_api_index");
      const isOpen = bodyReady(root);
      const headerText = cleanText(root.querySelector(".curr_app_name")) || "(no header)";
      LOG(`step ${idx}/${roots.length}: "${headerText}" — open=${isOpen}, clicking=${!isOpen}`);

      if (!isOpen) {
        const header = root.querySelector(".card-header");
        if (header) {
          header.click();
          await delay(stepDelay);
        }
        // The arriving config replaces the step's node, so the clicked reference is detached and its
        // stale subtree never reports ready. The extractor used to survive this only because the
        // captured {status, html} responses were merged in afterwards — where no capture matched, the
        // step came out with no mappings AND no text, indistinguishable from a step with no config.
        const fresh = await reacquireStep(stepId, idx0);
        if (fresh) root = fresh;
      }

      if (!bodyReady(root)) {
        unloaded += 1;
        LOG(`step ${idx}: config never loaded — relying on captured HTML if any arrives`);
      }
      const router = looksLikeRouter(root);
      if (router) {
        const loaded = await waitForRouter(root);
        LOG(`step ${idx}: looksLikeRouter=true, routes section loaded=${loaded}`);
      }
      const s = parseStepEl(root);
      LOG(`step ${idx}: parsed app="${s.app}" event="${s.event}" mappings=${s.mappings.length} filter=${!!s.filter} isRouter=${isRouterRoot(root)}`);
      const hasData = !!(s.app || s.mappings.length || s.routes || s.filter);
      if (s.indexLabel && hasData) rich.set(s.indexLabel, s);
      debug.push({
        idx: s.indexLabel,
        app: s.app,
        maps: s.mappings.length,
        filter: !!s.filter,
        routes: s.routes ? s.routes.length : 0,
        clicked: !isOpen
      });
    }
    return { rich, total: roots.length, unloaded, debug, outline: outline0, census: { before, after: census() } };
  };

  // Full single-workflow capture: expand every step, merge in the step-config HTML the page fetched
  // while we clicked (which arrives AFTER the DOM parse, hence the waits), then crawl router routes
  // and back-fill each route child's config by its data_curr_api_index.
  const expandAndParse = async (opts = {}) => {
    const stepDelay = opts.stepDelay || 1200;
    const { rich, total, debug, outline, census: cen } = await expandAndParseAll(stepDelay);
    await delay(1800);
    const { byKey } = parseCaptures();
    byKey.forEach((s, key) => {
      const existing = rich.get(key);
      if (!existing) {
        rich.set(key, s);
        return;
      }
      if (scoreStep(s) > scoreStep(existing)) {
        if (existing.routes && existing.routes.some((r) => r.steps && r.steps.length)) s.routes = existing.routes;
        rich.set(key, s);
      }
    });

    let routerDebug = [];
    try {
      const crawl = await crawlRouters(stepDelay);
      routerDebug = crawl.debug;
      await delay(1500);
      const after = parseCaptures();
      enrichRouteChildren(crawl.routes, after.byId);
      const populated = crawl.routes.some((r) => r.steps && r.steps.length);
      const enriched = crawl.routes.some((r) => (r.steps || []).some((s) => (s.mappings && s.mappings.length) || s.filter));
      LOG(`router crawl done: ${crawl.routes.length} routes, populated=${populated}, child configs enriched=${enriched}`);
      if (crawl.routes.length) {
        let attached = false;
        for (const [, s] of rich) {
          if (/router/i.test(s.app || "") || (s.routes && s.routes.length)) {
            s.routes = crawl.routes;
            attached = true;
            break;
          }
        }
        LOG(`router crawl: attached to router step = ${attached}`);
      }
    } catch (e) {
      ERR("router crawl failed:", e);
      routerDebug = [{ error: String(e && e.message ? e.message : e) }];
    }

    return {
      name: currentName(),
      url: location.href,
      steps: mergeWithOutline(rich, outline),
      expand: { total, parsed: rich.size, debug, routerDebug, census: cen, captures: localCaptures.length }
    };
  };

  // --- Find-and-replace pass ----------------------------------------------------------------------
  // Two modes over one walk, because scan and apply must agree exactly on which steps and fields they
  // consider: a report the apply pass then interprets differently is worse than no report.
  //
  // Route children are reached the same way the extractor reaches them — open each route modal, expand
  // its steps — and the Save button inside the modal is the step's own, so it is clicked there.

  const rewriteFields = async (root, rule, apply, out) => {
    const F = globalThis.__PCE_FIELDS;
    const scanned = F.scanStep(root, rule);
    if (!scanned.fields.length) return scanned;

    if (!apply) return scanned;

    const descriptors = F.collectFields(root);
    const REWRITE = globalThis.__PCE_REWRITE;
    let wrote = 0;
    let skipped = 0;

    for (const hit of scanned.fields) {
      if (!hit.count) continue;
      const d = descriptors.find((x) => x.field === hit.field && x.elementId === hit.elementId);
      if (!d) {
        hit.applied = false;
        hit.error = "field element no longer present";
        continue;
      }

      // Read through the SAME path the write will use, immediately before writing. The scan reads
      // textarea.value from this world, but a TinyMCE-backed field's authoritative content is the
      // editor's own model — and TinyMCE normalizes markup, so the two are never byte-identical.
      // Comparing the scan's copy against the editor's made the staleness guard reject every field with
      // "field changed since scan", and not one write ever landed.
      //
      // Recomputing the replacement from the live value also means whatever normalization the editor
      // applied is preserved: only the matched text changes.
      const cur = await F.readField(d);
      if (!cur || !cur.ok) {
        hit.applied = false;
        hit.error = (cur && cur.reason) || "could not read the field back";
        continue;
      }

      const fresh = REWRITE.applyToValue(cur.value || "", rule);
      if (!fresh.hits.length) {
        // Genuinely nothing to do — already fixed, or the only matches sit inside markup and must not be
        // touched. Neither is a failure, and counting them as one made a clean run look broken.
        hit.applied = false;
        hit.skipped = true;
        hit.error = fresh.blocked.length
          ? "match is inside markup — deliberately not rewritten"
          : "already up to date";
        skipped += 1;
        continue;
      }

      const res = await F.writeField(d, fresh.value, cur.value, rule.replace);
      hit.applied = !!res.ok;
      hit.via = res.via || null;
      if (!res.ok) hit.error = res.reason || "write failed";
      if (res.skipped) hit.skipped = true;
      if (res.ok) wrote += 1;
    }

    scanned.skipped = skipped;

    if (!wrote) {
      scanned.saved = false;
      scanned.saveError = "nothing written";
      return scanned;
    }

    const saved = await F.clickSaveAndWait(root);
    scanned.saved = !!saved.ok;
    if (!saved.ok) scanned.saveError = saved.reason;

    // Verify by re-reading rather than trusting the click: the old host must be gone from every field
    // that was written. An unverified field is reported as such, never assumed applied.
    await new Promise((r) => setTimeout(r, 800));
    for (const hit of scanned.fields) {
      if (!hit.applied) continue;
      const d = descriptors.find((x) => x.field === hit.field && x.elementId === hit.elementId);
      const cur = d ? await globalThis.__PCE_FIELDS.readField(d) : null;
      const value = cur && cur.ok ? cur.value || "" : null;
      hit.verified = value == null ? null : !globalThis.__PCE_REWRITE.scanText(value, rule).length;
      if (hit.verified === false) hit.error = "old value still present after save";
    }

    out.wrote += wrote;
    return scanned;
  };

  const rewriteRouteChildren = async (rule, apply, stepDelay, out, outOfTime) => {
    const results = [];
    let routeEls = [...document.querySelectorAll(".router_mapping_main_div .all_router_mapping")].filter(isShown);
    if (!routeEls.length) return results;

    for (let i = 0; i < routeEls.length; i++) {
      // Router routes are where a large workflow spends most of its time, so the deadline is checked
      // per route and per child rather than only in the top-level loop.
      if (outOfTime && outOfTime()) {
        out.timedOut = true;
        break;
      }
      const rEl = routeEls[i];
      const routeName = cleanText(rEl.querySelector(".route_sequence_ele")) || `Route ${i + 1}`;
      try {
        const { modal } = await openRouteModal(rEl, stepDelay);
        if (!modal) {
          results.push({ routeName, error: "route modal did not open" });
          continue;
        }
        // Same replaceWith behaviour applies inside a route modal, so children are re-acquired too —
        // scoped to the modal, since ids elsewhere on the page must not be matched.
        const children = directRouteSteps(modal);
        for (let c = 0; c < children.length; c++) {
          if (outOfTime && outOfTime()) {
            out.timedOut = true;
            break;
          }
          let cd = children[c];
          if (!cd || cd.isConnected === false) cd = directRouteSteps(modal)[c];
          if (!cd) continue;

          const childId = cd.getAttribute("data_curr_api_index");
          const identity = globalThis.__PCE_FIELDS.stepIdentity(cd);

          if (!bodyReady(cd)) {
            const header = cd.querySelector(".card-header");
            if (header) {
              header.click();
              await delay(stepDelay);
            }
            cd = await reacquireStep(childId, c, modal);
          }

          if (!bodyReady(cd)) {
            out.unloaded += 1;
            results.push({
              routeName,
              ...identity,
              fields: [],
              error: "route step config never loaded — not scanned"
            });
            continue;
          }

          out.scanned += 1;
          const res = await rewriteFields(cd, rule, apply, out);
          if (res.fields.length) results.push({ routeName, ...res });
        }
        closeRouteModal(modal);
        await delay(500);
      } catch (e) {
        results.push({ routeName, error: String((e && e.message) || e) });
      }
    }
    await closeAllRouteModals();
    return results;
  };

  const rewriteWorkflow = async (opts = {}) => {
    const rule = opts.rule;
    const apply = !!opts.apply;
    const stepDelay = opts.stepDelay || 1200;
    if (!rule || !rule.find || !rule.replace) return { error: "no rule supplied" };
    if (!globalThis.__PCE_FIELDS || !globalThis.__PCE_REWRITE) {
      return { error: "rewrite modules not loaded — hard-reload the page" };
    }

    // A TinyMCE write that silently no-ops is the worst failure mode here, so an apply run refuses to
    // start unless the page-realm bridge answered.
    if (apply) {
      const probe = await globalThis.__PCE_FIELDS.bridgeAvailable();
      if (!probe.ok || !probe.tinymce) {
        return { error: `page-realm bridge unavailable (${probe.reason || "no tinymce"}) — hard-reload the page` };
      }
    }

    // A soft deadline, set below the caller's hard timeout. Without it an 80-step workflow with routers
    // ran past the 4-minute message timeout and the caller threw it away whole — losing every step that
    // HAD been read, on exactly the largest workflows most likely to contain matches. Returning partial
    // results flagged incomplete keeps that work and still forces a retry.
    const deadline = opts.deadlineMs ? Date.now() + opts.deadlineMs : null;
    const outOfTime = () => deadline != null && Date.now() > deadline;

    const out = { wrote: 0, unloaded: 0, scanned: 0, timedOut: false };
    const steps = [];

    // Iterated by index with the id captured up front, because the list itself is rebuilt as steps load.
    const initial = stepRoots();
    for (let i = 0; i < initial.length; i++) {
      if (outOfTime()) {
        out.timedOut = true;
        break;
      }

      let root = initial[i];
      if (!root || root.isConnected === false) root = stepRoots()[i];
      if (!root) continue;

      const stepId = root.getAttribute("data_curr_api_index");
      const identity = globalThis.__PCE_FIELDS.stepIdentity(root);

      if (!bodyReady(root)) {
        const header = root.querySelector(".card-header");
        if (header) {
          header.click();
          await delay(stepDelay);
        }
        // The click's response replaces this node, so the element must be looked up again rather than
        // waited on. Skipping this was the whole bug: 48 of 49 steps reported "never loaded" while being
        // visibly open on screen, and the scan reported a false all-clear.
        root = await reacquireStep(stepId, i);
      }

      if (!bodyReady(root)) {
        out.unloaded += 1;
        steps.push({ ...identity, fields: [], error: "step config never loaded — not scanned" });
        continue;
      }

      out.scanned += 1;
      if (looksLikeRouter(root)) await waitForRouter(root);
      const res = await rewriteFields(root, rule, apply, out);
      if (res.fields.length) steps.push(res);
    }

    let routes = [];
    try {
      routes = await rewriteRouteChildren(rule, apply, stepDelay, out, outOfTime);
    } catch (e) {
      ERR("route rewrite failed:", e);
      routes = [{ error: String((e && e.message) || e) }];
    }

    const all = [...steps, ...routes.filter((r) => r.fields)];
    const fieldCount = all.reduce((n, s) => n + s.fields.length, 0);
    const appliedCount = all.reduce((n, s) => n + s.fields.filter((f) => f.applied).length, 0);
    const failed = all.reduce(
      (n, s) => n + s.fields.filter((f) => f.error || f.verified === false).length,
      0
    );

    return {
      name: currentName(),
      url: location.href,
      rule: { find: rule.find, replace: rule.replace },
      apply,
      steps: all,
      routeErrors: routes.filter((r) => r.error),
      // `unloaded` is why this workflow must not be settled as clean: those steps were never read, so
      // "no matches found" says nothing about them. The caller turns any non-zero count into a retry.
      counts: {
        steps: all.length,
        fields: fieldCount,
        applied: appliedCount,
        failed,
        scanned: out.scanned,
        unloaded: out.unloaded
      },
      timedOut: out.timedOut,
      incomplete: out.unloaded > 0 || out.timedOut
    };
  };

  globalThis.__PCE_ADAPTER = {
    id: "pabbly",
    currentName,
    scrapeDom,
    expandAndParse,
    rewriteWorkflow,
    scrapeHistory: () => (globalThis.__PCE_HISTORY ? globalThis.__PCE_HISTORY.scrapeHistory() : null),
    scrapeUsage: () => (globalThis.__PCE_HISTORY ? globalThis.__PCE_HISTORY.scrapeUsage() : null),
    fetchCatalogue: () =>
      globalThis.__PCE_PABBLY_API
        ? globalThis.__PCE_PABBLY_API.fetchCatalogue()
        : { workflows: [], errors: [{ error: "api module not loaded" }] },
    isUsageTab: () => !!(globalThis.__PCE_HISTORY && globalThis.__PCE_HISTORY.isUsageTab()),
    advanceHistoryPage: (opts) =>
      globalThis.__PCE_HISTORY ? globalThis.__PCE_HISTORY.advancePage(opts && opts.waitMs) : { advanced: false },
    setHistoryPageSize: (opts) =>
      globalThis.__PCE_HISTORY
        ? globalThis.__PCE_HISTORY.setPageSize(opts && opts.target)
        : { changed: false, reason: "history module not loaded" },
    // Async because the usage-tab probe has to round-trip to the page's realm for the React ids. This is
    // the only place that reports whether that extraction worked, and it is the check to run before
    // letting it fill a queue: `usage.hasIds` false with a reason beats a queue built on wrong ids.
    diagnostics: async () => {
      const inv = resolveInventory();
      const H = globalThis.__PCE_HISTORY;
      let usage = null;
      try {
        if (H && H.isUsageTab()) usage = await H.scrapeUsage();
      } catch (e) {
        usage = { error: String((e && e.message) || e) };
      }
      // The API catalogue is probed here too: one request settles whether any of the DOM paths are
      // needed at all, and its `path` shows where the records were discovered in the envelope.
      let api = null;
      try {
        if (globalThis.__PCE_PABBLY_API && /\/v2\/app\//.test(location.pathname)) {
          const cat = await globalThis.__PCE_PABBLY_API.fetchCatalogue();
          api = {
            source: cat.source,
            path: cat.path || null,
            reportedTotal: cat.reportedTotal != null ? cat.reportedTotal : null,
            returned: cat.workflows.length,
            complete: cat.complete != null ? cat.complete : null,
            errors: cat.errors && cat.errors.length ? cat.errors : null,
            sample: cat.workflows.slice(0, 3)
          };
        }
      } catch (e) {
        api = { error: String((e && e.message) || e) };
      }

      return {
        platform: "pabbly",
        census: census(),
        captures: localCaptures.length,
        api,
        inventorySource: inv.inventorySource,
        inventoryCount: inv.inventory.length,
        history: inv.history,
        usageTab: !!(H && H.isUsageTab()),
        usage: usage
          ? {
              error: usage.error || null,
              rowCount: usage.rows ? usage.rows.length : 0,
              hasIds: usage.hasIds,
              idsReason: usage.idsReason,
              mismatches: usage.mismatches,
              pagination: usage.pagination,
              sample: (usage.rows || []).slice(0, 3).map((r) => ({
                id: r.id,
                name: r.name,
                folder: r.folder,
                active: r.active,
                tasks: r.tasks
              }))
            }
          : null
      };
    }
  };

  // Test hook: lets the golden-fixture suite exercise the real parsers against saved HTML
  // instead of a reimplementation, so parser fixes can't silently regress each other.
  try {
    if (globalThis.__PCE_EXPORT_FOR_TESTS__) {
      globalThis.__PCE_TEST__ = {
        parseStepEl,
        parseFilter,
        parseRoutesStatic,
        cleanValue,
        cleanText,
        extractRefs,
        valueFromGroup
      };
    }
  } catch (_) {}
})();

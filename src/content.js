(() => {
  const TAG = "PABBLY_CAPTURE";
  const CONTENT_VERSION = "0.9.3";

  const localCaptures = [];
  let lastResult = null;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__pabblyTag !== TAG) return;
    localCaptures.push(data.payload);
    try {
      chrome.runtime.sendMessage({ type: "capture", payload: data.payload });
    } catch (_) {}
  });

  const cleanText = (el) => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
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

  const parseIndex = (raw) => {
    const m = (raw || "").match(/\d+(?:\.\d+)*/);
    if (!m) return { order: null, indexLabel: null };
    return { order: parseFloat(m[0]), indexLabel: m[0] };
  };

  const SKIP_LABELS = /^(choose app|action event|connect .*|reconnect.*)$/i;

  const cleanValue = (v) => {
    if (typeof v !== "string") return v;
    return v
      .replace(/<span class="pabbly-connect-linebreak"[^>]*>[\s\S]*?<\/span>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<!--endofdynamic_value-->/gi, "")
      .replace(/<span\s+class="dynamic_value"[^>]*data-attr="[^"]*"\s*>/gi, "")
      .replace(/<\/?span[^>]*>/gi, "")
      .replace(/\{\{\{_map_val_\{\{\{/g, "")
      .replace(/\}\}\}_map_val_\}\}\}/g, "")
      .replace(/data_sign="endofdynamic_value"/gi, "")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  };

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
      const clean = cleanValue(rawVal);
      if (clean === "") return;
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

    const bodyEl = root.querySelector(".card-body");
    const text = bodyEl ? cleanText(bodyEl).slice(0, 2500) : "";
    const filter = root.querySelector(".filter_mapping_con") ? parseFilter(root) : null;
    const routes = root.querySelector(".router_mapping_main_div") ? parseRoutesStatic(root) : null;
    return { id, order, indexLabel, app, event, mappings, filter, routes, text };
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
        if (field || value) conditions.push({ field, operator, value });
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

  const scrapeDom = () => ({
    url: location.href,
    title: currentName(),
    currentWorkflowName: currentName(),
    inventory: scrapeInventory(),
    steps: parseWorkflow(),
    fullText: (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 30000)
  });

  const stepHeaders = () =>
    [...document.querySelectorAll(".card-header")].filter((h) => h.querySelector(".gbl_module_index"));

  const waitForBody = async (card, tries = 10, gap = 400) => {
    for (let i = 0; i < tries; i++) {
      const body = card.querySelector(".card-body");
      if (
        body &&
        body.offsetParent !== null &&
        (body.querySelector(".choose_app_name_ele") || body.querySelector(".form-group"))
      ) {
        return;
      }
      await delay(gap);
    }
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

  const waitForRouteModalOpen = async (tries = 20, gap = 300) => {
    for (let i = 0; i < tries; i++) {
      const open = visibleRouteModals()[0];
      if (open) return open;
      await delay(gap);
    }
    return null;
  };

  const waitForRouteChildren = async (modal, tries = 20, gap = 400) => {
    for (let i = 0; i < tries; i++) {
      const n = modal.querySelectorAll(".router_div_con .webhook_api_mapping_div").length;
      if (n > 0) return n;
      await delay(gap);
    }
    return 0;
  };

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

  const expandNestedRouter = async (childDiv, stepDelay, depth) => {
    const header = childDiv.querySelector(".card-header");
    if (!header) return null;
    header.click();
    let rows = [];
    for (let i = 0; i < 25; i++) {
      rows = [...childDiv.querySelectorAll(".router_mapping_main_div .all_router_mapping")].filter(isShown);
      if (rows.length) break;
      await delay(400);
    }
    if (!rows.length) {
      LOG(`nested router (depth ${depth}): no sub-routes loaded`);
      return null;
    }
    LOG(`nested router (depth ${depth}): ${rows.length} sub-route(s)`);
    const { routes } = await parseRouterRoutes(rows, stepDelay, depth);
    return routes;
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
    const routerDebug = [];
    let idx = 0;
    for (const root of roots) {
      idx++;
      const header = root.querySelector(".card-header");
      const body = root.querySelector(".card-body");
      const isOpen = body && body.offsetParent !== null;
      const headerText = cleanText(root.querySelector(".curr_app_name")) || "(no header)";
      LOG(`step ${idx}/${roots.length}: "${headerText}" — open=${isOpen}, clicking=${!isOpen}`);
      if (!isOpen && header) {
        header.click();
        await delay(stepDelay);
      }
      await waitForBody(root);
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
    return { rich, total: roots.length, debug, outline: outline0, census: { before, after: census() } };
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "ping") {
      sendResponse({ ready: true, version: CONTENT_VERSION, url: location.href, name: currentName() });
      return true;
    }
    if (msg.type === "scrapeDom") {
      sendResponse(scrapeDom());
      return true;
    }
    if (msg.type === "getLastResult") {
      sendResponse(lastResult);
      return true;
    }
    if (msg.type === "expandAndParse") {
      (async () => {
        const { rich, total, debug, outline, census: cen } = await expandAndParseAll(msg.stepDelay);
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
          const crawl = await crawlRouters(msg.stepDelay);
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

        lastResult = {
          name: currentName(),
          url: location.href,
          steps: mergeWithOutline(rich, outline),
          expand: { total, parsed: rich.size, debug, routerDebug, census: cen, captures: localCaptures.length }
        };
        LOG("expandAndParse complete — result stored (retrievable via getLastResult)");
        sendResponse(lastResult);
      })();
      return true;
    }
    return true;
  });
})();

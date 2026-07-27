// Zapier page adapter.
//
// Loaded by the manifest immediately before src/content.js, in the same isolated-world scope, and
// only on *.zapier.com. It registers itself on __PCE_ADAPTER; the shell in content.js routes
// messages to it.
//
// Unlike Pabbly (server-rendered HTML that must be clicked open one step at a time), Zapier's
// editor is a Next.js SPA that fetches the whole Zap as JSON. So nothing here clicks anything:
//
//   1. LEARN  — find, among the responses the page fetched for itself, the one carrying the node
//               array, and turn its URL into a template by substituting the Zap id. Cached.
//   2. FETCH  — every other Zap is then read in place with that template and the session cookie.
//               No tab navigation, no DOM walking.
//   3. FALL BACK — server-rendered __NEXT_DATA__, then a small list of candidate endpoints, then
//               (reported up to the crawler) navigate-and-parse like Pabbly.
//
// The endpoints are undocumented and Zapier can change them, so the learned template always wins
// over the guesses and the whole chain degrades rather than throwing.
(() => {
  const localCaptures = (globalThis.__PCE_CAPTURES = globalThis.__PCE_CAPTURES || []);

  const LOG = (...a) => {
    try {
      console.log("%c[PCE]", "color:#ff4a00;font-weight:bold", ...a);
    } catch (_) {}
  };
  const ERR = (...a) => {
    try {
      console.error("%c[PCE ERROR]", "color:#ff5b5b;font-weight:bold", ...a);
    } catch (_) {}
  };

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const TEMPLATE_KEY = "zapier_zap_template";
  const LIST_TEMPLATE_KEY = "zapier_list_template";
  const MAX_BRANCH_DEPTH = 5;

  // Tried only when nothing has been learned yet. A hit is promoted to the cached template; a miss
  // costs one request. Never the sole mechanism — see the header comment.
  const CANDIDATE_ZAP_TEMPLATES = [
    "/api/v4/nodes/?root_id={id}&limit=250",
    "/api/v4/zaps/{id}/",
    "/api/v3/zaps/{id}/",
    "/api/v1/zaps/{id}/nodes/"
  ];
  const CANDIDATE_LIST_URLS = [
    "/api/v4/zaps/?limit=250",
    "/api/v3/zaps/?limit=250",
    "/api/v1/zaps/?limit=250"
  ];

  // ---------------------------------------------------------------- page reading

  const zapIdFrom = (url) => {
    const m = String(url || "").match(/\/(?:app\/)?editor\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  };

  const currentZapId = () => zapIdFrom(location.href);

  const nextData = () => {
    const el = document.getElementById("__NEXT_DATA__");
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || "null");
    } catch (_) {
      return null;
    }
  };

  const nextDataFromHtml = (html) => {
    const m = String(html || "").match(
      /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
    );
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch (_) {
      return null;
    }
  };

  const currentName = () => {
    const title = (document.title || "").replace(/\s*[|·-]\s*Zapier\s*$/i, "").trim();
    if (title && !/^editor$/i.test(title)) return title;
    const heading = document.querySelector('[data-testid*="zap-name"], h1');
    const text = heading && heading.textContent ? heading.textContent.trim() : "";
    return text || title || null;
  };

  const getJson = async (url) => {
    const res = await fetch(new URL(url, location.origin).href, {
      credentials: "include",
      headers: { accept: "application/json" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  const getText = async (url) => {
    const res = await fetch(new URL(url, location.origin).href, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };

  const cached = async (key) => {
    try {
      return (await chrome.storage.local.get(key))[key] || null;
    } catch (_) {
      return null;
    }
  };

  const cache = async (key, value) => {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (_) {}
  };

  // ---------------------------------------------------------------- shape detection

  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  const NODE_KEYS = [
    "selected_api",
    "params",
    "params_v2",
    "parent_id",
    "root_id",
    "action",
    "authentication_id",
    "type_of",
    "meta"
  ];

  const nodeId = (n) => (n && (n.id != null ? n.id : n.node_id != null ? n.node_id : n.pk)) ?? null;

  const scoreAsNode = (o) => {
    if (!isObject(o)) return 0;
    let score = 0;
    for (const k of NODE_KEYS) if (k in o) score += 2;
    if (nodeId(o) != null) score += 1;
    if ("type" in o || "type_of" in o) score += 1;
    return score;
  };

  const scoreAsNodeArray = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return 0;
    const objects = arr.filter(isObject);
    if (!objects.length) return 0;
    const strong = objects.some((o) => "selected_api" in o || "params" in o || "params_v2" in o);
    if (!strong) return 0;
    return objects.reduce((s, o) => s + scoreAsNode(o), 0) / objects.length;
  };

  const findNodeArray = (root) => {
    let best = null;
    const visit = (node, path, depth) => {
      if (depth > 8) return;
      if (Array.isArray(node)) {
        const score = scoreAsNodeArray(node);
        if (score >= 4 && (!best || score > best.score || node.length > best.arr.length)) {
          best = { path, score, arr: node };
        }
        node.forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1));
        return;
      }
      if (isObject(node)) {
        for (const [k, v] of Object.entries(node)) visit(v, path ? `${path}.${k}` : k, depth + 1);
      }
    };
    visit(root, "", 0);
    return best;
  };

  const LIST_KEYS = ["title", "state", "status", "is_enabled", "paused", "last_successful_run", "zap_id"];

  const scoreAsZapList = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return 0;
    const objects = arr.filter(isObject);
    if (!objects.length) return 0;
    // A node array also has `id` + `title`; the discriminator is that Zap records never carry the
    // node-only wiring fields.
    if (objects.some((o) => "parent_id" in o || "selected_api" in o)) return 0;
    const withId = objects.filter((o) => nodeId(o) != null);
    if (withId.length < objects.length / 2) return 0;
    const avg =
      objects.reduce((s, o) => s + LIST_KEYS.reduce((n, k) => n + (k in o ? 1 : 0), 0), 0) /
      objects.length;
    return avg >= 1 ? avg * Math.min(objects.length, 50) : 0;
  };

  const findZapList = (root) => {
    let best = null;
    const visit = (node, depth) => {
      if (depth > 8) return;
      if (Array.isArray(node)) {
        const score = scoreAsZapList(node);
        if (score > 0 && (!best || score > best.score)) best = { score, arr: node };
        node.forEach((v) => visit(v, depth + 1));
        return;
      }
      if (isObject(node)) for (const v of Object.values(node)) visit(v, depth + 1);
    };
    visit(root, 0);
    return best;
  };

  // ---------------------------------------------------------------- node → canonical step

  const BUILTIN_NAMES = {
    Webhook: "Webhooks by Zapier",
    "Webhook App": "Webhooks by Zapier",
    Code: "Code by Zapier",
    Filter: "Filter by Zapier",
    Paths: "Paths by Zapier",
    Delay: "Delay by Zapier",
    Digest: "Digest by Zapier",
    Formatter: "Formatter by Zapier",
    Storage: "Storage by Zapier",
    Email: "Email by Zapier",
    "Email Parser": "Email Parser by Zapier",
    Schedule: "Schedule by Zapier",
    Looping: "Looping by Zapier",
    "Sub Zap": "Sub-Zap by Zapier",
    RSS: "RSS by Zapier",
    SMS: "SMS by Zapier",
    Translate: "Translate by Zapier",
    Weather: "Weather by Zapier",
    Zapier: "Zapier Manager"
  };

  // Zapier's own app identifier, e.g. `GmailAPI@2.0.0` or `EmailParserCLIAPI@1.1.2`. Deliberately
  // rejects anything with a space so a genuine app title like "Zoho API" is left alone.
  const looksLikeApiId = (v) => /^[A-Za-z0-9_]+(?:CLI)?API(?:@[\d.]+)?$/.test(String(v || ""));

  const humanizeApi = (v) => {
    const base = String(v || "").split("@")[0];
    if (!base) return null;
    const stripped = base.replace(/CLIAPI$/i, "").replace(/API$/i, "");
    const spaced = stripped
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!spaced) return null;
    return BUILTIN_NAMES[spaced] || spaced;
  };

  const TYPE_MAP = {
    read: "trigger",
    trigger: "trigger",
    write: "action",
    create: "action",
    search: "action",
    search_or_write: "action",
    action: "action",
    code: "action",
    delay: "action",
    filter: "filter",
    paths: "router",
    path: "filter"
  };

  const rawType = (n) => String((n && (n.type || n.type_of)) || "").toLowerCase();
  const stepType = (n) => TYPE_MAP[rawType(n)] || "action";

  // `paths` (plural) is the branch POINT — the Paths by Zapier step itself. `path` (singular) is one
  // branch, and is a perfectly ordinary step in that branch's chain. Conflating the two turns every
  // single-action Path into a router wrapping itself.
  const isPathsNode = (n) => rawType(n) === "paths" || /^paths by zapier$/i.test(appOf(n) || "");

  function appOf(n) {
    if (!isObject(n)) return null;
    const t = rawType(n);
    if (t === "paths") return "Paths by Zapier";
    if (t === "path") return "Filter by Zapier";

    const meta = isObject(n.meta) ? n.meta : {};
    const direct = [meta.app_title, meta.app_name, n.app_title, n.app_name, n.app, n.service].find(
      (v) => typeof v === "string" && v.trim()
    );
    // Nodes often set `app` to the same raw identifier as `selected_api`, which would otherwise
    // short-circuit straight past the humanizer and export "EmailParserCLIAPI@1.1.2" as the app name.
    if (direct && !looksLikeApiId(direct)) return direct.trim();

    const fromApi = humanizeApi(n.selected_api || n.api || meta.selected_api || direct);
    if (fromApi) return fromApi;

    if (t === "filter") return "Filter by Zapier";
    if (t === "code") return "Code by Zapier";
    return n.title ? String(n.title) : null;
  }

  const titleOf = (n) => {
    const meta = isObject(n.meta) ? n.meta : {};
    const v = n.title || meta.title || n.label || meta.label || null;
    return v ? String(v).trim() : null;
  };

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Apps built on Zapier's CLI platform identify their action by UUID rather than by key, so the
  // raw `action` can be an opaque id. The step's own title is what the editor shows, and it is the
  // only thing useful for writing code, so it wins over an id.
  const eventOf = (n) => {
    const meta = isObject(n.meta) ? n.meta : {};
    const label = meta.action_label || n.action_label || meta.event_label;
    if (label) return String(label);

    const action = n.action || n.event || meta.action || null;
    if (action && !UUID_RE.test(String(action))) return String(action);

    return titleOf(n) || (action ? String(action) : null);
  };

  const paramsOf = (n) => {
    for (const key of ["params_v2", "params", "inputs", "config"]) {
      if (isObject(n[key]) && Object.keys(n[key]).length) return n[key];
    }
    return null;
  };

  const flatValue = (v) => {
    if (v == null) return null;
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try {
      return JSON.stringify(v);
    } catch (_) {
      return String(v);
    }
  };

  // Zapier writes cross-step references as {{123456789__field_path}} (older Zaps use a dot). The
  // number is the SOURCE NODE ID, not its position, so it is resolved to an order later once every
  // node has been assigned one.
  const REF_RE = /\{\{\s*(\d+)(?:__|\.)([^}]+?)\s*\}\}/g;

  const rawRefs = (value) => {
    if (typeof value !== "string") return null;
    const refs = [];
    const seen = new Set();
    let m;
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(value))) {
      const key = `${m[1]}|${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ nodeId: m[1], field: m[2].trim() });
    }
    return refs.length ? refs : null;
  };

  // `skipKey` drops the raw conditions blob for a step whose conditions were already parsed into
  // `filter` — otherwise every filter step carries the same data twice, once as unreadable JSON.
  const mappingsFrom = (params, skipKey) => {
    if (!params) return [];
    const out = [];
    for (const [key, raw] of Object.entries(params)) {
      if (key.startsWith("_") || key === skipKey) continue;
      const value = flatValue(raw);
      if (value == null || value === "") continue;
      const refs = rawRefs(value);
      out.push(refs ? { field: key, value, __refs: refs } : { field: key, value });
    }
    return out;
  };

  const CONDITION_KEY = /^(filter|filters|conditions|rules|criteria)$/i;

  const normalizeCondition = (c) => {
    if (!isObject(c)) return null;
    const field = c.key ?? c.field ?? c.left ?? c.lhs ?? null;
    const operator = c.op ?? c.operator ?? c.comparison ?? c.condition ?? null;
    const value = c.val ?? c.value ?? c.right ?? c.rhs ?? null;
    if (field == null && value == null) return null;
    return {
      field: field == null ? null : String(field),
      operator: operator == null ? null : String(operator),
      value: value == null ? null : flatValue(value)
    };
  };

  // Zapier stores filters as an array of OR-groups, each an array of AND-conditions. A flat array
  // of conditions (some older Zaps, and Path nodes) is treated as a single AND group. Returns the
  // source key too so the caller can keep the raw blob out of `mappings`.
  const conditionsFrom = (params) => {
    if (!params) return { groups: null, key: null };
    const entry = Object.entries(params).find(
      ([k, v]) => CONDITION_KEY.test(k) && Array.isArray(v) && v.length
    );
    if (!entry) return { groups: null, key: null };
    const raw = entry[1];
    const source = Array.isArray(raw[0]) ? raw : [raw];
    const groups = [];
    source.forEach((group, i) => {
      if (!Array.isArray(group)) return;
      const conditions = group.map(normalizeCondition).filter(Boolean);
      if (conditions.length) groups.push({ joiner: i === 0 ? "AND" : "OR", conditions });
    });
    return groups.length ? { groups, key: entry[0] } : { groups: null, key: null };
  };

  const filterFrom = (params) => conditionsFrom(params).groups;

  // Pabbly needs `text` as a fallback because its mappings are scraped and can miss things. Zapier's
  // mappings ARE the params, so dumping them here again just doubles the file and burns context in
  // the very model call the export exists for. The dump is kept only when nothing reached mappings,
  // where it is the sole record of the step's config. ASCII separator on purpose — this project has
  // been bitten twice by mojibake in generated output.
  const summaryText = (n, params, mappings) => {
    const head = [titleOf(n), n.selected_api, n.action].filter(Boolean).join(" | ");
    if (mappings && mappings.length) return head.slice(0, 300);
    let dump = "";
    try {
      dump = params ? JSON.stringify(params) : "";
    } catch (_) {}
    return `${head}${dump ? ` | ${dump}` : ""}`.slice(0, 2500);
  };

  const mapNode = (n, order) => {
    const params = paramsOf(n);
    const { groups, key } = conditionsFrom(params);
    const mappings = mappingsFrom(params, key);
    return {
      id: nodeId(n) == null ? null : String(nodeId(n)),
      order,
      indexLabel: String(order),
      type: stepType(n),
      app: appOf(n),
      event: eventOf(n),
      title: titleOf(n),
      mappings,
      filter: groups,
      routes: null,
      text: summaryText(n, params, mappings)
    };
  };

  // ---------------------------------------------------------------- flat nodes → step tree

  const buildIndex = (nodes) => {
    const byId = new Map();
    const children = new Map();
    nodes.forEach((n) => {
      const id = nodeId(n);
      if (id != null) byId.set(String(id), n);
    });
    nodes.forEach((n) => {
      const parent = n.parent_id != null ? String(n.parent_id) : null;
      if (parent == null || !byId.has(parent)) return;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(n);
    });
    const roots = nodes.filter((n) => {
      const parent = n.parent_id != null ? String(n.parent_id) : null;
      return parent == null || !byId.has(parent);
    });
    return { byId, children, roots };
  };

  const childrenOf = (idx, n) => {
    const id = nodeId(n);
    return id == null ? [] : idx.children.get(String(id)) || [];
  };

  const routeNameOf = (n, i) => titleOf(n) || `Path ${String.fromCharCode(65 + i)}`;

  // Walks the linear chain from `start`, following single children. A node with more than one child
  // (or an explicit Paths node) ends the chain and becomes a router whose routes are the subtrees.
  const collectChain = (start, idx, counter, depth) => {
    const steps = [];
    let cur = start;
    while (cur) {
      const step = mapNode(cur, ++counter.n);
      counter.orderById.set(step.id, step.order);
      steps.push(step);

      const kids = childrenOf(idx, cur);
      const branches = kids.length > 1 || (isPathsNode(cur) && kids.length >= 1);

      if (branches) {
        if (depth >= MAX_BRANCH_DEPTH) {
          step.type = "router";
          step.nestedRouter = true;
          step.depthCapped = true;
          return steps;
        }
        step.type = "router";
        step.routes = kids.map((kid, i) => {
          const branch = collectChain(kid, idx, counter, depth + 1);
          return {
            routeOrder: i + 1,
            routeName: routeNameOf(kid, i),
            routeId: nodeId(kid) == null ? null : String(nodeId(kid)),
            stepCount: branch.length,
            steps: branch
          };
        });
        return steps;
      }

      cur = kids[0] || null;
    }
    return steps;
  };

  // Zapier numbers references by node id; the exported schema numbers steps by order. This is the
  // pass that converts one to the other, once every node has an order.
  const resolveRefs = (steps, orderById) => {
    (steps || []).forEach((s) => {
      (s.mappings || []).forEach((m) => {
        if (!m.__refs) return;
        const refs = m.__refs
          .map((r) => ({ step: orderById.get(r.nodeId) || null, field: r.field }))
          .filter((r) => r.step != null);
        delete m.__refs;
        if (refs.length) m.references = refs;
      });
      (s.routes || []).forEach((r) => resolveRefs(r.steps, orderById));
    });
  };

  const nodesToSteps = (nodes) => {
    const usable = (nodes || []).filter(isObject);
    if (!usable.length) return [];
    const idx = buildIndex(usable);
    const counter = { n: 0, orderById: new Map() };

    let steps;
    if (idx.roots.length === 1) {
      steps = collectChain(idx.roots[0], idx, counter, 0);
    } else if (idx.roots.length > 1 && idx.children.size) {
      // Several disconnected roots: order them and walk each, rather than dropping any.
      steps = idx.roots.flatMap((r) => collectChain(r, idx, counter, 0));
    } else {
      // No usable parent wiring at all — fall back to document order.
      steps = usable.map((n) => {
        const step = mapNode(n, ++counter.n);
        counter.orderById.set(step.id, step.order);
        return step;
      });
    }

    resolveRefs(steps, counter.orderById);
    return steps;
  };

  // ---------------------------------------------------------------- capture sources

  const captureCandidates = (zapId) =>
    localCaptures
      .filter((c) => c && c.body && typeof c.body === "object")
      .map((c) => ({ capture: c, hit: findNodeArray(c.body) }))
      .filter((x) => x.hit)
      // Prefer a response whose URL names this Zap: on the editor page several Zaps' data can be
      // in the buffer at once (the SPA prefetches), and the largest array is not always this one.
      .sort((a, b) => {
        const aOwn = zapId && String(a.capture.url || "").includes(zapId) ? 1 : 0;
        const bOwn = zapId && String(b.capture.url || "").includes(zapId) ? 1 : 0;
        if (aOwn !== bOwn) return bOwn - aOwn;
        return b.hit.arr.length - a.hit.arr.length;
      });

  const templateFrom = (url, zapId) => {
    if (!url || !zapId) return null;
    let abs;
    try {
      abs = new URL(url, location.origin).href;
    } catch (_) {
      return null;
    }
    if (!abs.includes(zapId)) return null;
    return abs.split(zapId).join("{id}");
  };

  const learnFromCaptures = async (zapId) => {
    for (const { capture } of captureCandidates(zapId)) {
      const template = templateFrom(capture.url, zapId);
      if (!template) continue;
      await cache(TEMPLATE_KEY, template);
      LOG(`learned Zap endpoint template: ${template}`);
      return template;
    }
    return null;
  };

  const nodesFromTemplate = async (template, id) => {
    const url = template.replace(/\{id\}/g, encodeURIComponent(id));
    const json = await getJson(url);
    const hit = findNodeArray(json);
    return hit ? hit.arr : null;
  };

  const learnFromCandidates = async (zapId) => {
    for (const template of CANDIDATE_ZAP_TEMPLATES) {
      try {
        const nodes = await nodesFromTemplate(template, zapId);
        if (nodes && nodes.length) {
          const abs = new URL(template, location.origin).href;
          await cache(TEMPLATE_KEY, abs);
          LOG(`candidate endpoint worked: ${abs}`);
          return abs;
        }
      } catch (e) {
        LOG(`candidate endpoint ${template} — ${(e && e.message) || e}`);
      }
    }
    return null;
  };

  const ensureTemplate = async (zapId) => {
    const saved = await cached(TEMPLATE_KEY);
    if (saved) return saved;
    if (!zapId) return null;
    return (await learnFromCaptures(zapId)) || (await learnFromCandidates(zapId));
  };

  const nodesFromSsr = async (id) => {
    const html = await getText(`/editor/${encodeURIComponent(id)}`);
    const data = nextDataFromHtml(html);
    if (!data) return null;
    const hit = findNodeArray(data);
    return hit ? hit.arr : null;
  };

  // Every way of getting one Zap's nodes, cheapest first.
  const nodesForZap = async (id, { allowCaptures = false } = {}) => {
    if (allowCaptures) {
      const fromPage = nextData();
      const hit = fromPage && findNodeArray(fromPage);
      if (hit && hit.arr.length) return { nodes: hit.arr, via: "__NEXT_DATA__" };
      const best = captureCandidates(id)[0];
      if (best) return { nodes: best.hit.arr, via: `intercepted ${best.capture.url}` };
    }

    const template = await ensureTemplate(id);
    if (template) {
      try {
        const nodes = await nodesFromTemplate(template, id);
        if (nodes && nodes.length) return { nodes, via: template };
      } catch (e) {
        LOG(`template fetch failed for ${id}: ${(e && e.message) || e}`);
      }
    }

    try {
      const nodes = await nodesFromSsr(id);
      if (nodes && nodes.length) return { nodes, via: "server-rendered editor page" };
    } catch (e) {
      LOG(`SSR fetch failed for ${id}: ${(e && e.message) || e}`);
    }

    return null;
  };

  // ---------------------------------------------------------------- inventory

  const inventoryEntry = (z) => ({
    id: String(nodeId(z)),
    name: String(z.title || z.name || z.label || `Zap ${nodeId(z)}`).trim(),
    state: z.state || z.status || (z.is_enabled === false ? "off" : z.is_enabled === true ? "on" : null),
    webhookUrl: z.webhook_url || z.url || ""
  });

  const inventoryFromDom = () => {
    const seen = new Map();
    document.querySelectorAll('a[href*="/editor/"]').forEach((a) => {
      const id = zapIdFrom(a.getAttribute("href") || "");
      if (!id || seen.has(id)) return;
      const name = (a.textContent || "").replace(/\s+/g, " ").trim();
      seen.set(id, { id, name: name || `Zap ${id}`, state: null, webhookUrl: "" });
    });
    return [...seen.values()];
  };

  const scrapeInventory = async () => {
    const sources = [nextData(), ...localCaptures.filter((c) => c && typeof c.body === "object").map((c) => c.body)];
    for (const src of sources) {
      const hit = src && findZapList(src);
      if (hit && hit.arr.length) return hit.arr.map(inventoryEntry);
    }

    const savedList = await cached(LIST_TEMPLATE_KEY);
    for (const url of savedList ? [savedList, ...CANDIDATE_LIST_URLS] : CANDIDATE_LIST_URLS) {
      try {
        const json = await getJson(url);
        const hit = findZapList(json);
        if (hit && hit.arr.length) {
          await cache(LIST_TEMPLATE_KEY, new URL(url, location.origin).href);
          return hit.arr.map(inventoryEntry);
        }
      } catch (e) {
        LOG(`zap list ${url} — ${(e && e.message) || e}`);
      }
    }

    return inventoryFromDom();
  };

  // ---------------------------------------------------------------- adapter surface

  const scrapeDom = async () => {
    const id = currentZapId();
    let steps = [];
    if (id) {
      try {
        const found = await nodesForZap(id, { allowCaptures: true });
        if (found) steps = nodesToSteps(found.nodes);
      } catch (e) {
        ERR("scrapeDom node read failed:", e);
      }
    }
    return {
      url: location.href,
      title: currentName(),
      currentWorkflowName: currentName(),
      inventory: await scrapeInventory(),
      steps,
      fullText: (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 30000)
    };
  };

  // The SPA fetches its Zap asynchronously, so on a fresh page load the buffer can still be empty
  // when the side panel asks. Poll briefly before falling back to a direct fetch.
  const waitForNodes = async (id, tries = 12, gap = 700) => {
    for (let i = 0; i < tries; i++) {
      const fromPage = nextData();
      const hit = fromPage && findNodeArray(fromPage);
      if (hit && hit.arr.length) return { nodes: hit.arr, via: "__NEXT_DATA__" };
      const best = captureCandidates(id)[0];
      if (best) return { nodes: best.hit.arr, via: `intercepted ${best.capture.url}` };
      await delay(gap);
    }
    return null;
  };

  const expandAndParse = async () => {
    const id = currentZapId();
    if (!id) {
      return {
        name: currentName(),
        url: location.href,
        steps: [],
        expand: { error: "not a Zap editor URL — open a Zap, then capture", captures: localCaptures.length }
      };
    }

    let found = await waitForNodes(id);
    if (!found) found = await nodesForZap(id);
    if (!found) {
      return {
        name: currentName(),
        url: location.href,
        steps: [],
        expand: {
          error: "no Zap definition found in the page, the intercepted responses, or the API",
          captures: localCaptures.length,
          capturedUrls: localCaptures.slice(-40).map((c) => c.url)
        }
      };
    }

    const steps = nodesToSteps(found.nodes);
    LOG(`parsed Zap ${id}: ${steps.length} top-level step(s) via ${found.via}`);
    return {
      name: currentName(),
      url: location.href,
      steps,
      expand: {
        total: found.nodes.length,
        parsed: steps.length,
        via: found.via,
        captures: localCaptures.length
      }
    };
  };

  // Called once before a bulk run. If a template can be established the crawler reads every Zap in
  // place; otherwise it reports back and the run falls through to navigate-and-parse.
  const prepareBulk = async () => {
    const id = currentZapId();
    let template = await cached(TEMPLATE_KEY);

    if (!template && id) template = await ensureTemplate(id);

    if (!template) {
      // Nothing learned yet and we are not sitting on a Zap (e.g. the list page). Try the
      // candidates against the first Zap we know about.
      const inv = await scrapeInventory();
      if (inv.length) template = await ensureTemplate(inv[0].id);
    }

    if (template) return { direct: true, template };
    return { direct: false, reason: "no Zap endpoint could be learned — falling back to navigation" };
  };

  const captureById = async (id) => {
    if (!id) return { error: "no Zap id" };
    try {
      const found = await nodesForZap(id);
      if (!found) return { needsNavigation: true };
      return {
        name: null,
        url: `${location.origin}/editor/${id}`,
        steps: nodesToSteps(found.nodes),
        via: found.via
      };
    } catch (e) {
      ERR(`captureById ${id} failed:`, e);
      return { needsNavigation: true, error: String((e && e.message) || e) };
    }
  };

  const diagnostics = async () => ({
    platform: "zapier",
    zapId: currentZapId(),
    learnedTemplate: await cached(TEMPLATE_KEY),
    learnedListUrl: await cached(LIST_TEMPLATE_KEY),
    candidateTemplates: CANDIDATE_ZAP_TEMPLATES,
    hasNextData: !!nextData(),
    nodeArraysInCaptures: captureCandidates(currentZapId()).map((x) => ({
      url: x.capture.url,
      count: x.hit.arr.length,
      path: x.hit.path
    })),
    captures: localCaptures.length
  });

  globalThis.__PCE_ADAPTER = {
    id: "zapier",
    currentName,
    scrapeDom,
    expandAndParse,
    prepareBulk,
    captureById,
    diagnostics
  };

  try {
    if (globalThis.__PCE_EXPORT_FOR_TESTS__) {
      globalThis.__PCE_TEST_ZAPIER__ = {
        nodesToSteps,
        appOf,
        eventOf,
        findNodeArray,
        findZapList,
        humanizeApi,
        filterFrom,
        mappingsFrom,
        templateFrom,
        zapIdFrom,
        inventoryEntry
      };
    }
  } catch (_) {}
})();

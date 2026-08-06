// Reads the workflow catalogue from Pabbly Connect's v2 REST backend.
//
// Loaded by the manifest as a content script before pabbly-content.js, in the same isolated-world scope;
// registers on __PCE_PABBLY_API.
//
// Why this exists, given three DOM-based readers already do: the v2 app is a React front end over a JSON
// API, and the interceptor caught it calling its own endpoints. One request returns the whole catalogue:
//
//   /backend/api/workflows
//   /backend/api/task-usage-by-workflow/task-usage-summary-data?limit=300&page=1&workflowStatus=all&…
//
// That replaces 28 pages of clicking (or 2,383 of the run log), the dry-page stop heuristic, and reading
// ids out of React's fiber. Those paths stay as fallbacks — an undocumented endpoint can change without
// notice, so every stage degrades rather than throwing, exactly as the Zapier adapter does.
//
// Response shapes are NOT assumed. Pabbly wraps everything in {status, message, data}, but whether the
// records sit at `data`, `data.workflows`, `data.rows` or deeper is unknown and may differ per endpoint.
// So the array is discovered by content — the same trick as the Zapier adapter's findNodeArray — keyed
// off the distinctive id format rather than off any field name.
(() => {
  const BASE = "https://connect.pabbly.com";

  // "IjU3NjUwNTY0MDYzNTA0MzM1MjZjNTUzZDUxM2Ei_pc" — base64-ish, always suffixed `_pc`.
  const ID_RE = /^[A-Za-z0-9+/=_-]{10,}_pc$/;

  const isId = (v) => typeof v === "string" && ID_RE.test(v);

  // A folder id is the same shape as a workflow id, so field precedence matters: an explicit id key wins,
  // and any key that mentions a folder is never read as the workflow's own id.
  const idOf = (obj) => {
    const keys = Object.keys(obj);
    const preferred = keys.find((k) => /^(_?id|workflow_?id)$/i.test(k) && isId(obj[k]));
    if (preferred) return obj[preferred];
    const other = keys.find((k) => !/folder|parent|user|account|team/i.test(k) && isId(obj[k]));
    return other ? obj[other] : null;
  };

  const stringAt = (obj, re, exclude) => {
    const keys = Object.keys(obj).filter((k) => re.test(k) && (!exclude || !exclude.test(k)));
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.trim() && !isId(v)) return v.trim();
    }
    return null;
  };

  const nameOf = (obj) =>
    stringAt(obj, /^(name|workflow_?name|title)$/i, /folder/i) ||
    stringAt(obj, /name|title/i, /folder|file|user|account/i);

  const folderOf = (obj) => {
    const direct = stringAt(obj, /folder.*name|name.*folder/i);
    if (direct) return direct;
    for (const k of Object.keys(obj)) {
      if (!/folder/i.test(k)) continue;
      const v = obj[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const nested = stringAt(v, /name|title/i);
        if (nested) return nested;
      }
    }
    return null;
  };

  const numberAt = (obj, re) => {
    for (const k of Object.keys(obj)) {
      if (!re.test(k)) continue;
      const v = obj[k];
      if (typeof v === "number" && isFinite(v)) return v;
      if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
    }
    return null;
  };

  // Pabbly reports state as a boolean, a 0/1, or a word depending on the endpoint.
  const activeOf = (obj) => {
    for (const k of Object.keys(obj)) {
      if (!/^(status|state|is_?active|active|enabled)$/i.test(k)) continue;
      const v = obj[k];
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v === 1;
      if (typeof v === "string") {
        if (/^(active|enabled|on|true|1)$/i.test(v.trim())) return true;
        if (/^(inactive|disabled|off|false|0|paused)$/i.test(v.trim())) return false;
      }
    }
    return null;
  };

  const looksLikeRecords = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return false;
    const objs = arr.filter((e) => e && typeof e === "object" && !Array.isArray(e));
    if (objs.length !== arr.length) return false;
    const withId = objs.filter((e) => idOf(e)).length;
    // Requiring a clear majority rather than all of them: a catalogue with one malformed row is still
    // the catalogue, while a random array of props objects will not clear this bar.
    return withId / objs.length >= 0.8;
  };

  // Breadth-first so a shallow, complete array wins over a deeper partial one, and the longest at any
  // given depth wins — the same failure the Zapier adapter hit when a trunk-only list shadowed the graph.
  const findRecordArray = (payload, maxNodes = 4000) => {
    if (!payload || typeof payload !== "object") return null;
    const queue = [{ node: payload, path: "" }];
    let seen = 0;
    let best = null;

    while (queue.length && seen < maxNodes) {
      const { node, path } = queue.shift();
      seen += 1;
      if (looksLikeRecords(node)) {
        if (!best || node.length > best.arr.length) best = { arr: node, path: path || "(root)" };
        continue;
      }
      if (Array.isArray(node)) {
        node.forEach((v, i) => {
          if (v && typeof v === "object") queue.push({ node: v, path: `${path}[${i}]` });
        });
        continue;
      }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === "object") queue.push({ node: v, path: path ? `${path}.${k}` : k });
      }
    }
    return best;
  };

  const recordFrom = (obj) => ({
    id: idOf(obj),
    name: nameOf(obj),
    folder: folderOf(obj),
    active: activeOf(obj),
    tasks: numberAt(obj, /task.*consum|consum.*task|^tasks$/i),
    freeTasks: numberAt(obj, /free/i)
  });

  const parseCatalogue = (payload) => {
    const hit = findRecordArray(payload);
    if (!hit) return { workflows: [], path: null, error: "no record array found in the response" };
    const workflows = hit.arr.map(recordFrom).filter((w) => w.id);
    return { workflows, path: hit.path, total: hit.arr.length };
  };

  // Same-origin with the session cookie, so no token handling. `credentials: "include"` is required:
  // a bare fetch from the isolated world does not carry cookies by default in every Chrome version.
  const getJson = async (url) => {
    const res = await fetch(url, {
      credentials: "include",
      headers: { accept: "application/json" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  };

  const USAGE_PATH = "/backend/api/task-usage-by-workflow/task-usage-summary-data";
  const WORKFLOWS_PATH = "/backend/api/workflows";

  const usageUrl = (limit, page = 1) =>
    `${BASE}${USAGE_PATH}?limit=${limit}&page=${page}&sortBy=taskConsumption&sortOrder=desc` +
    `&workflowId=all&workflowStatus=all&filterByFolderId=all&search=`;

  // `limit=1` returns HTTP 400: the endpoint only accepts the page sizes its own UI offers, and probing
  // with an invalid one threw away the whole source. 10 is what the app itself sends, so it is the only
  // safe value to learn the total with.
  const PROBE_LIMIT = 10;
  const PAGE_LIMIT = 100;

  const fetchUsagePaged = async (pageSize = PAGE_LIMIT, maxPages = 60) => {
    const byId = new Map();
    let total = null;
    let pages = 0;

    for (let page = 1; page <= maxPages; page++) {
      const payload = await getJson(usageUrl(pageSize, page));
      pages += 1;
      if (total == null) total = findTotal(payload);
      const { workflows } = parseCatalogue(payload);
      if (!workflows.length) break;
      workflows.forEach((w) => byId.set(w.id, w));
      if (total != null && byId.size >= total) break;
      if (workflows.length < pageSize) break;
    }

    return {
      source: "task-usage-api",
      paged: pages,
      reportedTotal: total,
      workflows: [...byId.values()],
      complete: total == null ? null : byId.size >= total
    };
  };

  // One request when the server allows a limit that large, paging when it does not. Asking for the total
  // first means the single-request attempt is sized to the real count rather than to a guess.
  const fetchUsage = async (hardCap = 2000) => {
    const probe = await getJson(usageUrl(PROBE_LIMIT));
    const total = findTotal(probe);

    if (total != null && total <= PROBE_LIMIT) {
      const parsed = parseCatalogue(probe);
      return { source: "task-usage-api", reportedTotal: total, ...parsed, complete: parsed.workflows.length >= total };
    }

    if (total != null) {
      try {
        const full = await getJson(usageUrl(Math.min(hardCap, total)));
        const parsed = parseCatalogue(full);
        if (parsed.workflows.length >= total) {
          return { source: "task-usage-api", reportedTotal: total, ...parsed, complete: true };
        }
      } catch (_) {
        // The endpoint may cap or reject a large limit exactly as it rejected limit=1. Paging is the
        // documented-by-observation path, so fall through rather than treating this as fatal.
      }
    }

    return fetchUsagePaged();
  };

  const fetchWorkflows = async () => {
    const payload = await getJson(`${BASE}${WORKFLOWS_PATH}`);
    return { source: "workflows-api", url: `${BASE}${WORKFLOWS_PATH}`, ...parseCatalogue(payload) };
  };

  // The total is reported under some count-ish key whose exact name is unknown; the largest plausible
  // integer found under one wins, so a per-page `count` cannot masquerade as the grand total.
  const findTotal = (payload, maxNodes = 2000) => {
    if (!payload || typeof payload !== "object") return null;
    const queue = [payload];
    let seen = 0;
    let best = null;
    while (queue.length && seen < maxNodes) {
      const node = queue.shift();
      seen += 1;
      if (!node || typeof node !== "object") continue;
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (/total|count|records|totalRows|totalCount/i.test(k)) {
          const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null;
          if (n != null && (best == null || n > best)) best = n;
        }
        if (v && typeof v === "object") queue.push(v);
      }
    }
    return best;
  };

  // /backend/api/workflows is the spine: one unpaginated request, and it returned 430 against the usage
  // tab's 276 — because the usage tab only lists workflows that consumed tasks in the last 30 days, so it
  // silently omits every workflow that has been idle. A queue built from it would skip exactly the
  // dormant automations most likely to still hold a stale URL.
  //
  // The usage endpoint is then merged in for what only it knows: task counts, which give the queue a
  // sensible order. Its failure is non-fatal — the catalogue is already complete without it.
  const fetchCatalogue = async () => {
    const errors = [];

    let spine = null;
    try {
      spine = await fetchWorkflows();
      if (!spine.workflows.length) {
        errors.push({ source: "workflows-api", error: spine.error || "returned no workflows" });
        spine = null;
      }
    } catch (e) {
      errors.push({ source: "workflows-api", error: String((e && e.message) || e) });
    }

    let usage = null;
    try {
      usage = await fetchUsage();
      if (usage.workflows && !usage.workflows.length) usage = null;
    } catch (e) {
      errors.push({ source: "task-usage-api", error: String((e && e.message) || e) });
    }

    // Usage alone is a legitimate last resort: incomplete beats nothing, but it must say so.
    if (!spine) {
      if (!usage) return { source: null, workflows: [], errors };
      return { ...usage, partial: true, errors };
    }

    const tasksById = new Map();
    (usage && usage.workflows ? usage.workflows : []).forEach((w) => {
      if (w.id && w.tasks != null) tasksById.set(w.id, w);
    });

    const workflows = spine.workflows.map((w) => {
      const u = tasksById.get(w.id);
      return u ? { ...w, tasks: u.tasks, freeTasks: u.freeTasks } : w;
    });

    // Busiest first: if a long run is interrupted, the workflows that matter most are already done.
    workflows.sort((a, b) => (b.tasks || 0) - (a.tasks || 0));

    return {
      source: "workflows-api",
      path: spine.path,
      workflows,
      reportedTotal: usage ? usage.reportedTotal : null,
      counts: {
        total: workflows.length,
        active: workflows.filter((w) => w.active === true).length,
        inactive: workflows.filter((w) => w.active === false).length,
        withUsage: tasksById.size
      },
      errors
    };
  };

  globalThis.__PCE_PABBLY_API = {
    fetchCatalogue,
    fetchUsage,
    fetchWorkflows,
    parseCatalogue,
    findRecordArray,
    findTotal,
    recordFrom,
    usageUrl
  };

  try {
    if (globalThis.__PCE_EXPORT_FOR_TESTS__) globalThis.__PCE_TEST_PABBLY_API__ = globalThis.__PCE_PABBLY_API;
  } catch (_) {}
})();

const STEP_KEY_HINTS = /(app|module|action|trigger|event|step|node|method|service)/i;
const FILTER_HINTS = /(filter|condition|route|router|path|branch|criteria|rule)/i;
const MAPPING_HINTS = /(field|param|mapping|input|setup|data|body|value|config)/i;
const NAME_HINTS = ["app", "appName", "app_name", "name", "label", "title", "module", "service", "event", "action", "type"];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const pickName = (obj) => {
  for (const k of NAME_HINTS) {
    if (obj[k] && (typeof obj[k] === "string" || typeof obj[k] === "number")) {
      return String(obj[k]);
    }
  }
  return null;
};

const scoreAsStep = (obj) => {
  if (!isObject(obj)) return 0;
  let score = 0;
  for (const k of Object.keys(obj)) {
    if (STEP_KEY_HINTS.test(k)) score += 2;
    if (FILTER_HINTS.test(k)) score += 1;
    if (MAPPING_HINTS.test(k)) score += 1;
  }
  if (pickName(obj)) score += 1;
  return score;
};

const scoreAsStepArray = (arr) => {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const objects = arr.filter(isObject);
  if (objects.length === 0) return 0;
  const avg = objects.reduce((s, o) => s + scoreAsStep(o), 0) / objects.length;
  return avg * Math.min(objects.length, 20);
};

const findStepArrays = (root) => {
  const found = [];
  const visit = (node, path) => {
    if (Array.isArray(node)) {
      const score = scoreAsStepArray(node);
      if (score >= 3) found.push({ path, score, arr: node });
      node.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    if (isObject(node)) {
      for (const [k, v] of Object.entries(node)) visit(v, path ? `${path}.${k}` : k);
    }
  };
  visit(root, "");
  found.sort((a, b) => b.score - a.score);
  return found;
};

const extractMappings = (obj) => {
  const mappings = [];
  const walk = (node, prefix) => {
    if (isObject(node)) {
      for (const [k, v] of Object.entries(node)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v === null || typeof v !== "object") {
          mappings.push({ field: path, value: v });
        } else {
          walk(v, path);
        }
      }
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${prefix}[${i}]`));
    }
  };
  for (const [k, v] of Object.entries(obj)) {
    if (MAPPING_HINTS.test(k) && (isObject(v) || Array.isArray(v))) walk(v, k);
  }
  return mappings;
};

const classifyStep = (obj, index) => {
  const keys = Object.keys(obj).join(" ").toLowerCase();
  const name = (pickName(obj) || "").toLowerCase();
  if (/trigger/.test(keys) || index === 0) return "trigger";
  if (/router|route|branch|path/.test(keys) || /router/.test(name)) return "router";
  if (/filter|condition|criteria/.test(keys) || /filter/.test(name)) return "filter";
  return "action";
};

const normalizeStep = (obj, index) => ({
  order: index + 1,
  type: classifyStep(obj, index),
  app: pickName(obj),
  rawKeys: Object.keys(obj),
  mappings: extractMappings(obj)
});

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch (_) {
    return url || "unknown";
  }
};

const confidenceOf = (score) => (score >= 8 ? "high" : score >= 4 ? "medium" : "low");

export const SYSTEM_PROMPT =
  "This JSON was produced by the \"Pabbly → Code Extractor\" browser extension. It captured a single " +
  "Pabbly Connect automation directly from the live workflow page (by recording the JSON the Pabbly API " +
  "returned and supplementing it with the on-screen layout). The goal of this file is to let you understand " +
  "exactly what the automation does. Read it as follows:\n" +
  "- `schema.workflowName`: the automation's name.\n" +
  "- `schema.confidence`: how confident the extension's heuristic detection is (high/medium/low). It is a guess about structure, not a guarantee.\n" +
  "- `schema.steps[]`: the ordered steps of the automation. Each step has: `order` (sequence), `type` " +
  "(trigger | action | router | filter), `app` (the connected app/service), `event` (the specific action/" +
  "trigger event chosen in that app), `mappings` (the configured input fields as field/value pairs).\n" +
  "- In `mappings`, values written like `{{1.email}}` or `{{2.name}}` are references that pull data from an " +
  "earlier step's output, where the leading number is that step's `order`.\n" +
  "- Some steps (especially Filter and Router) also have a `text` field: the raw on-screen text of that " +
  "step's config. When `mappings` is empty or unclear, read `text` for the literal conditions/operators " +
  "(e.g. \"Equal to\", \"Exists\").\n" +
  "- A `filter` step has a `filter` array of condition groups. Groups are OR'd together; conditions inside a " +
  "group are AND'd. Each condition is `{ field, operator, value }` (e.g. field \"2. Data 0 Action\", operator " +
  "\"Equal to\", value \"CANCELLED_A_BOOKING\"). The workflow only continues past the filter when the conditions pass.\n" +
  "- A `router` step has a `routes[]` array — each route is a conditional branch with its own `routeName`, " +
  "`stepCount`, and ordered `steps[]` that run only when that route's condition matches. Inside a route, the " +
  "first step is usually a Filter that defines the branch condition. A route step marked `nestedRouter` is " +
  "itself a router; if it has its own `routes[]` those are the expanded sub-branches (routers nest " +
  "recursively). A `nestedRouter` with a `note` instead of `routes[]` hit the capture depth limit and was " +
  "not expanded further.\n" +
  "- `raw`: the untouched JSON returned by Pabbly for this workflow. It is the source of truth; if the " +
  "normalized `schema` looks incomplete, trust `raw`.\n" +
  "Your task here is only to understand this automation and explain it back accurately. Do not write code " +
  "unless you are explicitly asked to in a later message.";

export const detectWorkflows = (captures) => {
  const jsonCaptures = (captures || []).filter(
    (c) => c.body && (isObject(c.body) || Array.isArray(c.body))
  );

  const byKey = new Map();

  jsonCaptures.forEach((c) => {
    const top = findStepArrays(c.body)[0];
    if (!top) return;
    const steps = top.arr.filter(isObject).map(normalizeStep);
    const name =
      (isObject(c.body) && pickName(c.body)) ||
      (steps[0] && steps[0].app) ||
      `Workflow (${hostOf(c.url)})`;
    const key = `${name}::${steps.length}`;
    const workflow = {
      id: key,
      name,
      source: c.url,
      host: hostOf(c.url),
      stepArrayPath: top.path,
      confidence: confidenceOf(top.score),
      stepCount: steps.length,
      steps,
      rawBody: c.body,
      capturedAt: c.at || null
    };
    byKey.set(key, workflow);
  });

  return [...byKey.values()].sort((a, b) => b.stepCount - a.stepCount);
};

export const INVENTORY_SYSTEM_PROMPT =
  "This JSON was produced by the \"Pabbly → Code Extractor\" browser extension. It is the full inventory of " +
  "Pabbly Connect automations (workflows) found in the account's workflow-switcher dropdown. Each entry has a " +
  "`name`, an internal `id`, and the `webhookUrl` that triggers it. This is a catalog only — it does not " +
  "contain the steps of each workflow. To get a single workflow's full step detail, open that workflow in " +
  "Pabbly and capture it individually. Use this list to understand the scope of what needs to be rebuilt.";

export const buildInventoryExport = (inventory, source) => ({
  systemPrompt: INVENTORY_SYSTEM_PROMPT,
  extension: {
    name: "Pabbly → Code Extractor",
    version: "0.8.9",
    purpose: "Lists every Pabbly Connect automation in the account.",
    capturedFrom: source || null
  },
  count: inventory.length,
  inventory
});

export const classifyType = (order, app) => {
  if (order === 1) return "trigger";
  if (/router/i.test(app || "")) return "router";
  if (/filter/i.test(app || "")) return "filter";
  return "action";
};

const routeStepType = (app) =>
  /router/i.test(app || "") ? "router" : /filter/i.test(app || "") ? "filter" : "action";

const routeStep = (cs, i) => {
  const expandedNested = cs.routes && cs.routes.length;
  return {
    order: cs.order || i + 1,
    type: routeStepType(cs.app),
    app: cs.app,
    event: cs.event || null,
    ...(cs.mappings && cs.mappings.length ? { mappings: cs.mappings } : {}),
    ...(cs.filter ? { filter: cs.filter } : {}),
    ...(expandedNested ? { nestedRouter: true, routes: cs.routes.map(routeFromParsed) } : {}),
    ...(cs.isRouter && !expandedNested
      ? { nestedRouter: true, note: "Nested router — sub-routes not expanded in this capture (depth limit)." }
      : {})
  };
};

const routeFromParsed = (r) => ({
  routeOrder: r.routeOrder,
  routeName: r.routeName,
  stepCount: r.stepCount,
  steps: (r.steps || []).map(routeStep)
});

const stepFromParsed = (s, i) => ({
  order: s.order || i + 1,
  ...(s.indexLabel && s.indexLabel !== String(s.order) ? { indexLabel: s.indexLabel } : {}),
  type: classifyType(s.order, s.app),
  app: s.app,
  event: s.event || null,
  rawKeys: [],
  mappings: s.mappings || [],
  ...(s.filter ? { filter: s.filter } : {}),
  ...(s.text ? { text: s.text } : {}),
  ...(s.routes ? { routes: s.routes.map(routeFromParsed) } : {})
});

export const workflowFromParsed = (name, url, steps) => ({
  workflowName: name || "Workflow",
  source: url || null,
  confidence: (steps || []).some((s) => s.mappings && s.mappings.length) ? "high" : "low",
  stepCount: (steps || []).length,
  steps: (steps || []).map(stepFromParsed)
});

export const domWorkflow = (dom) => {
  if (!dom || !dom.steps || !dom.steps.length) return null;
  const anyMappings = dom.steps.some((s) => (s.mappings && s.mappings.length) || s.filter || s.routes);
  return {
    id: `dom::${dom.currentWorkflowName || dom.url}`,
    name: dom.currentWorkflowName || "Current workflow",
    source: dom.url,
    host: hostOf(dom.url),
    stepArrayPath: "(parsed from live page DOM)",
    confidence: anyMappings ? "high" : "low",
    stepCount: dom.steps.length,
    steps: dom.steps.map(stepFromParsed),
    rawBody: {
      note: anyMappings
        ? "Parsed from the live page DOM after expanding steps."
        : "Step outline only — click each step open (or use Auto-capture) to load field mappings.",
      steps: dom.steps
    },
    capturedAt: null
  };
};

export const BULK_SYSTEM_PROMPT =
  "This JSON was produced by the \"Pabbly → Code Extractor\" browser extension. It contains MANY Pabbly " +
  "Connect automations captured in one bulk pass. `workflows[]` is the list; each entry has `workflowName`, " +
  "`source`, `confidence`, and `steps[]`. Each step has `order`, `type` (trigger | action | router | filter), " +
  "`app`, `event`, `mappings` (configured fields as field/value pairs), and usually `text` (the raw on-screen " +
  "text of that step's config). Values like `{{1.email}}` reference an earlier step's output by its `order`. " +
  "When `mappings` is empty or incomplete (common for Filter and Router steps), read `text` — it contains the " +
  "literal conditions/operators shown in the UI (e.g. \"Equal to\", \"Exists\"). Your task is only to " +
  "understand these automations and explain them accurately. Do not write code unless explicitly asked later.";

export const buildBulkExport = (workflows) => ({
  systemPrompt: BULK_SYSTEM_PROMPT,
  extension: {
    name: "Pabbly → Code Extractor",
    version: "0.8.9",
    purpose: "Bulk-captures every Pabbly Connect automation in the account for an AI to understand."
  },
  count: workflows.length,
  workflows
});

export const buildExport = (workflow) => ({
  systemPrompt: SYSTEM_PROMPT,
  extension: {
    name: "Pabbly → Code Extractor",
    version: "0.8.9",
    purpose:
      "Captures Pabbly Connect automations from the live page and exports a clean schema for an AI to understand.",
    capturedFrom: workflow.source
  },
  schema: {
    workflowName: workflow.name,
    source: workflow.source,
    confidence: workflow.confidence,
    stepArrayPath: workflow.stepArrayPath,
    stepCount: workflow.stepCount,
    steps: workflow.steps
  },
  raw: workflow.rawBody
});

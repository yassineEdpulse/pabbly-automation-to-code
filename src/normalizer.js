import { analyzeSteps } from "./health.js";

export const SCHEMA_VERSION = 2;
export const EXTENSION_VERSION = "0.11.1";
export const EXTENSION_NAME = "Automation Code Extractor";

const idOf = (platform) => (platform && platform.id) || null;
const productOf = (platform) => (platform && platform.productName) || "an automation platform";

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

// The schema is identical across platforms, so the explanation of it is written once here and the
// platform-specific parts (what the product calls things, how it encodes cross-step references) are
// spliced in around it. Keeping this shared is what stops the two prompts drifting apart.
const SHARED_SCHEMA_PROMPT =
  "- `schema.workflowName`: the automation's name.\n" +
  "- `schema.confidence`: how confident the extension's heuristic detection is (high/medium/low). It is a guess about structure, not a guarantee.\n" +
  "- `schema.steps[]`: the ordered steps of the automation. Each step has: `order` (sequence), `type` " +
  "(trigger | action | router | filter), `app` (the connected app/service), `event` (the specific action/" +
  "trigger event chosen in that app), `mappings` (the configured input fields as field/value pairs).\n";

const SHARED_TAIL_PROMPT =
  "- A `filter` step has a `filter` array of condition groups. Groups are OR'd together; conditions inside a " +
  "group are AND'd. Each condition is `{ field, operator, value }`. The automation only continues past the " +
  "filter when the conditions pass.\n" +
  "- A `router` step has a `routes[]` array — each route is a conditional branch with its own `routeName`, " +
  "`stepCount`, and ordered `steps[]` that run only when that route's condition matches. Inside a route, the " +
  "first step is normally the filter defining that branch's condition. A route step marked `nestedRouter` is " +
  "itself a router; if it has its own `routes[]` those are the expanded sub-branches (routers nest " +
  "recursively). A `nestedRouter` with a `note` instead of `routes[]` hit the capture depth limit and was " +
  "not expanded further.\n" +
  "- `schema.health`: a self-check by the extension — `level` (complete | partial | poor | failed), " +
  "`score` (percentage of steps that captured data), and `warnings[]` naming specific gaps such as an " +
  "action with no fields or a router whose routes did not expand. It reports whether data was CAPTURED, " +
  "not whether it is CORRECT, so treat a clean score as 'nothing obviously missing', not as validation.\n" +
  "Your task here is only to understand this automation and explain it back accurately. Do not write code " +
  "unless you are explicitly asked to in a later message.";

export const SYSTEM_PROMPT =
  `This JSON was produced by the "${EXTENSION_NAME}" browser extension. It captured a single ` +
  "Pabbly Connect automation directly from the live workflow page (by recording the JSON the Pabbly API " +
  "returned and supplementing it with the on-screen layout). The goal of this file is to let you understand " +
  "exactly what the automation does. Read it as follows:\n" +
  SHARED_SCHEMA_PROMPT +
  "- DYNAMIC REFERENCES: inside `mappings` values, `filter` fields, and code, Pabbly embeds references to " +
  "earlier steps' outputs, rendered as `N. Label : sampleValue` — e.g. `1. Events : [...]`, " +
  "`7. User Email : a@b.com`, `2. Data 0 Subject Service Id : 948357`. The leading number `N` is the source " +
  "step's `order`, `Label` is the output field path (spaces denote nesting, e.g. `Data 0 Subject Service Id` " +
  "= data[0].subject.service.id), and the text AFTER the colon is only the SAMPLE value captured during a " +
  "test run — NOT a constant. When generating code, treat these as references to step N's output (e.g. " +
  "`const userEmail = step7.user.email`), never hard-code the sample. A mapping that contains such references " +
  "also carries a `references` array listing the detected `{ step, field }` pairs.\n" +
  "- Some steps (especially Filter and Router) also have a `text` field: the raw on-screen text of that " +
  "step's config. When `mappings` is empty or unclear, read `text` for the literal conditions/operators " +
  "(e.g. \"Equal to\", \"Exists\").\n" +
  "- `raw`: present only when the automation was reconstructed from a Pabbly API JSON response, in " +
  "which case it is the untouched payload and the source of truth — if the normalized `schema` looks " +
  "incomplete, trust `raw`. For a live-page capture (the usual case) `raw` holds only a short `note`: " +
  "`schema.steps` already contains the complete captured detail and is authoritative.\n" +
  SHARED_TAIL_PROMPT;

export const ZAPIER_SYSTEM_PROMPT =
  `This JSON was produced by the "${EXTENSION_NAME}" browser extension. It captured a single Zapier Zap ` +
  "by reading the JSON node graph that the Zap editor loads for itself, then normalizing it into the same " +
  "schema the extension uses for every platform. The goal of this file is to let you understand exactly " +
  "what the Zap does. Read it as follows:\n" +
  SHARED_SCHEMA_PROMPT +
  "- `app` is the Zapier app the step uses. Zapier's own built-ins appear under their product names: " +
  "\"Webhooks by Zapier\", \"Code by Zapier\", \"Filter by Zapier\", \"Paths by Zapier\", \"Formatter by " +
  "Zapier\", \"Delay by Zapier\". `event` is the chosen trigger/action (e.g. `new_email`, `catch_hook`).\n" +
  "- DYNAMIC REFERENCES: Zapier writes cross-step references into field values as " +
  "`{{123456789__field_path}}`, where the number is the SOURCE STEP'S INTERNAL NODE ID — not its position. " +
  "The extension has already resolved those ids to step positions: a mapping containing references carries " +
  "a `references` array of `{ step, field }` where `step` matches another step's `order`. When generating " +
  "code, treat the value as a reference to that step's output (e.g. `step3.email`), and never hard-code the " +
  "literal `{{...}}` token. Tokens the extension could not resolve are left verbatim in the value.\n" +
  "- Field names in `mappings` are Zapier's internal parameter keys (e.g. `to`, `subject`, `body__html`), " +
  "not the labels shown in the editor. A double underscore denotes nesting: `body__html` = `body.html`.\n" +
  "- A `Code by Zapier` step holds its JavaScript or Python in `mappings` under a `code` key. Reimplement " +
  "that logic rather than trying to run it as-is.\n" +
  "- `Paths by Zapier` becomes a `router` step. Each entry in `routes[]` is one Path, and that Path's own " +
  "condition is the first step inside it (a `filter`). Paths nest, and the nesting is expanded here.\n" +
  "- `raw` holds only a short `note` for a Zapier capture: `schema.steps` is the normalized view of the " +
  "node graph and is authoritative.\n" +
  SHARED_TAIL_PROMPT;

export const systemPromptFor = (platform) =>
  idOf(platform) === "zapier" ? ZAPIER_SYSTEM_PROMPT : SYSTEM_PROMPT;

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

const inventoryPrompt = (platform) => {
  const unit = (platform && platform.terms && platform.terms.unitPlural) || "workflows";
  return (
    `This JSON was produced by the "${EXTENSION_NAME}" browser extension. It is the full inventory of ` +
    `${productOf(platform)} ${unit} found in the account. Each entry has a \`name\` and an internal \`id\`` +
    (idOf(platform) === "zapier"
      ? ", plus `state` (whether the Zap is on or off)"
      : ", plus the `webhookUrl` that triggers it") +
    ". This is a catalog only — it does not contain the steps of each " +
    `${(platform && platform.terms && platform.terms.unit) || "workflow"}. Use this list to understand the ` +
    "scope of what needs to be rebuilt."
  );
};

export const INVENTORY_SYSTEM_PROMPT = inventoryPrompt(null);

export const buildInventoryExport = (inventory, source, platform) => ({
  systemPrompt: inventoryPrompt(platform),
  schemaVersion: SCHEMA_VERSION,
  platform: idOf(platform),
  extension: {
    name: EXTENSION_NAME,
    version: EXTENSION_VERSION,
    purpose: `Lists every ${productOf(platform)} automation in the account.`,
    capturedFrom: source || null
  },
  count: inventory.length,
  inventory
});

// Zapier's built-ins are not named "router"/"filter", so name matching alone is not enough. An
// adapter that already knows a step's role states it outright and that always wins.
const ROUTER_APP = /router|paths?\s+by\s+zapier/i;
const FILTER_APP = /filter|only\s+continue/i;

export const classifyType = (order, app) => {
  if (order === 1) return "trigger";
  if (ROUTER_APP.test(app || "")) return "router";
  if (FILTER_APP.test(app || "")) return "filter";
  return "action";
};

const routeStepType = (app) =>
  ROUTER_APP.test(app || "") ? "router" : FILTER_APP.test(app || "") ? "filter" : "action";

const routeStep = (cs, i) => {
  const expandedNested = cs.routes && cs.routes.length;
  const capped = cs.isRouter || cs.depthCapped;
  return {
    order: cs.order || i + 1,
    type: cs.type || routeStepType(cs.app),
    app: cs.app,
    ...(cs.title && cs.title !== cs.app ? { title: cs.title } : {}),
    event: cs.event || null,
    ...(cs.mappings && cs.mappings.length ? { mappings: cs.mappings } : {}),
    ...(cs.filter ? { filter: cs.filter } : {}),
    ...(expandedNested ? { nestedRouter: true, routes: cs.routes.map(routeFromParsed) } : {}),
    ...(capped && !expandedNested
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
  type: s.type || classifyType(s.order, s.app),
  app: s.app,
  // The step's own name in the editor ("Run Javascript", "New Email"). Worth keeping: it is often
  // the only human-readable label when the app identifies its action by an opaque id.
  ...(s.title && s.title !== s.app ? { title: s.title } : {}),
  event: s.event || null,
  rawKeys: [],
  mappings: s.mappings || [],
  ...(s.filter ? { filter: s.filter } : {}),
  ...(s.text ? { text: s.text } : {}),
  ...(s.routes ? { routes: s.routes.map(routeFromParsed) } : {})
});

export const workflowFromParsed = (name, url, steps, error) => ({
  workflowName: name || "Workflow",
  source: url || null,
  confidence: (steps || []).some((s) => s.mappings && s.mappings.length) ? "high" : "low",
  health: analyzeSteps(steps, error),
  stepCount: (steps || []).length,
  steps: (steps || []).map(stepFromParsed),
  ...(error ? { error } : {})
});

const captureNote = (platform, anyMappings) => {
  if (idOf(platform) === "zapier") {
    return anyMappings
      ? "Normalized from the Zap's own JSON node graph. schema.steps is the authoritative view; there is no separate raw payload in this export."
      : "No configured fields were found on this Zap's nodes — open the Zap in the editor and capture again.";
  }
  return anyMappings
    ? "Parsed from the live page DOM after expanding steps. schema.steps holds the full captured detail; there is no separate raw API payload for a live-page capture."
    : "Step outline only — click each step open (or use Auto-capture) to load field mappings.";
};

export const domWorkflow = (dom, platform) => {
  if (!dom || !dom.steps || !dom.steps.length) return null;
  const anyMappings = dom.steps.some((s) => (s.mappings && s.mappings.length) || s.filter || s.routes);
  return {
    id: `dom::${dom.currentWorkflowName || dom.url}`,
    name: dom.currentWorkflowName || "Current workflow",
    source: dom.url,
    host: hostOf(dom.url),
    platform: idOf(platform),
    stepArrayPath:
      idOf(platform) === "zapier" ? "(normalized from the Zap node graph)" : "(parsed from live page DOM)",
    confidence: anyMappings ? "high" : "low",
    health: analyzeSteps(dom.steps),
    stepCount: dom.steps.length,
    steps: dom.steps.map(stepFromParsed),
    // Deliberately does NOT repeat dom.steps: schema.steps already carries the full captured
    // detail, and duplicating it roughly doubled every export for no added information.
    rawBody: { note: captureNote(platform, anyMappings) },
    capturedAt: null
  };
};

const BULK_SHARED =
  "`workflows[]` is the list; each entry has `workflowName`, `source`, `confidence`, `health`, and `steps[]`. " +
  "Each step has `order`, `type` (trigger | action | router | filter), `app`, `event`, and `mappings` " +
  "(configured fields as field/value pairs). A `filter` step carries condition groups (groups OR'd, " +
  "conditions within a group AND'd); a `router` step carries `routes[]`, each a branch with its own " +
  "`steps[]`. Your task is only to understand these automations and explain them accurately. Do not write " +
  "code unless explicitly asked later.";

export const BULK_SYSTEM_PROMPT =
  `This JSON was produced by the "${EXTENSION_NAME}" browser extension. It contains MANY Pabbly Connect ` +
  "automations captured in one bulk pass. " +
  BULK_SHARED +
  " Steps usually also carry `text` (the raw on-screen text of that step's config) — read it when " +
  "`mappings` is empty or incomplete, which is common for Filter and Router steps. DYNAMIC REFERENCES: " +
  "mapping values, filter fields, and code embed references to earlier steps rendered as " +
  "`N. Label : sampleValue` (e.g. `7. User Email : a@b.com`) — `N` is the source step's `order`, `Label` is " +
  "the output field path, and the text after the colon is only the captured SAMPLE, not a constant; treat " +
  "these as references to step N's output when coding. Mappings with such references also carry a " +
  "`references` array of `{ step, field }`.";

export const ZAPIER_BULK_SYSTEM_PROMPT =
  `This JSON was produced by the "${EXTENSION_NAME}" browser extension. It contains MANY Zapier Zaps read ` +
  "from the Zap editor's own JSON node graph in one bulk pass. " +
  BULK_SHARED +
  " Zapier's built-ins appear under their product names (\"Webhooks by Zapier\", \"Code by Zapier\", " +
  "\"Filter by Zapier\", \"Paths by Zapier\"), and a Paths step is normalized to a `router` whose `routes[]` " +
  "are the individual Paths. Field names in `mappings` are Zapier's internal parameter keys, where a double " +
  "underscore denotes nesting (`body__html` = `body.html`). DYNAMIC REFERENCES: Zapier encodes cross-step " +
  "references as `{{123456789__field}}` where the number is the source step's internal node id; the " +
  "extension has resolved those into a `references` array of `{ step, field }` whose `step` matches another " +
  "step's `order`. Treat them as references to that step's output, never as literal values.";

const bulkPromptFor = (platform) =>
  idOf(platform) === "zapier" ? ZAPIER_BULK_SYSTEM_PROMPT : BULK_SYSTEM_PROMPT;

const healthSummary = (workflows) => {
  const tally = { complete: 0, partial: 0, poor: 0, failed: 0 };
  workflows.forEach((w) => {
    const level = (w.health && w.health.level) || "failed";
    if (tally[level] != null) tally[level] += 1;
  });
  return {
    ...tally,
    needsAttention: workflows
      .filter((w) => w.health && w.health.level !== "complete")
      .map((w) => ({
        workflowName: w.workflowName,
        level: w.health.level,
        score: w.health.score,
        warnings: w.health.warnings
      }))
  };
};

export const buildBulkExport = (workflows, platform) => ({
  systemPrompt: bulkPromptFor(platform),
  schemaVersion: SCHEMA_VERSION,
  platform: idOf(platform),
  extension: {
    name: EXTENSION_NAME,
    version: EXTENSION_VERSION,
    purpose: `Bulk-captures every ${productOf(platform)} automation in the account for an AI to understand.`
  },
  count: workflows.length,
  health: healthSummary(workflows),
  workflows
});

const appReportPrompt = (platform) =>
  `This JSON was produced by the "${EXTENSION_NAME}" browser extension. It aggregates every captured ` +
  `${productOf(platform)} automation into a coverage report: which apps/services are used, how often, and ` +
  "which triggers start the automations. Use it to decide the order of a migration — the apps at the top of " +
  "`apps[]` cover the most automations, so building those integrations first unblocks the largest share of " +
  "the account. `triggers[]` shows how automations are kicked off. `stepTypes` counts trigger/action/router/" +
  "filter steps across everything. This is a planning artifact only; it contains no per-automation field detail.";

export const APP_REPORT_SYSTEM_PROMPT = appReportPrompt(null);

export const buildAppReport = (workflows, platform) => {
  const apps = new Map();
  const triggers = new Map();
  const stepTypes = { trigger: 0, action: 0, router: 0, filter: 0 };
  const bump = (map, key) => {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + 1);
  };

  const visit = (steps, seen) => {
    (steps || []).forEach((s) => {
      if (s.app) seen.add(s.app);
      if (s.type && stepTypes[s.type] != null) stepTypes[s.type] += 1;
      (s.routes || []).forEach((r) => visit(r.steps, seen));
    });
  };

  workflows.forEach((w) => {
    const seen = new Set();
    visit(w.steps, seen);
    seen.forEach((a) => bump(apps, a));
    const trig = (w.steps || [])[0];
    if (trig) bump(triggers, trig.event ? `${trig.app || "?"} : ${trig.event}` : trig.app || "?");
  });

  const rank = (map) =>
    [...map.entries()]
      .map(([name, workflowCount]) => ({ name, workflowCount }))
      .sort((a, b) => b.workflowCount - a.workflowCount);

  return {
    systemPrompt: appReportPrompt(platform),
    schemaVersion: SCHEMA_VERSION,
    platform: idOf(platform),
    extension: { name: EXTENSION_NAME, version: EXTENSION_VERSION },
    workflowCount: workflows.length,
    stepTypes,
    apps: rank(apps),
    triggers: rank(triggers)
  };
};

export const buildExport = (workflow, platform) => ({
  systemPrompt: systemPromptFor(platform),
  schemaVersion: SCHEMA_VERSION,
  platform: idOf(platform),
  extension: {
    name: EXTENSION_NAME,
    version: EXTENSION_VERSION,
    purpose: `Captures ${productOf(platform)} automations and exports a clean schema for an AI to understand.`,
    capturedFrom: workflow.source
  },
  schema: {
    workflowName: workflow.name,
    source: workflow.source,
    confidence: workflow.confidence,
    health: workflow.health || null,
    stepArrayPath: workflow.stepArrayPath,
    stepCount: workflow.stepCount,
    steps: workflow.steps
  },
  raw: workflow.rawBody
});

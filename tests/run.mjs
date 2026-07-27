import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { analyzeSteps } from "../src/health.js";
import {
  buildAppReport,
  buildExport,
  workflowFromParsed,
  domWorkflow,
  SCHEMA_VERSION,
  ZAPIER_SYSTEM_PROMPT
} from "../src/normalizer.js";
import { PLATFORMS } from "../src/platforms/registry.js";

const ZAPIER = PLATFORMS.zapier;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let passed = 0;
const failures = [];

const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push({ name, message: (e && e.message) || String(e) });
    console.log(`  FAIL ${name}\n       ${(e && e.message) || e}`);
  }
};

const eq = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const truthy = (v, what) => {
  if (!v) throw new Error(`${what}: expected a truthy value, got ${JSON.stringify(v)}`);
};

// --- Load the REAL parsers against a stubbed browser environment. ---
// Chrome loads the platform adapter and the shell as separate files into one shared isolated-world
// scope, in manifest order. Evaluating them the same way here means the tests exercise exactly the
// wiring that ships, including the __PCE_ADAPTER handoff.
const loadContentParsers = () => {
  const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = { href: "https://connect.pabbly.com/workflow/mapping/test_pc" };
  globalThis.chrome = {
    runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {} }
  };
  globalThis.__PCE_EXPORT_FOR_TESTS__ = true;

  for (const rel of [["src", "platforms", "pabbly-content.js"], ["src", "content.js"]]) {
    new Function(readFileSync(join(ROOT, ...rel), "utf8"))();
  }

  if (!globalThis.__PCE_TEST__) throw new Error("the Pabbly adapter did not expose its test hook");
  if (!globalThis.__PCE_ADAPTER) throw new Error("the Pabbly adapter did not register itself");
  return { api: globalThis.__PCE_TEST__, adapter: globalThis.__PCE_ADAPTER, document };
};

// The Zapier adapter parses JSON rather than the DOM, but it still needs the same page globals to
// evaluate. It is loaded after the Pabbly assertions have captured their own reference.
const loadZapierParsers = () => {
  globalThis.location = { href: "https://zapier.com/editor/55501", origin: "https://zapier.com" };
  new Function(readFileSync(join(ROOT, "src", "platforms", "zapier-content.js"), "utf8"))();
  if (!globalThis.__PCE_TEST_ZAPIER__) throw new Error("the Zapier adapter did not expose its test hook");
  return globalThis.__PCE_TEST_ZAPIER__;
};

const { api } = loadContentParsers();

const fixture = (file) => {
  const html = readFileSync(join(HERE, "fixtures", file), "utf8");
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return document.querySelector(".webhook_api_mapping_div");
};

const findMapping = (mappings, field) => mappings.find((m) => m.field === field);

console.log(`\nPabbly Code Extractor — golden fixtures (content v${api.CONTENT_VERSION})\n`);

console.log("SMTP / app-action parameters");
{
  const step = api.parseStepEl(fixture("smtp-send-email.html"));

  check("captures the app and event", () => {
    eq(step.event, "Send Email", "event");
    eq(step.order, 2, "order");
  });

  check("extracts structured parameter fields", () => {
    eq(findMapping(step.mappings, "From Name").value, "EdPulse", "From Name");
    eq(findMapping(step.mappings, "From Email").value, "application@edpulse.com", "From Email");
    eq(findMapping(step.mappings, "Subject").value, "Welcome to EdPulse", "Subject");
  });

  check("detects dynamic references in parameter values", () => {
    const to = findMapping(step.mappings, "To Email");
    truthy(to.references, "To Email references");
    eq(to.references[0].step, 1, "reference step");
    eq(to.references[0].field, "From 0 Address", "reference field");
  });

  check("drops the test-response preview noise", () => {
    eq(findMapping(step.mappings, "Response Received"), undefined, "Response Received");
  });
}

console.log("\nWebhook trigger");
{
  const step = api.parseStepEl(fixture("webhook-trigger.html"));

  check("prefers the URL input over a sibling response dropdown", () => {
    eq(
      findMapping(step.mappings, "Webhook URL").value,
      "https://connect.pabbly.com/workflow/sendwebhookdata/IjU3NjUwNTZk",
      "Webhook URL"
    );
  });

  check("still reads plain dropdown values", () => {
    eq(findMapping(step.mappings, "Select Response").value, "Response A", "Select Response");
  });
}

console.log("\nFilter conditions");
{
  const step = api.parseStepEl(fixture("filter-conditions.html"));

  check("parses OR-of-AND condition groups", () => {
    truthy(step.filter, "filter");
    eq(step.filter.length, 2, "group count");
    eq(step.filter[0].conditions.length, 2, "first group condition count");
    eq(step.filter[1].conditions.length, 1, "second group condition count");
  });

  check("parses field, operator and value", () => {
    const c = step.filter[0].conditions[0];
    eq(c.field, "2. Data 0 Action", "field");
    eq(c.operator, "Equal to", "operator");
    eq(c.value, "CANCELLED_A_BOOKING", "value");
  });

  check("drops the Response Received test-output field", () => {
    eq(findMapping(step.mappings, "Response Received"), undefined, "Response Received");
  });

  check("drops Pabbly's internal path-encoding tokens", () => {
    const leaked = step.mappings.filter((m) => /<=-\+/.test(String(m.value)));
    eq(leaked.length, 0, "internal token mappings");
  });
}

console.log("\nRouter routes");
{
  const step = api.parseStepEl(fixture("router-routes.html"));

  check("parses each route with name, id and step count", () => {
    truthy(step.routes, "routes");
    eq(step.routes.length, 3, "route count");
    eq(step.routes[0].routeName, "DEMO", "route 1 name");
    eq(step.routes[1].routeName, "Quebec", "route 2 name");
    eq(step.routes[2].stepCount, 9, "route 3 step count");
    eq(step.routes[0].routeId, "r-demo-1", "route 1 id");
  });
}

console.log("\nValue cleanup and references");
{
  check("strips dynamic_value wrappers and map markers", () => {
    const raw = '<span class="dynamic_value" data-attr="1.name">{{{_map_val_{{{1. Name : John}}}_map_val_}}}</span>';
    eq(api.cleanValue(raw), "1. Name : John", "cleanValue");
  });

  check("converts line-break markup to newlines", () => {
    eq(api.cleanValue("a<br>b"), "a\nb", "cleanValue br");
  });

  check("extracts multiple distinct references", () => {
    const refs = api.extractRefs("7. User Email : a@b.com and 2. Data 0 Subject Service Id : 948357");
    eq(refs.length, 2, "reference count");
    eq(refs[0].step, 7, "first ref step");
    eq(refs[1].step, 2, "second ref step");
  });

  check("returns null when there are no references", () => {
    eq(api.extractRefs("just a plain value"), null, "extractRefs");
  });
}

console.log("\nHealth scoring");
{
  check("flags an action step with no captured fields", () => {
    const h = analyzeSteps([{ order: 1, app: "Webhook", mappings: [{ field: "a", value: "b" }] }, { order: 2, app: "SMTP", mappings: [] }]);
    eq(h.counts.total, 2, "total");
    eq(h.counts.withData, 1, "withData");
    eq(h.score, 50, "score");
    truthy(h.warnings.some((w) => w.code === "action-no-fields"), "action-no-fields warning");
  });

  check("flags a router with no routes", () => {
    const h = analyzeSteps([{ order: 1, app: "Router (Pabbly)", mappings: [], routes: [] }]);
    truthy(h.warnings.some((w) => w.code === "router-no-routes"), "router-no-routes warning");
  });

  check("flags an empty route branch", () => {
    const h = analyzeSteps([
      { order: 1, app: "Router (Pabbly)", mappings: [], routes: [{ routeName: "Quebec", steps: [] }] }
    ]);
    truthy(h.warnings.some((w) => w.code === "route-empty"), "route-empty warning");
  });

  check("counts nested route children toward the total", () => {
    const h = analyzeSteps([
      {
        order: 1,
        app: "Router (Pabbly)",
        mappings: [],
        routes: [{ routeName: "Q", steps: [{ order: 1, app: "SMTP", mappings: [{ field: "To", value: "x" }] }] }]
      }
    ]);
    eq(h.counts.total, 2, "total incl. route child");
    eq(h.counts.routes, 1, "route count");
  });

  check("reports a failed capture", () => {
    const h = analyzeSteps([], "timeout");
    eq(h.level, "failed", "level");
    eq(h.score, 0, "score");
  });

  check("reports a clean workflow as complete", () => {
    const h = analyzeSteps([{ order: 1, app: "Webhook", mappings: [{ field: "a", value: "b" }] }]);
    eq(h.level, "complete", "level");
    eq(h.score, 100, "score");
  });
}

console.log("\nExport shape");
{
  check("workflowFromParsed carries health and error", () => {
    const wf = workflowFromParsed("Test", "https://x", [], "boom");
    eq(wf.error, "boom", "error");
    eq(wf.health.level, "failed", "health level");
  });

  check("domWorkflow does not duplicate steps into raw", () => {
    const dom = {
      url: "https://connect.pabbly.com/workflow/mapping/x_pc",
      currentWorkflowName: "W",
      steps: [{ order: 1, app: "SMTP", mappings: [{ field: "To", value: "a@b.com" }] }]
    };
    const wf = domWorkflow(dom);
    truthy(wf.rawBody.note, "raw note");
    eq(wf.rawBody.steps, undefined, "raw.steps");
    eq(wf.steps.length, 1, "schema steps still present");
  });

  check("app report ranks apps by workflow count", () => {
    const wfs = [
      workflowFromParsed("A", null, [{ order: 1, app: "Webhook" }, { order: 2, app: "SMTP" }]),
      workflowFromParsed("B", null, [{ order: 1, app: "Webhook" }])
    ];
    const report = buildAppReport(wfs);
    eq(report.schemaVersion, SCHEMA_VERSION, "schemaVersion");
    eq(report.workflowCount, 2, "workflowCount");
    eq(report.apps[0].name, "Webhook", "top app");
    eq(report.apps[0].workflowCount, 2, "top app count");
  });
}

console.log("\nZapier — node graph → canonical steps");
{
  const zap = loadZapierParsers();
  const payload = JSON.parse(readFileSync(join(HERE, "fixtures", "zapier-zap.json"), "utf8"));

  check("finds the node array inside the API envelope", () => {
    const hit = zap.findNodeArray(payload);
    truthy(hit, "node array");
    eq(hit.arr.length, 7, "node count");
    eq(hit.path, "objects", "path");
  });

  const steps = zap.nodesToSteps(payload.objects);

  check("walks parent_id into an ordered linear chain", () => {
    eq(steps.length, 3, "top-level step count");
    eq(steps[0].order, 1, "first order");
    eq(steps[0].type, "trigger", "first type");
    eq(steps[1].type, "filter", "second type");
    eq(steps[2].type, "router", "third type");
  });

  check("names Zapier built-ins by their product names", () => {
    eq(steps[0].app, "Webhooks by Zapier", "trigger app");
    eq(steps[1].app, "Filter by Zapier", "filter app");
    eq(steps[2].app, "Paths by Zapier", "paths app");
    eq(zap.humanizeApi("GmailAPI@2.0.0"), "Gmail", "third-party app");
    eq(zap.humanizeApi("EmailParserCLIAPI@1.1.2"), "Email Parser by Zapier", "CLI-platform built-in");
  });

  // A node usually repeats its raw identifier in `app`; taking it at face value exported
  // "EmailParserCLIAPI@1.1.2" as the app name instead of "Email Parser by Zapier".
  check("does not let a raw API identifier in `app` bypass humanizing", () => {
    eq(steps[0].app, "Webhooks by Zapier", "app field must not win over humanizing");
    eq(zap.appOf({ app: "CodeCLIAPI@1.0.1" }), "Code by Zapier", "bare app identifier");
    eq(
      zap.appOf({ type: "read", app: "EmailParserCLIAPI@1.1.2", selected_api: "EmailParserCLIAPI@1.1.2" }),
      "Email Parser by Zapier",
      "real capture: app and selected_api both raw"
    );
    eq(
      zap.eventOf({ action: "01929fad-d3dd-62c2-52ed-7868d5fcc691", title: "Run Javascript" }),
      "Run Javascript",
      "real capture: UUID action falls back to title"
    );
    eq(zap.appOf({ app: "Zoho API", selected_api: "ZohoAPI@1.0.0" }), "Zoho API", "genuine title kept");
  });

  check("prefers the step title when the action is an opaque id", () => {
    const code = steps[2].routes[1].steps[1];
    eq(code.app, "Code by Zapier", "app");
    eq(code.event, "Run Javascript", "event must not be the action UUID");
    eq(code.title, "Run Javascript", "title");
    eq(steps[0].event, "catch_hook", "a real action key is kept as-is");
  });

  // `text` used to re-encode every param as escaped JSON, doubling the export and burning context
  // in the model call it exists for. Zapier's mappings already are the params.
  check("keeps `text` a short summary when mappings captured the config", () => {
    const code = steps[2].routes[1].steps[1];
    truthy(code.text.length < 200, `text length (${code.text.length})`);
    eq(/return \{ ok: true \}/.test(code.text), false, "code body must not be duplicated into text");
    truthy(/Run Javascript/.test(code.text), "summary still names the step");
  });

  check("falls back to a raw param dump when nothing reached mappings", () => {
    const [only] = zap.nodesToSteps([
      { id: 9, type: "write", selected_api: "MysteryAPI@1.0.0", params: { "_all": "hidden" } }
    ]);
    eq(only.mappings.length, 0, "no mappings");
    truthy(/hidden/.test(only.text), "params preserved in text as the sole record");
  });

  check("turns Paths into routes with their own step chains", () => {
    const routes = steps[2].routes;
    truthy(routes, "routes");
    eq(routes.length, 2, "route count");
    eq(routes[0].routeName, "Quebec", "route 1 name");
    eq(routes[1].routeName, "Ontario", "route 2 name");
    eq(routes[0].steps.length, 2, "route 1 step count");
    eq(routes[0].steps[1].app, "Gmail", "route 1 action app");
    eq(routes[1].steps[1].app, "Code by Zapier", "route 2 action app");
  });

  check("numbers route children continuously with the parent chain", () => {
    eq(steps[2].routes[0].steps[0].order, 4, "first route child order");
    eq(steps[2].routes[1].steps[1].order, 7, "last route child order");
  });

  check("parses OR-of-AND filter groups", () => {
    const f = steps[1].filter;
    eq(f.length, 2, "group count");
    eq(f[0].joiner, "AND", "first joiner");
    eq(f[1].joiner, "OR", "second joiner");
    eq(f[0].conditions[0].field, "1001__status", "field");
    eq(f[0].conditions[0].operator, "exact", "operator");
    eq(f[0].conditions[0].value, "paid", "value");
  });

  check("keeps the raw conditions blob out of mappings", () => {
    eq(findMapping(steps[1].mappings, "filters"), undefined, "filters mapping");
  });

  check("resolves {{nodeId__field}} tokens to step order", () => {
    const to = findMapping(steps[2].routes[0].steps[1].mappings, "to");
    truthy(to.references, "references");
    eq(to.references[0].step, 1, "reference step");
    eq(to.references[0].field, "email", "reference field");
    eq(to.__refs, undefined, "internal ref scratch removed");
  });

  check("drops Zapier's internal underscore-prefixed params", () => {
    const mappings = steps[2].routes[0].steps[1].mappings;
    eq(findMapping(mappings, "_zap_internal_noise"), undefined, "internal param");
    eq(findMapping(mappings, "body__html").value, "<p>Merci</p>", "nested param kept");
  });

  check("tells a Zap list apart from a node array", () => {
    const list = JSON.parse(readFileSync(join(HERE, "fixtures", "zapier-zap-list.json"), "utf8"));
    const hit = zap.findZapList(list);
    truthy(hit, "zap list");
    eq(hit.arr.length, 3, "zap count");
    eq(zap.findZapList(payload), null, "node array must not be read as a Zap list");
    const entry = zap.inventoryEntry(hit.arr[1]);
    eq(entry.id, "55502", "inventory id");
    eq(entry.name, "Invoice paid → Slack", "inventory name");
    eq(entry.state, "off", "inventory state");
  });

  check("learns a URL template by substituting the Zap id", () => {
    eq(
      zap.templateFrom("/api/v4/nodes/?root_id=55501&limit=250", "55501"),
      "https://zapier.com/api/v4/nodes/?root_id={id}&limit=250",
      "template"
    );
    eq(zap.templateFrom("/api/v4/nodes/?root_id=999", "55501"), null, "unrelated URL");
    eq(zap.zapIdFrom("https://zapier.com/editor/55501/draft/1001/setup"), "55501", "zap id from URL");
  });

  check("scores a fully captured Zap as complete", () => {
    const h = analyzeSteps(steps);
    eq(h.counts.total, 7, "total steps incl. route children");
    eq(h.counts.routes, 2, "routes");
    eq(h.level, "complete", "level");
  });

  check("exports Zapier steps under the Zapier system prompt", () => {
    const wf = domWorkflow(
      { url: "https://zapier.com/editor/55501", currentWorkflowName: "Test Zap", steps },
      ZAPIER
    );
    const out = buildExport(wf, ZAPIER);
    eq(out.platform, "zapier", "platform");
    eq(out.systemPrompt, ZAPIER_SYSTEM_PROMPT, "system prompt");
    eq(out.schema.steps[2].type, "router", "router type survives normalization");
    eq(out.schema.steps[2].routes[0].steps[0].type, "filter", "path type survives normalization");
    truthy(/node graph/i.test(out.raw.note), "Zapier-specific raw note");
  });
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { analyzeSteps } from "../src/health.js";
import { buildAppReport, workflowFromParsed, domWorkflow, SCHEMA_VERSION } from "../src/normalizer.js";

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

// --- Load the REAL content.js parsers against a stubbed browser environment. ---
const loadContentParsers = () => {
  const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = { href: "https://connect.pabbly.com/workflow/mapping/test_pc" };
  globalThis.chrome = {
    runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {} }
  };
  globalThis.__PCE_EXPORT_FOR_TESTS__ = true;

  const src = readFileSync(join(ROOT, "src", "content.js"), "utf8");
  new Function(src)();

  if (!globalThis.__PCE_TEST__) throw new Error("content.js did not expose its test hook");
  return { api: globalThis.__PCE_TEST__, document };
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

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);

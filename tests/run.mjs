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
  EXTENSION_VERSION,
  ZAPIER_SYSTEM_PROMPT
} from "../src/normalizer.js";
import { PLATFORMS } from "../src/platforms/registry.js";
import {
  OUTCOMES,
  recordVisit,
  isSettled,
  settledIds,
  ledgerStats,
  clearLedger,
  partitionByLedger
} from "../src/rewrite-ledger.js";

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

const checkAsync = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push({ name, message: (e && e.message) || String(e) });
    console.log(`  FAIL ${name}\n       ${(e && e.message) || e}`);
  }
};

const readLedgerForTest = async () => (await chrome.storage.local.get("rewrite_ledger")).rewrite_ledger || {};

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

  for (const rel of [
    ["src", "rewrite.js"],
    ["src", "platforms", "pabbly-fields.js"],
    ["src", "platforms", "pabbly-history.js"],
    ["src", "platforms", "pabbly-api.js"],
    ["src", "platforms", "pabbly-content.js"],
    ["src", "content.js"]
  ]) {
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

// linkedom returns a textarea's RAW source from `.value` ("a&lt;br&gt;b"), where a real browser
// returns the parsed text ("a<br>b"). The rewrite rule's entire safety property is that it skips tag
// interiors, so without correcting this the guard would never be exercised by a fixture. Decoding
// into textContent makes `.value` report what Chrome would. One pass only: `&amp;lt;` must land on
// `&lt;` (a code body's own `<` really is stored escaped), not on `<`.
const ENTITIES = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&amp;": "&" };
const asBrowserValues = (document) => {
  document.querySelectorAll("textarea").forEach((ta) => {
    ta.textContent = (ta.textContent || "").replace(/&(?:lt|gt|quot|#39|amp);/g, (m) => ENTITIES[m]);
  });
  return document;
};

const stepFixture = (file) => {
  const html = readFileSync(join(HERE, "fixtures", file), "utf8");
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return asBrowserValues(document).querySelector(".webhook_api_mapping_div");
};

const findMapping = (mappings, field) => mappings.find((m) => m.field === field);
const findField = (fields, name) => fields.find((f) => f.field === name);

const countDeep = (steps) =>
  (steps || []).reduce(
    (n, s) => n + 1 + (s.routes || []).reduce((m, r) => m + countDeep(r.steps), 0),
    0
  );

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

  // Regression: a chip is stripped regardless of attribute order. The old pattern required
  // class="dynamic_value" BEFORE data-attr; the other order left Pabbly's internal path token in the
  // value, and pushMapping then discarded the whole field. Code bodies and Asana request bodies
  // disappeared from exports while every static field beside them came through, so the loss was silent.
  check("strips a mapping chip whichever order its attributes are in", () => {
    const chip = (attrs) => `const ID = "<span ${attrs}>1. Events 0 Subject Id : 2438639<!--endofdynamic_value--></span>";`;
    const path = "0<=-+*/@/*+-=>events<=-+($@$)+-=>0<=-+($@$)+-=>subject<=-+($@$)+-=>id";
    const expected = 'const ID = "1. Events 0 Subject Id : 2438639";';

    eq(
      api.cleanValue(chip(`class="dynamic_value" contenteditable="false" data-attr="${path}"`)),
      expected,
      "class before data-attr"
    );
    eq(
      api.cleanValue(chip(`data-attr="${path}" class="dynamic_value" contenteditable="false"`)),
      expected,
      "data-attr before class"
    );
    eq(api.cleanValue(chip(`data-attr="${path}" class="dynamic_value"`)), expected, "no contenteditable");
  });

  check("keeps a multi-line code body containing a chip intact", () => {
    const body =
      'const URL = "https://app.tutorax.com/clients/";<br>const ID = "<span data-attr="0<=-+*/@/*+-=>id" class="dynamic_value">1. Id : 42<!--endofdynamic_value--></span>";<br>return await go();';
    const out = api.cleanValue(body);
    truthy(out.includes("https://app.tutorax.com/clients/"), "URL survived");
    truthy(out.includes("1. Id : 42"), "chip's readable reference survived");
    truthy(out.includes("return await go();"), "last line survived");
    eq(/<=-\+/.test(out), false, "no internal token left to trigger the drop");
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

console.log("\nRewrite rule — tag-safe host replacement");
{
  const rw = globalThis.__PCE_TEST_REWRITE__;
  const RULE = rw.RULES.tutorcruncherHost;

  check("rewrites the URL text and leaves the mapping chip byte-identical", () => {
    const chip =
      '<span class="dynamic_value" contenteditable="false" data-attr="4922054<=-+*/@/*+-=>result">5. Result : filip_par@tutorax.com<!--endofdynamic_value--></span>';
    const res = rw.applyToValue(`https://secure.tutorcruncher.com/api/clients/?user__email=${chip}`, RULE);
    eq(res.hits.length, 1, "hit count");
    eq(res.value, `https://app.tutorcruncher.com/api/clients/?user__email=${chip}`, "rewritten value");
    truthy(res.value.includes(chip), "chip survived untouched");
  });

  // The destructive case: a chip's data-attr is a field path Pabbly parses. If the search string ever
  // appears inside a tag it must be reported and NOT written, or the mapping silently unbinds.
  check("refuses to write inside a tag and reports it instead", () => {
    const v = '<span class="dynamic_value" data-attr="secure.tutorcruncher.com">x</span>';
    const res = rw.applyToValue(v, RULE);
    eq(res.hits.length, 0, "no writable hits");
    eq(res.blocked.length, 1, "blocked hit reported");
    eq(res.value, v, "value untouched");
  });

  check("rewrites every occurrence in a code body, across <br> line breaks", () => {
    const code =
      "const A = 'https://secure.tutorcruncher.com/api/contractors/';<br>const B = \"https://secure.tutorcruncher.com/api/clients/\";";
    const res = rw.applyToValue(code, RULE);
    eq(res.hits.length, 2, "hit count");
    eq(/secure\.tutorcruncher\.com/.test(res.value), false, "no old host left");
    eq((res.value.match(/app\.tutorcruncher\.com/g) || []).length, 2, "both rewritten");
    truthy(res.value.includes("<br>"), "line break preserved");
  });

  check("respects hostname label boundaries", () => {
    eq(rw.scanText("https://notsecure.tutorcruncher.com/x", RULE).length, 0, "prefixed label");
    eq(rw.scanText("https://eu.secure.tutorcruncher.com/x", RULE).length, 0, "parent label");
    eq(rw.scanText("https://secure.tutorcruncher.community/x", RULE).length, 0, "suffixed TLD");
    eq(rw.scanText("https://secure.tutorcruncher.com/x", RULE).length, 1, "exact host");
    eq(rw.scanText("SECURE.TutorCruncher.COM/x", RULE).length, 1, "case-insensitive");
  });

  // The exact stored value from a live "API (Pabbly) : Execute API Request" step, copied out of the
  // hidden textarea. This is the string the apply pass has to transform correctly.
  const REAL =
    'https://secure.tutorcruncher.com/api/clients/?user__email=<span class="dynamic_value" contenteditable="false" data-attr="0<=-+*/@/*+-=>email">1. Email : mamourtestingsp@tutorax.com<!--endofdynamic_value--></span>';

  check("rewrites the real endpoint value and preserves the chip exactly", () => {
    const res = rw.applyToValue(REAL, RULE);
    eq(res.hits.length, 1, "hit count");
    eq(
      res.value,
      'https://app.tutorcruncher.com/api/clients/?user__email=<span class="dynamic_value" contenteditable="false" data-attr="0<=-+*/@/*+-=>email">1. Email : mamourtestingsp@tutorax.com<!--endofdynamic_value--></span>',
      "rewritten value"
    );
    truthy(res.value.includes('data-attr="0<=-+*/@/*+-=>email"'), "data-attr byte-identical");
    truthy(res.value.includes("<!--endofdynamic_value-->"), "end marker intact");
  });

  // A data-attr containing a literal `>` is what breaks naive tag matching: everything after that inner
  // `>` looks like text, so a match inside the attribute would be rewritten and the mapping unbound.
  check("treats an attribute containing '>' as part of the tag", () => {
    const v = '<span class="dynamic_value" data-attr="0<=-+*/@/*+-=>secure.tutorcruncher.com">x</span>';
    const res = rw.applyToValue(v, RULE);
    eq(res.hits.length, 0, "no writable hits inside the attribute");
    eq(res.blocked.length, 1, "reported as blocked");
    eq(res.value, v, "value untouched");
  });

  check("leaves a value with no match completely alone", () => {
    const v = "https://app.tutorcruncher.com/api/clients/?user__email=x";
    const res = rw.applyToValue(v, RULE);
    eq(res.hits.length, 0, "hits");
    eq(res.value, v, "value");
  });
}

console.log("\nField enumeration — API endpoint step");
{
  const fields = globalThis.__PCE_TEST_FIELDS__;
  const RULE = globalThis.__PCE_TEST_REWRITE__.RULES.tutorcruncherHost;
  const root = stepFixture("pabbly-api-endpoint-url.html");
  const collected = fields.collectFields(root);
  const scan = fields.scanStep(root, RULE);

  check("names the endpoint URL field and detects its TinyMCE editor", () => {
    const f = findField(collected, "API Endpoint URL");
    truthy(f, "API Endpoint URL field");
    eq(f.editor, "tinymce", "editor");
    eq(f.elementId, "textarea-1027297472178593172920555399021185119037", "element id");
    truthy(f.value.startsWith("https://secure.tutorcruncher.com/api/clients/"), "value read");
  });

  check("collects body params and header values", () => {
    truthy(findField(collected, "callback_url"), "callback_url param");
    truthy(findField(collected, "Header: Referer"), "Referer header");
    eq(findField(collected, "Header: Referer").editor, "input", "header editor");
  });

  // The response preview is captured test output, not configuration. Writing it would be meaningless
  // at best and would clobber a step's recorded sample at worst.
  check("excludes the captured test-response preview", () => {
    eq(collected.some((f) => /"status":200/.test(f.value)), false, "response textarea collected");
  });

  // The step's mapping dropdowns contain the exact host being searched for, in <option> text.
  check("never treats mapping-dropdown options as fields", () => {
    eq(collected.some((f) => /1\. Permalink/.test(f.value)), false, "dropdown option collected");
    eq(scan.fields.some((f) => /Permalink/.test(f.field)), false, "dropdown option scanned");
  });

  check("scan finds exactly the three real occurrences", () => {
    eq(scan.fields.length, 3, "fields with hits");
    eq(findField(scan.fields, "API Endpoint URL").count, 1, "endpoint hits");
    eq(findField(scan.fields, "callback_url").count, 1, "param hits");
    eq(findField(scan.fields, "Header: Referer").count, 1, "header hits");
  });

  check("scan carries reviewable before/after per field", () => {
    const f = findField(scan.fields, "API Endpoint URL");
    truthy(f.before.includes("secure.tutorcruncher.com"), "before");
    truthy(f.after.includes("app.tutorcruncher.com"), "after");
    eq(/(^|[^.\w])secure\.tutorcruncher\.com/.test(f.after), false, "old host gone from after");
    truthy(f.contexts[0].includes("tutorcruncher"), "context excerpt");
  });

  check("locates the per-step Save button", () => {
    const btn = fields.saveButton(root);
    truthy(btn, "save button");
    truthy(/save_only_curr_api_data/.test(btn.getAttribute("onclick")), "save handler");
  });

  check("reads the step's identity for the report", () => {
    const id = fields.stepIdentity(root);
    eq(id.indexLabel, "6", "index");
    eq(id.app, "API (Pabbly)", "app");
    eq(id.title, "Get Client info from TC", "title");
    eq(id.stepId, "IjU3NjAwNTZiMDYzNDA0MzI1MjY5NTUzNzUxMzMi_pc", "step id");
  });
}

console.log("\nField enumeration — Code (Pabbly) step");
{
  const fields = globalThis.__PCE_TEST_FIELDS__;
  const RULE = globalThis.__PCE_TEST_REWRITE__.RULES.tutorcruncherHost;
  const root = stepFixture("pabbly-code-step.html");
  const collected = fields.collectFields(root);
  const scan = fields.scanStep(root, RULE);

  check("treats the code body as a TinyMCE field, flagged as code", () => {
    const f = findField(collected, "JavaScript Code");
    truthy(f, "JavaScript Code field");
    eq(f.editor, "tinymce", "editor");
    eq(f.code, true, "code flag");
  });

  // A code step ships a hidden input.curr_api_url whose value is the literal "method_url".
  check("does not mistake the hidden curr_api_url input for an endpoint field", () => {
    eq(collected.some((f) => f.value === "method_url"), false, "method_url collected");
    eq(findField(collected, "API Endpoint URL"), undefined, "phantom endpoint field");
  });

  check("rewrites the host inside the code body only", () => {
    const f = findField(scan.fields, "JavaScript Code");
    truthy(f, "code body hit");
    eq(f.count, 1, "hit count");
    truthy(f.after.includes("'https://app.tutorcruncher.com/api/contractors/'"), "rewritten URL");
  });

  check("preserves the chip, the <br> breaks and the escaped comparison operator", () => {
    const f = findField(scan.fields, "JavaScript Code");
    truthy(f.after.includes('data-attr="0<=-+*/@/*+-=>events'), "dynamic_value chip intact");
    truthy(f.after.includes("pabbly-connect-linebreak"), "blank-line spans intact");
    truthy(f.after.includes("data.count &lt; 1"), "code's own escaped < untouched");
  });

  check("ignores the option and response-preview copies of the old host", () => {
    eq(scan.fields.length, 1, "only the code body has a writable hit");
  });
}

console.log("\nTask History — inventory from the run log");
{
  const history = globalThis.__PCE_TEST_HISTORY__;
  const html = readFileSync(join(HERE, "fixtures", "pabbly-task-history.html"), "utf8");
  const { document: doc } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const rows = history.scrapeRows(doc);

  check("reads one entry per execution row", () => {
    eq(rows.length, 5, "row count");
    eq(rows[0].name, "H_E_03_RP_Send_Confirmation_Email_After_Hireflix_Interview", "name");
    eq(rows[0].folder, "03 - Edpulse", "folder");
    eq(rows[0].id, "IjU3NjUwNTY0MDYzNTA0MzM1MjZjNTUzZDUxM2Ei_pc", "workflow id from href");
    eq(rows[0].status, "Success", "status");
    eq(rows[0].stepCount, 2, "step count");
  });

  check("keeps an ampersand in a workflow name intact", () => {
    eq(rows[2].name, "V2 - Send email after job application from Indeed & other job boards", "name");
  });

  // Found by running the parser against a real saved page: this cell's aria-label is a tooltip
  // ("Click here to view task details in brief."), not a "Label: value" pair, so trusting the label
  // returned that sentence as the Task History ID.
  check("reads the Task History ID, not the tooltip on its cell", () => {
    eq(rows[0].historyId, "IjU3NjYwNTZjMDYzMTA0MzA1MjZjNTUzNDUxMzc1MTY1NTQzNTBmMzci_pc", "history id");
  });

  check("keeps the execution timezone separate from the timestamp", () => {
    eq(rows[0].executedAt, "Aug 05, 2026 07:59:11", "timestamp");
    eq(rows[0].timezone, "(UTC -04:00) America/New_York", "timezone");
  });

  // The table is a run log: the same workflow appears once per execution. Queueing it unfolded would
  // re-crawl the busiest workflows dozens of times.
  check("folds repeated executions into one workflow each", () => {
    const wfs = history.foldByWorkflow(rows);
    eq(wfs.length, 4, "unique workflows");
    const contractor = wfs.find((w) => w.name === "Contractor Added Digits");
    eq(contractor.runs, 2, "run count");
    eq(contractor.statuses.Success, 1, "success runs");
    eq(contractor.statuses.Partial, 1, "partial runs");
    eq(contractor.folder, "Tipalti", "folder");
  });

  // Step count is per RUN, not per workflow — routers and filters change how much executes each time.
  check("keeps the largest step count across a workflow's runs", () => {
    const contractor = history.foldByWorkflow(rows).find((w) => w.name === "Contractor Added Digits");
    eq(contractor.stepCount, 31, "must be the max of 13 and 31, not the first seen");
  });

  check("reports the most recent execution per workflow", () => {
    const contractor = history.foldByWorkflow(rows).find((w) => w.name === "Contractor Added Digits");
    eq(contractor.lastRun, "Aug 05, 2026 07:56:00", "last run is the later of the two");
  });

  check("summarizes folders for the queue preview", () => {
    const { folders, workflows } = history.scrapeHistory(doc);
    eq(workflows.length, 4, "workflow count");
    eq(folders["03 - Edpulse"], 2, "Edpulse count");
    eq(folders["Tipalti"], 1, "Tipalti count");
  });

  check("reads the real scale of the run log off the pagination footer", () => {
    const p = history.readPagination(doc);
    truthy(p, "pagination");
    eq(p.totalRows, 24052, "total rows");
    eq(p.totalPages, 2406, "total pages");
    eq(p.pageSize, 10, "page size");
    eq(p.currentPage, 1, "current page");
    eq(p.rangeFrom, 1, "range from");
    eq(p.rangeTo, 10, "range to");
    eq(p.hasNext, true, "next enabled");
  });

  // 24052 rows in the footer against 5 in the DOM must never read as a full inventory.
  check("marks a single page as incomplete coverage", () => {
    const { coverage } = history.scrapeHistory(doc);
    truthy(coverage, "coverage");
    eq(coverage.seenRows, 5, "seen rows");
    eq(coverage.totalRows, 24052, "total rows");
    eq(coverage.complete, false, "must not claim completeness");
  });
}

console.log("\nVersion sources agree");
{
  // A release has to touch five places, and two consecutive bumps missed normalizer's copy — so every
  // export went out stamped 0.11.6 while the extension was 0.13.0, making a captured file impossible to
  // attribute to the code that produced it. Asserting them here is what stops that shipping again.
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  const contentSrc = readFileSync(join(ROOT, "src", "content.js"), "utf8");
  const popupSrc = readFileSync(join(ROOT, "src", "popup.js"), "utf8");
  const normalizerSrc = readFileSync(join(ROOT, "src", "normalizer.js"), "utf8");

  const pick = (src, re) => (src.match(re) || [])[1] || null;

  check("manifest, package.json and the changelog's latest entry match", () => {
    eq(pkg.version, manifest.version, "package.json vs manifest.json");
    eq(pick(changelog, /^## \[([0-9.]+)\]/m), manifest.version, "changelog latest vs manifest.json");
  });

  // The content script and the panel handshake on this: a mismatch is what tells a user to hard-reload.
  check("the content-script handshake matches the manifest", () => {
    eq(pick(contentSrc, /CONTENT_VERSION = "([0-9.]+)"/), manifest.version, "CONTENT_VERSION");
    eq(pick(popupSrc, /EXPECTED_CONTENT_VERSION = "([0-9.]+)"/), manifest.version, "EXPECTED_CONTENT_VERSION");
  });

  // Reads the manifest at runtime, so this only pins the out-of-extension fallback the tests exercise.
  check("the export's version fallback matches the manifest", () => {
    eq(pick(normalizerSrc, /FALLBACK_VERSION = "([0-9.]+)"/), manifest.version, "FALLBACK_VERSION");
    eq(EXTENSION_VERSION, manifest.version, "EXTENSION_VERSION as resolved in tests");
  });
}

console.log("\nStep readiness after Pabbly swaps the node");
{
  // The bug this pins: clicking a step header makes Pabbly replace the step's node (jQuery replaceWith
  // in its getFullActionStepHtml handler). Any reference taken before the click is detached, and its
  // stale subtree reports offsetParent === null forever — so a visibly-open step was reported as
  // "never loaded", 48 of 49 times, and the scan produced a false all-clear.
  const html = readFileSync(join(HERE, "fixtures", "pabbly-api-endpoint-url.html"), "utf8");
  const { document: doc } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const root = doc.querySelector(".webhook_api_mapping_div");

  check("an attached step with a populated body is ready", () => {
    truthy(root, "step present");
    eq(root.isConnected, true, "attached");
    truthy(root.querySelector(".card-body .form-group"), "body has fields");
  });

  check("a detached step is detectable rather than waited on", () => {
    const id = root.getAttribute("data_curr_api_index");
    truthy(id, "step carries data_curr_api_index — the handle that survives the swap");

    root.remove();
    eq(root.isConnected, false, "removed node reports itself detached");
    // Which is what makes re-lookup possible instead of polling the dead reference.
    eq(doc.querySelector(`.webhook_api_mapping_div[data_curr_api_index="${id}"]`), null, "gone from the document");
  });
}

console.log("\nTask Usage by Workflows — the authoritative catalogue");
{
  const history = globalThis.__PCE_TEST_HISTORY__;
  const html = readFileSync(join(HERE, "fixtures", "pabbly-task-usage.html"), "utf8");
  const { document: doc } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const rows = history.scrapeUsageRows(doc);

  check("reads one row per workflow with its usage", () => {
    eq(rows.length, 2, "row count");
    eq(rows[0].name, "Add data to GS - Multipage Form (FR)", "name");
    eq(rows[0].folder, "Home", "folder");
    eq(rows[0].tasks, 7855, "tasks consumed");
    eq(rows[0].freeTasks, 7071, "free tasks");
  });

  // Active/Inactive is information the run log cannot give at all.
  check("distinguishes Active from Inactive", () => {
    eq(rows[0].active, true, "row 1 active");
    eq(rows[0].status, "Active", "row 1 status");
    eq(rows[1].active, false, "row 2 inactive");
    eq(rows[1].status, "Inactive", "row 2 status");
  });

  check("reads the last-executed timestamp without its timezone suffix", () => {
    eq(rows[0].lastExecuted, "Aug 05, 2026 09:04:06", "timestamp");
    eq(rows[0].timezone, "(UTC -04:00) America/New_York", "timezone");
  });

  // Long names are truncated and carry a "Workflow Name:" aria-label; short ones have only text.
  check("reads a truncated long name", () => {
    eq(rows[1].name, "Update -Suivi des heures- when tutor is added/removed & status changes", "long name");
    eq(rows[1].folder, "Job Org Tracking - General", "folder");
  });

  // The blocker: no <a href> in these rows, so ids must come from React, never from the DOM.
  check("reports no id from the DOM alone", () => {
    eq(rows[0].id, null, "row 1 id");
    eq(rows[1].id, null, "row 2 id");
  });

  check("recognizes the usage tab by its columns and missing links", () => {
    eq(history.isUsageTab(doc), true, "usage tab detected");
  });

  check("reads the catalogue's true size — 276 workflows, not 24k runs", () => {
    const p = history.readPagination(doc);
    eq(p.totalRows, 276, "total workflows");
    eq(p.totalPages, 28, "total pages");
    eq(p.pageSize, 10, "page size");
  });
}

console.log("\nPabbly v2 REST backend — catalogue in one request");
{
  const api = globalThis.__PCE_TEST_PABBLY_API__;
  const REC = (over = {}) => ({
    _id: "IjU3NjUwNTZhMDYzNTA0MzI1MjZkNTUzNzUxMzQi_pc",
    name: "Add data to GS - Multipage Form (FR)",
    folderName: "Home",
    status: "active",
    taskConsumption: 7855,
    freeTasks: 7071,
    ...over
  });

  // The envelope is {status, message, data}, but whether records sit at data, data.workflows or deeper
  // is unknown and may differ per endpoint — so discovery is by content, not by field name.
  check("finds the record array wherever it sits in the envelope", () => {
    const shapes = {
      "data": { status: "success", data: [REC()] },
      "data.workflows": { status: "success", data: { workflows: [REC()] } },
      "data.rows": { status: "success", data: { rows: [REC()], total: 276 } },
      "data.result.items": { data: { result: { items: [REC()] } } }
    };
    Object.entries(shapes).forEach(([path, payload]) => {
      const hit = api.findRecordArray(payload);
      truthy(hit, `${path}: found`);
      eq(hit.path, path, `${path}: discovered path`);
    });
  });

  check("maps a record onto the canonical shape", () => {
    const w = api.recordFrom(REC());
    eq(w.id, "IjU3NjUwNTZhMDYzNTA0MzI1MjZkNTUzNzUxMzQi_pc", "id");
    eq(w.name, "Add data to GS - Multipage Form (FR)", "name");
    eq(w.folder, "Home", "folder");
    eq(w.active, true, "active");
    eq(w.tasks, 7855, "tasks");
  });

  // A folder id has the same `_pc` shape as a workflow id, so precedence has to be explicit or the
  // queue would navigate to folders.
  check("never mistakes a folder id for the workflow id", () => {
    const w = api.recordFrom({
      folderId: "IjU3NjAwNTZiMDYzNDA0MzI1MjY5NTUzNzUxMzMi_pc",
      _id: "IjU3NjUwNTZmMDYzZTA0Mzc1MjZmNTUzMTUxMzEi_pc",
      name: "Contractor Added Digits",
      folderName: "Tipalti"
    });
    eq(w.id, "IjU3NjUwNTZmMDYzZTA0Mzc1MjZmNTUzMTUxMzEi_pc", "workflow id");
    eq(w.folder, "Tipalti", "folder name");
  });

  check("reads Active/Inactive however it is encoded", () => {
    eq(api.recordFrom(REC({ status: "active" })).active, true, "string active");
    eq(api.recordFrom(REC({ status: "inactive" })).active, false, "string inactive");
    eq(api.recordFrom({ _id: REC()._id, name: "x", isActive: true }).active, true, "boolean");
    eq(api.recordFrom({ _id: REC()._id, name: "x", active: 0 }).active, false, "0/1");
  });

  check("prefers the complete array over a shorter one in the same payload", () => {
    const all = [REC({ _id: "IjU3NjUwNTZhMDYzNTA0MzI1MjZkNTUzNzUxMzQi_pc" }), REC({ _id: "IjU3NjYwNTZhMDYzNTA0MzQ1MjY1NTUzMjUxMzYi_pc" })];
    const hit = api.findRecordArray({ data: { top: [all[0]], everything: all } });
    eq(hit.arr.length, 2, "must pick the longer array");
  });

  check("rejects an array that is not records", () => {
    eq(api.findRecordArray({ data: [{ label: "no id here" }, { label: "still none" }] }), null, "no id array");
    eq(api.findRecordArray({ data: [1, 2, 3] }), null, "primitives");
  });

  check("reads the grand total, not a per-page count", () => {
    eq(api.findTotal({ data: { count: 10, totalRecords: 276 } }), 276, "grand total wins");
    eq(api.findTotal({ data: { rows: [] } }), null, "no total present");
  });

  // One malformed row must not disqualify the catalogue, but it must not reach the queue either. The
  // array has to clear the 80% id majority to be recognised at all, so this uses 4-of-5.
  check("keeps a catalogue with one malformed row, minus that row", () => {
    const ids = [
      "IjU3NjUwNTZhMDYzNTA0MzI1MjZkNTUzNzUxMzQi_pc",
      "IjU3NjYwNTZhMDYzNTA0MzQ1MjY1NTUzMjUxMzYi_pc",
      "IjU3NjUwNTZmMDYzZTA0Mzc1MjZmNTUzMTUxMzEi_pc",
      "IjU3NjAwNTZiMDYzNDA0MzI1MjY5NTUzNzUxMzMi_pc"
    ];
    const out = api.parseCatalogue({
      data: [...ids.map((id) => REC({ _id: id })), { name: "orphan with no id" }]
    });
    eq(out.total, 5, "array length seen");
    eq(out.workflows.length, 4, "the id-less row is dropped from the queue");
  });

  // Below that majority it is not treated as a catalogue at all — better to fall through to another
  // endpoint than to build a queue out of something that only half looks like workflows.
  check("refuses an array that mostly lacks ids", () => {
    eq(api.findRecordArray({ data: [REC(), { name: "orphan" }] }), null, "50% is not a catalogue");
  });

  check("builds a usage URL that asks for everything on one page", () => {
    const url = api.usageUrl(300);
    truthy(url.includes("limit=300"), "limit");
    truthy(url.includes("page=1"), "page");
    truthy(url.includes("workflowStatus=all"), "status filter cleared");
    truthy(url.includes("filterByFolderId=all"), "folder filter cleared");
  });
}

console.log("\nRewrite ledger — fix each workflow once, ever");
{
  // The ledger is the only stateful piece, so it gets a real in-memory chrome.storage.local rather
  // than a mock of its own methods: the eviction and merge logic has to run against actual round-trips.
  const memStore = {};
  globalThis.chrome = globalThis.chrome || {};
  globalThis.chrome.storage = {
    local: {
      get: async (k) => (Object.prototype.hasOwnProperty.call(memStore, k) ? { [k]: memStore[k] } : {}),
      set: async (o) => {
        Object.assign(memStore, o);
      },
      remove: async (k) => {
        delete memStore[k];
      }
    }
  };

  await clearLedger();

  await checkAsync("settles a fixed workflow so it is never reopened", async () => {
    await recordVisit({ id: "wf_a", name: "Contractor Added Digits", outcome: OUTCOMES.fixed, fieldsChanged: 3 });
    eq(await isSettled("wf_a"), true, "fixed is settled");
  });

  // A workflow scanned and found clean must also never be revisited, or the pass never converges.
  await checkAsync("settles a clean workflow too", async () => {
    await recordVisit({ id: "wf_b", name: "Already app.tutorcruncher", outcome: OUTCOMES.clean });
    eq(await isSettled("wf_b"), true, "clean is settled");
  });

  // A failure is the one outcome that must stay open, so a transient error gets another attempt.
  await checkAsync("leaves a failed workflow unsettled for retry", async () => {
    await recordVisit({ id: "wf_c", name: "Timed out", outcome: OUTCOMES.failed, error: "timeout" });
    eq(await isSettled("wf_c"), false, "failed must be retried");
    eq(await isSettled("wf_unknown"), false, "never-seen workflow");
  });

  await checkAsync("counts repeat visits without duplicating the entry", async () => {
    await recordVisit({ id: "wf_c", outcome: OUTCOMES.fixed, fieldsChanged: 1 });
    const led = await readLedgerForTest();
    eq(led.wf_c.visits, 2, "visit count");
    eq(led.wf_c.name, "Timed out", "name carried forward from the earlier visit");
    eq(await isSettled("wf_c"), true, "now settled");
  });

  // The whole point: an old execution row for an already-fixed workflow contributes no work.
  await checkAsync("drops already-settled workflows out of a fresh page's queue", async () => {
    const settled = await settledIds();
    const page = [
      { id: "wf_a", name: "Contractor Added Digits" },
      { id: "wf_b", name: "Already app.tutorcruncher" },
      { id: "wf_new", name: "Never seen" }
    ];
    const { queue, alreadyDone, freshCount } = partitionByLedger(page, settled);
    eq(freshCount, 1, "fresh count");
    eq(queue[0].id, "wf_new", "only the unseen workflow is queued");
    eq(alreadyDone.length, 2, "already done");
  });

  // A page of nothing but old runs is what tells the crawler it can stop paging.
  await checkAsync("reports zero fresh work for a page of only old runs", async () => {
    const settled = await settledIds();
    const { freshCount } = partitionByLedger([{ id: "wf_a" }, { id: "wf_b" }], settled);
    eq(freshCount, 0, "a fully settled page yields no work");
  });

  await checkAsync("summarizes the ledger for the panel", async () => {
    const stats = await ledgerStats();
    eq(stats.total, 3, "total");
    eq(stats.counts.fixed, 2, "fixed");
    eq(stats.counts.clean, 1, "clean");
    eq(stats.fieldsChanged, 4, "fields changed");
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

  // The Zap editor server-renders both a trunk-only list and the full graph. Picking the shorter
  // one silently drops every branch — which is exactly how a 10-step Zap exported as 4 steps.
  check("prefers the full graph over a trunk-only subset in the same payload", () => {
    const trunk = payload.objects.slice(0, 3);
    const hit = zap.findNodeArray({ pageProps: { trunk, graph: { objects: payload.objects } } });
    eq(hit.arr.length, 7, "must pick the longer array");
    truthy(zap.findNodeArrays({ trunk, all: payload.objects }).length >= 2, "both arrays detected");
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
    eq(f[0].conditions[0].field, "status", "field stripped of its node-id prefix");
    eq(f[0].conditions[0].step, 1, "field resolved to the source step");
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

  // Everything below mirrors a real "Update Lead to Client List" capture, where the Paths step came
  // through as a plain action named "Engine" and both filters reported zero parsed conditions.
  console.log("\nZapier — filter_criteria and Paths (Engine/parallel_paths)");
  const real = zap.nodesToSteps(
    JSON.parse(readFileSync(join(HERE, "fixtures", "zapier-filter-criteria.json"), "utf8")).objects
  );

  check("normalizes a built-in spelled as a plain title", () => {
    eq(real[0].app, "Webhooks by Zapier", "Web Hook -> product name");
    eq(real[1].app, "Filter by Zapier", "Filter -> product name");
  });

  check("recognizes an Engine/parallel_paths node as a router", () => {
    eq(real[2].app, "Paths by Zapier", "app");
    eq(real[2].type, "router", "type");
    truthy(Array.isArray(real[2].routes), "routes array present even with no branches captured");
  });

  check("parses filter_criteria delivered as a JSON string", () => {
    truthy(real[1].filter, "filter parsed");
    eq(findMapping(real[1].mappings, "filter_criteria"), undefined, "raw blob kept out of mappings");
  });

  check("groups rows by their group id, not by nesting", () => {
    eq(real[1].filter.length, 2, "group count");
    eq(real[1].filter[0].joiner, "AND", "first joiner");
    eq(real[1].filter[1].joiner, "OR", "second joiner");
    eq(real[1].filter[0].conditions.length, 2, "first group size");
    eq(real[1].filter[1].conditions.length, 2, "second group size");
  });

  check("reads match as the operator and marks negated rows", () => {
    const c = real[1].filter[0].conditions[0];
    eq(c.operator, "icontains", "operator from `match`");
    eq(c.value, "live", "value");
    eq(c.negated, undefined, "positive rows carry no negation flag");
    eq(real[1].filter[1].conditions[1].negated, true, "negated row flagged");
  });

  check("resolves a bare nodeId__path filter key to a step reference", () => {
    const c = real[1].filter[0].conditions[0];
    eq(c.field, "events[]subject__status", "field stripped of the node id");
    eq(c.step, 1, "resolved to the trigger's order");
  });

  // Zapier's real payload (props.pageProps.zap.current_version.zdl) has no parent_id anywhere: a
  // step's children are nested in its own steps[]. Reading it as a flat parent_id graph exported
  // the 4 top-level steps of this 10-step Zap and dropped both Paths branches entirely.
  console.log("\nZapier — nested zdl graph");
  {
    const nextData = JSON.parse(readFileSync(join(HERE, "fixtures", "zapier-zdl-nested.json"), "utf8"));

    check("picks the enclosing step list, not a longer nested branch", () => {
      const hit = zap.findNodeArray(nextData);
      truthy(hit, "node array");
      eq(hit.path, "props.pageProps.zap.current_version.zdl.steps", "path");
      eq(hit.arr.length, 4, "top-level count");
    });

    const zdl = zap.findNodeArray(nextData).arr;
    const steps = zap.nodesToSteps(zdl);

    check("walks nested steps[] into the full graph", () => {
      eq(steps.length, 4, "top-level steps");
      eq(countDeep(steps), 10, "total steps including both branches");
    });

    check("expands a parallel_paths step into one route per branch", () => {
      const paths = steps[3];
      eq(paths.type, "router", "type");
      eq(paths.app, "Paths by Zapier", "app");
      eq(paths.routes.length, 2, "route count");
      eq(paths.routes[0].stepCount, 3, "branch A size");
      eq(paths.routes[1].stepCount, 3, "branch B size");
    });

    check("names each route from its BranchingAPI condition step", () => {
      eq(steps[3].routes[0].routeName, "Client du primaire/secondaire", "route A");
      eq(steps[3].routes[1].routeName, "Client du cégep/université", "route B");
    });

    check("names the branch condition step by its product name", () => {
      eq(steps[3].routes[0].steps[0].app, "Paths by Zapier", "BranchingAPI app");
      eq(steps[1].app, "Filter by Zapier", "standalone filter app");
    });

    check("drops a branch's editor styling but keeps its evaluation order", () => {
      const cond = steps[3].routes[0].steps[0];
      eq(findMapping(cond.mappings, "emoji"), undefined, "emoji");
      eq(findMapping(cond.mappings, "color"), undefined, "color");
      eq(findMapping(cond.mappings, "path_eval_index").value, "0", "path_eval_index kept");
    });

    check("does not dump raw params into text when filter captured the config", () => {
      truthy(steps[1].text.length < 120, `filter step text length (${steps[1].text.length})`);
      eq(/filter_criteria/.test(steps[1].text), false, "raw blob must not reappear in text");
    });

    check("keeps branch children ordered after the trunk", () => {
      const branchA = steps[3].routes[0].steps;
      eq(branchA[0].order, 5, "first branch child order");
      eq(branchA[0].type, "filter", "branch condition is a filter");
      eq(branchA[1].app, "Sendy", "third-party app in branch");
      eq(branchA[1].event, "unsubscribe", "action");
      eq(steps[3].routes[1].steps[2].order, 10, "last step order");
    });

    check("resolves references from inside a branch back to the trigger", () => {
      const email = findMapping(steps[3].routes[0].steps[1].mappings, "email");
      truthy(email.references, "references");
      eq(email.references[0].step, 1, "resolved to the trigger");
      eq(email.references[0].field, "events[]subject__email", "field path");
    });

    check("parses the branch's own filter conditions", () => {
      const cond = steps[3].routes[0].steps[0].filter[0].conditions[0];
      eq(cond.field, "events[]subject__extra_attrs[]value", "field");
      eq(cond.step, 1, "source step");
      eq(cond.value, "Primaire", "value");
    });

    check("scores the whole Zap, branches included", () => {
      const h = analyzeSteps(steps);
      eq(h.counts.total, 10, "total");
      eq(h.counts.routes, 2, "routes");
      eq(h.level, "complete", "level");
    });
  }

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

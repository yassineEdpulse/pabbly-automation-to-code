# Pabbly → Code Extractor

A Chrome/Edge (Manifest V3) extension that captures a **Pabbly Connect** workflow and exports a clean schema you can hand to Claude to convert into code.

It captures the workflow two ways:

1. **Network JSON** — patches `fetch`/`XHR` at page load and records the JSON Pabbly's own API returns (the real source of truth).
2. **DOM scrape** — reads the on-screen step outline as a supplement/fallback.

Then it normalizes both into a structured schema and gives you three exports.

## Install (Chrome or Edge)

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (`automation-to-code`).
4. Pin the extension so its icon is visible.

## Use

1. Open a Pabbly Connect workflow in a tab and **reload the page once** with the extension installed (so the interceptor and content script are active).
2. **Single workflow:** click **Auto-capture steps (this workflow)** in the popup. The extension mimics clicking each step open — which triggers Pabbly to load each step's config — then parses the live DOM for `app`, `event`, and field `mappings`. Then **Export** / **⬇** on the workflow card.
3. **All workflows:** click **Export ALL workflows**. The extension navigates the tab through every workflow in the account, auto-expanding and parsing each (throttled to avoid hammering Pabbly). A progress bar shows status; when done, use **Copy all** / **Download all**. Don't use that tab while it runs.
4. Use the **search bar** to filter by workflow name or app. Click a card to preview its export JSON.
5. **Export list** (inventory panel) gives the full catalog of workflow names/IDs/webhook URLs without deep-parsing.

### How extraction works (Pabbly specifics)

Pabbly Connect is a server-rendered jQuery app. It does not return the workflow as one clean JSON document. Instead:

- The **full workflow inventory** (every automation in the account) is in the page's workflow-switcher `<select>` — the extension scrapes it into the **Export list** panel.
- Each **step's configuration** is fetched on click as `{"status":"success","html":"…"}`, where `html` is the rendered config form. The extension parses that HTML to pull the step's `app`, `event`, and `mappings`. This is why you must click each step open before capturing.
- If no step-config responses are captured yet, the extension falls back to a DOM **outline** of the steps (app names only, no field mappings).

### What the exported JSON contains

Every exported workflow JSON has four top-level keys:

- `systemPrompt` — a generic explainer telling the AI what this file is and how to read the schema (understand-only; it does not tell the AI how to write code).
- `extension` — metadata about the extension and where the workflow was captured.
- `schema` — the normalized workflow: `workflowName`, `confidence`, and ordered `steps[]` (each with `order`, `type`, `app`, `mappings`).
- `raw` — the untouched JSON Pabbly returned for this workflow (source of truth).

## Notes

- The normalizer is **heuristic** — it detects step arrays, apps, routers, filters, and field mappings by key names. The **raw JSON is always captured untouched**, so nothing is lost if detection is imperfect.
- To tune it precisely: capture one real workflow, send the **Raw JSON**, and the normalizer can be adapted to Pabbly's exact field names.
- Data is stored per-tab in `chrome.storage.session` and cleared when the tab closes or you click **Clear**.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 config, content scripts, permissions |
| `src/interceptor.js` | Runs in page (MAIN world), patches fetch/XHR |
| `src/content.js` | Relays captures, scrapes DOM on demand |
| `src/background.js` | Stores captures per tab |
| `src/normalizer.js` | Detects workflows, inventory, builds export JSON |
| `src/stepParser.js` | Parses Pabbly's `{status, html}` step config into app/event/mappings |
| `src/popup.{html,css,js}` | Popup UI and exports |

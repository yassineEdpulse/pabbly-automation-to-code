# Automation → Code Extractor

A Chrome/Edge (Manifest V3) extension that captures **Pabbly Connect workflows** and **Zapier Zaps** and exports a clean schema you can hand to Claude to convert into code.

It detects which platform the tab is on and reskins itself accordingly — Pabbly blue on `pabbly.com`, Zapier orange on `zapier.com` — down to the toolbar icon and the nouns in the UI.

Both platforms produce the **same export schema**, so anything downstream (the migration prompt, your code generator) only has to understand one shape.

## Install (Chrome or Edge)

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (`automation-to-code`).
4. Pin the extension. Clicking its icon opens the **side panel** (it stays open while you work — long bulk runs remain visible).

> After updating the extension, **hard-reload the site tab** (Ctrl+Shift+R). A normal F5 can leave the old content script running; the panel detects this and tells you.

## Use

1. Open Pabbly Connect or Zapier in a tab. The panel picks up the platform automatically.
2. **Single item:** open a workflow / Zap and click **Auto-capture steps**. Then **Export** (copies JSON) or **⬇** (downloads it) on its card.
3. **Whole account:** click **Export ALL**. When it finishes, use **Copy all**, **Download all**, **ZIP (1 file each)**, **NDJSON**, or **App report**.
4. **Export list** in the inventory row gives the full catalog of names/IDs without deep-parsing anything.
5. **Diagnostics** dumps what the extension actually saw — captured URLs, the learned API endpoint, selector counts. Start here when a capture comes back empty.

## How extraction works

The two platforms need completely different strategies, which is why each has its own adapter in `src/platforms/`.

### Pabbly Connect — click and scrape

Pabbly is a server-rendered jQuery app, not an SPA. There is no JSON document describing a workflow:

- The **full inventory** lives in the page's workflow-switcher `<select>`.
- Each **step's config** is fetched only when you click its header, arriving as `{"status":"success","html":"…"}`. The extension mimics those clicks, waits for each body, and parses the HTML.
- **Routers** need their route modals opened one at a time, recursively (depth-capped at 3).

This is inherently slow — roughly one page load and a few seconds per workflow.

### Zapier — learn the endpoint, then fetch

Zapier's editor is a Next.js SPA that loads the whole Zap as a JSON node graph, so nothing is clicked:

1. **Learn** — among the responses the page fetched for itself, find the one carrying the node array, and turn its URL into a template by substituting the Zap id. Cached in `chrome.storage.local`.
2. **Fetch** — every other Zap is then read in place with that template and your session cookie. No tab navigation, so a whole account takes seconds rather than minutes.
3. **Fall back** — server-rendered `__NEXT_DATA__`, then a short list of candidate endpoints, then (reported to the crawler) navigate-and-parse like Pabbly.

Zapier's endpoints are undocumented and can change, so the learned template always beats the guesses and every stage degrades rather than throwing.

Zapier's flat node list is rebuilt into a tree via `parent_id`. **Paths by Zapier** becomes a `router` with one route per Path; `{{123456__field}}` tokens are resolved from node ids to step positions.

## Find & replace across workflows (Pabbly)

The **Find & replace across workflows** panel rewrites a value — originally the TutorCruncher API host,
`secure.tutorcruncher.com` → `app.tutorcruncher.com` — across every step of every queued workflow, then
clicks each step's own **Save**. It is the only part of the extension that *writes* to the account, so
it is collapsed by default and **Apply** stays disabled until a scan has produced something to apply.

1. Open **Task History**. The panel lists one entry per workflow found in the run log (the table itself
   is one row per *execution* — ~24k rows over 15 days — so rows are folded by workflow id).
2. Enter the current value and its replacement, then **Scan (no changes)**. The tab walks each workflow,
   expands every step, and reports each match: workflow, folder, step, field, and the surrounding text.
3. Review, then **Apply & Save**. Each field is written, the step is saved, and the field is **re-read**
   to confirm the old value is gone. Anything unverified is reported as such, never assumed applied.

**Converging without paging 2,406 pages.** Every visit is recorded in a ledger
(`chrome.storage.local`), including workflows found already clean — otherwise the pass never
converges. A workflow fixed today keeps reappearing in the run log from executions days ago; the ledger
drops those from the queue, so paging stops as soon as pages stop yielding unseen workflows. `failed` is
the one outcome left unsettled, so a timeout is retried rather than written off. **Reset ledger** makes
everything eligible again.

### Why the write path looks the way it does

Every editable Pabbly value — API endpoint URLs, body params, filter values, and **Code (Pabbly)
JavaScript/Python bodies alike** — lives in a hidden `<textarea>` that TinyMCE has taken over. Three
consequences:

- **Writes go through the page's realm.** Assigning `.value` on that hidden textarea appears to work and
  is then lost when the editor syncs. `src/tinymce-bridge.js` runs in the MAIN world and writes via
  `tinymce.get(id).setContent()` + `.save()`. An apply run refuses to start if that bridge doesn't answer.
- **The value is HTML, so replacement is tag-aware.** Text is interleaved with
  `<span class="dynamic_value" data-attr="…">` mapping chips, and a code body stores newlines as `<br>`.
  A match inside a tag is *reported and not written* — a mangled `data-attr` silently unbinds the mapping
  and the step starts sending an empty value.
- **Only named field elements are touched.** A step also carries mapping `<select>` dropdowns whose
  `<option>` text contains full URLs from the trigger's sample payload, including the host being searched
  for. Those are not fields, and `.api_response_con` (the captured test response) is never written.

> **Pabbly has no undo.** Run **Export ALL** first — that gives you a full before-snapshot of every step
> to diff or restore from by hand.

## What the exported JSON contains

| Key | Meaning |
| ------ | ------ |
| `systemPrompt` | Platform-specific explainer telling the AI how to read the file (understand-only). |
| `schemaVersion` | Currently `2`. |
| `platform` | `"pabbly"` or `"zapier"`. |
| `extension` | Tool metadata and where the capture came from. |
| `schema` | `workflowName`, `confidence`, `health`, `stepCount`, and ordered `steps[]`. |
| `raw` | The untouched API payload when one exists; otherwise a short note (`schema.steps` is authoritative). |

Each step: `order`, `type` (trigger / action / router / filter), `app`, `event`, `mappings[]` (with `references[]` for cross-step values), plus `filter[]` on conditions and `routes[]` on branches.

`schema.health` is the extension's self-check: `level` (complete / partial / poor / failed), `score`, and `warnings[]` naming specific gaps. It reports whether data was **captured**, not whether it is **correct**.

Bulk exports wrap the same per-item shape in `workflows[]` with an account-wide `health` summary. NDJSON lines are the bare workflow object, with no envelope.

## Files

| File | Role |
| ---- | ---- |
| `manifest.json` | MV3 config, permissions, per-platform content scripts |
| `src/platforms/registry.js` | Branding, terminology, URLs and pacing per platform |
| `src/platforms/pabbly-content.js` | Pabbly adapter — DOM scraping, step expansion, router crawl, rewrite walk |
| `src/platforms/pabbly-fields.js` | Which step elements hold a value, and how each is read and written |
| `src/platforms/pabbly-history.js` | Task History → workflow queue, run-log scale, page advancing |
| `src/platforms/zapier-content.js` | Zapier adapter — node graph, endpoint learning, in-place fetch |
| `src/rewrite.js` | Tag-aware find & replace over one field value |
| `src/rewrite-ledger.js` | Durable record of handled workflows, so each is touched once |
| `src/tinymce-bridge.js` | Runs in the page (MAIN world), writes TinyMCE-backed fields |
| `src/content.js` | Shared content-script shell: capture bridge and message routing |
| `src/interceptor.js` | Runs in the page (MAIN world), records same-site fetch/XHR traffic |
| `src/background.js` | Service worker: bulk crawler, rewrite runs, branding, capture store |
| `src/normalizer.js` | Export envelopes and the per-platform system prompts |
| `src/health.js` | Completeness scoring and warnings |
| `src/db.js` | IndexedDB store for bulk results (namespaced by platform) |
| `src/zip.js` | Dependency-free ZIP writer |
| `src/popup.{html,css,js}` | Side-panel UI, theming and exports |
| `icons/make-icons.ps1` | Regenerates both icon sets |
| `tests/run.mjs` | Golden-fixture suite — `npm test` |

## Development

```bash
npm install
npm test       # golden fixtures: real parsers against saved Pabbly HTML and Zapier JSON
npm run check  # syntax-check every source file
```

Bump `CONTENT_VERSION` (`src/content.js`), `EXPECTED_CONTENT_VERSION` (`src/popup.js`) and `manifest.json` together — the handshake between them is what catches a stale content script.

## Notes

- Data is stored per tab in `chrome.storage.session` and cleared when the tab closes or you click **Clear**. Bulk results live in IndexedDB and survive a service-worker restart.
- **Exports embed live credentials** — API keys, request headers, webhook URLs, connected-account details. Treat generated files as secrets: keep them out of version control and rotate anything that has been shared.

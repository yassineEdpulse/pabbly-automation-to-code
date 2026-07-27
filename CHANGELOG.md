# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.6] - 2026-07-27

### Changed
- **Line-item flattening is now explained.** A field path containing `[]` was documented as "an array element", which reads as *one* element. Zapier actually flattens every value at that path into a single string, so a condition on `events[]subject__extra_attrs[]value` tests the whole array at once — `contains` passes if ANY element matches, and a `negated` `contains` passes only if NO element matches. A model reading the old wording could reimplement a filter as its own near-opposite. The prompt now states the flattening rule, tells the model to test the whole set, and warns that such a condition cannot reveal WHICH field matched — so if the automation is really keyed to one specific field, the export cannot prove it and the model should ask.
- **Opaque ids are called out.** Values for fields like `list`, `brand`, or `folder` export as Zapier's internal ids (`VSOspVs8TEPDetdPK4A2WQ`, `2`). The editor shows a human name next to them, but it resolves that name separately and it is not in the node graph, so the export cannot carry it. The prompt now tells the model to keep the id as a named constant and ask the user what it is called, rather than invent a name or leave a bare id inline.
- The Zapier prompt now states outright that the node graph carries no sample/test values, so nothing in the export shows what a field holds at runtime. The Pabbly export embeds samples in its references, and the absence of an equivalent here was previously left to inference.

## [0.11.5] - 2026-07-27

### Changed
- Negated filter conditions are now explicit. Zapier has no negative operators — the editor's "does not contain" is stored as the *positive* operator plus a stop flag, so exporting the pair verbatim read as its own opposite. Such conditions now carry `negated: true`, and the system prompt tells the model to invert the operator when it sees one. Replaces the `action: "stop"` field, whose name also collided with a step's `action`.

## [0.11.4] - 2026-07-27

### Fixed
- The per-branch condition step inside a Paths block exported as `Branching` rather than `Paths by Zapier`.
- A Path branch's editor styling (`emoji`, `color`) was exported as configuration. Those are dropped for branch steps only — they are legitimate parameters on other apps — while `path_eval_index`, which is the branch's evaluation order, is kept.
- Filter steps re-dumped their whole raw `filter_criteria` blob into `text`, because the check for "did anything get captured" looked only at `mappings` and a filter's config lives in `filter`. A step whose conditions parsed now gets the short summary like every other captured step.

## [0.11.3] - 2026-07-27

### Fixed
- **Zapier Zaps with Paths exported only their trunk.** A 10-step Zap came out as 4 steps with both branches missing. Zapier's own graph (`zap.current_version.zdl`) carries no `parent_id` at all — a step's children are nested in its own `steps[]`, and a Paths step holds one wrapper per branch whose `steps[]` is that branch's chain. The walker assumed a flat `parent_id`-linked list, found no children, and stopped at the branch point. Both shapes are now handled, chosen by inspecting the data rather than assuming.
- Branch routes take their name from the `BranchingAPI` step that opens them, so a route reads as "Client du primaire/secondaire" rather than "Path A". Steps inside a branch are numbered continuously with the trunk, so references and `order` stay consistent across the whole Zap.
- When a payload contained several candidate step arrays, the root list was not reliably chosen — a long branch could outrank a short trunk and discard everything above it. The array that encloses the others now wins.
- A trigger with no configurable fields (a Zapier catch-hook takes none) was reported as "captured no field mappings", which alone dropped an otherwise complete Zap to a "poor 0%" health score. An empty trigger is now counted as fully captured.

### Changed
- The Zapier adapter no longer probes for a node API. Zapier server-renders the whole Zap into the page, and the endpoints previously guessed at do not exist — every one returned 404.

## [0.11.2] - 2026-07-27

### Fixed
- Zapier Filter steps exported zero parsed conditions. Zapier stores filter rows as a JSON *string* under `filter_criteria`, so reading the parameter straight off the node yielded an opaque blob; the string is now parsed, and `filter_criteria` is recognized alongside the other condition keys.
- Filter grouping read the wrong shape. Current Zaps deliver a flat list where each row carries a `group` id — rows sharing a group are AND'd and the groups OR'd — rather than the nested arrays older Zaps use. All three shapes (nested, grouped, flat) are now handled.
- Filter conditions took their operator from `op`, but Zapier writes it as `match`, so every condition exported a null operator. Rows marked `action: "stop"` are also flagged now, since those end the Zap when they match rather than gating it.
- Filter conditions address their source with a bare `<nodeId>__<path>` key, which was exported verbatim. It is now resolved the same way `{{…}}` tokens are: the condition carries a `step` matching another step's `order`, and `field` holds the path alone.
- Paths steps were exported as plain actions named "Engine" with no routes. Zapier does not model Paths as a node type — the branch point is an Engine app node whose action is `parallel_paths` — so matching on type alone lost the entire router. A Paths node is now typed `router` even when no branch was captured, so health reports the missing branches instead of hiding them behind "action captured no fields".
- Built-ins spelled as a plain title rather than an API identifier (`Web Hook`) exported unnormalized. App names now go through one normalization step however they were derived.
- Node-array detection could settle on a trunk-only subset when the editor payload contained both that and the full graph, exporting a 10-step Zap as 4 steps with every branch silently dropped. The longest graph now wins, with the heuristic score as the tie-break, and branch nodes leaner than trunk nodes are no longer rejected outright.

## [0.11.1] - 2026-07-27

### Fixed
- Zapier steps exported their raw internal identifier as the app name (`EmailParserCLIAPI@1.1.2` rather than `Email Parser by Zapier`). Nodes repeat that identifier in an `app` field, which short-circuited the humanizer before it ran; a value shaped like an API id is now normalized rather than taken at face value.
- Apps built on Zapier's CLI platform identify their action by UUID, so `event` exported an opaque id where the editor shows a name. The step's title now wins over an id, and `title` is carried through to the export — previously the adapter captured it and the normalizer dropped it.
- Zapier steps re-encoded every parameter into `text` as escaped JSON, roughly doubling each export and duplicating the code body of a Code step. Zapier's `mappings` already are the params, so `text` is now a short summary; the full dump is kept only when nothing reached `mappings` and it is the sole record of the step's config.

### Changed
- Version bumped so the content-script handshake catches a stale page. 0.11.0's Zapier fixes shipped without a version change, so a page still running the pre-fix script passed the check silently and kept producing the old output.

## [0.11.0] - 2026-07-27

### Added
- **Zapier support.** The extension now captures Zapier Zaps as well as Pabbly Connect workflows, normalizing both into the same export schema so anything downstream only has to understand one shape. Paths by Zapier become `router` steps with one route per Path, Filter conditions become the usual OR-of-AND groups, and Code by Zapier steps carry their source in `mappings`.
- Zapier extraction learns its own endpoint instead of hard-coding one: it finds the response carrying the Zap's node graph among the requests the editor already made for itself, turns that URL into a template, and caches it. Every remaining Zap is then read in place with the session cookie — no tab navigation, so a whole account takes seconds rather than the minutes-per-item that Pabbly's click-and-scrape requires. It falls back to the server-rendered `__NEXT_DATA__`, then to candidate endpoints, then to navigate-and-parse.
- Zapier's `{{nodeId__field}}` tokens are resolved from internal node ids to step positions, so `references[]` means the same thing on both platforms.
- Platform-aware theming: the side panel reskins completely on a Zapier tab — Zapier's own cream palette and `#ff4a00` brand orange, against the existing dark blue for Pabbly. The header names the detected platform, the toolbar icon and tooltip swap per tab, and the UI's nouns follow suit ("Export ALL Zaps" vs "Export ALL workflows").
- **Diagnostics** button: dumps the captured URLs, the learned API endpoint, selector counts and the content-script version, and copies it to the clipboard. This is the first thing to reach for when a capture comes back empty.
- Steps carry the `title` shown in the editor ("Run Javascript", "New Email") when it differs from the app name. For apps built on Zapier's CLI platform this is often the only human-readable label, since their `action` is an opaque UUID.
- Golden-fixture tests for the Zapier adapter — node-graph parsing, Paths, filter groups, reference resolution, inventory detection, endpoint learning and app naming — bringing the suite to 41 assertions.

### Changed
- Renamed to **Automation Code Extractor**, since it is no longer Pabbly-only. The panel header shows whichever platform the tab is on.
- Platform-specific page logic moved into `src/platforms/`, leaving `src/content.js` as a shared shell that bridges captures and routes messages. Each site loads only its own adapter.
- System prompts are now per-platform: a Zapier export explains node ids, Paths and Zapier's parameter-key conventions rather than Pabbly's `N. Label : sample` references. Exports carry a `platform` field.
- Bulk results are namespaced by platform in IndexedDB (schema v2, with an upgrade that re-keys existing Pabbly rows), so the two accounts' captures cannot collide and the panel shows only the current platform's results.
- The network interceptor now matches on the current site rather than a hard-coded Pabbly domain, and records request bodies for POSTs so responses from a single shared endpoint can still be told apart.
- Bulk pacing is per-platform: Pabbly keeps its cautious 1.5s throttle and 50-item batches, Zapier runs far tighter because it is not driving a browser.

### Fixed
- Router/filter detection no longer relies on the app name containing "router" or "filter", which silently missed every Zapier branch and condition step. Adapters state a step's role outright, and health scoring, type classification and the app report all honour it.
- Status colours (the green/amber/red used by health pills, warnings and the error log) are themeable rather than hard-coded, so they stay legible on Zapier's light background instead of washing out.

### Security
- Zapier exports embed live credentials the same way Pabbly's do — connected-account details, API keys and webhook URLs. Treat generated files as secrets: keep them out of version control and rotate anything that has been shared.

## [0.10.0] - 2026-07-02

### Added
- Per-workflow completeness scoring: every export now carries a `health` block (`level`, `score`, `warnings[]`) that names the specific gaps — actions with no captured fields, routers with no routes, empty route branches, filters with no conditions. Bulk exports add an account-wide `health` summary listing every workflow needing attention.
- Health filter chips (Complete / Partial / Poor / Failed) and health pills on each result card.
- Retry-failed: re-runs only the workflows that errored, instead of restarting the whole account.
- One-file-per-workflow ZIP export and NDJSON export, so a large account can be fed to a model one workflow at a time instead of as a single oversized JSON.
- App/trigger coverage report (`buildAppReport`) ranking apps by how many workflows use them, to prioritise which integrations to build first.
- Elapsed time, ETA, per-workflow pace and current throttle shown live during a bulk run.
- Collapsible error log listing failed workflows by name.
- Session-expiry detection: the crawler recognises a bounce to the Pabbly login page and auto-pauses with a "log back in, then Resume" prompt instead of recording hundreds of empty results.
- Adaptive throttling with exponential backoff after repeated failures, and an automatic pause after six consecutive errors.
- `schemaVersion` on every export.
- Golden-fixture test suite (`npm test`) running the real content-script parsers against saved Pabbly HTML — 19 assertions covering SMTP parameters, filters, routers, value cleanup, dynamic references, and health scoring.
- Non-blocking toast notifications.

### Changed
- The UI is now a **side panel** instead of a popup, so it no longer closes when it loses focus and long bulk runs stay visible.
- Bulk results are stored in **IndexedDB** and written incrementally, one workflow at a time, rather than accumulated in a single `chrome.storage.local` value.
- Result list renders in chunks of 100 with a "Show more" control so large accounts stay responsive.
- The interceptor now passes non-Pabbly requests straight through, keeping the extension out of unrelated third-party stack traces.

### Fixed
- **`Resource::kQuotaBytes quota exceeded`**: the previous bulk crawler accumulated every captured workflow in `chrome.storage.local`, overrunning its ~10MB quota partway through a large account and losing the run. Results moved to IndexedDB, with an upgrade migration that strips the legacy payload and any oversized saved view state.
- "Export ALL workflows" did nothing after confirming: `confirm()` tears down an extension popup, destroying the handler before the start message was sent. The confirmation was removed and the run now starts directly on click.
- Webhook trigger steps recorded the sibling "Select Response" dropdown value (`Response A`) as the Webhook URL, because a `<select>` was read in preference to the URL input. A URL-bearing input now wins.
- Downloaded exports declare `charset=utf-8`, so accented content (`é`, `«`, `—`) no longer renders as mojibake when opened by tools that otherwise assume ANSI.
- Dropped two sources of junk in `mappings`: the "Response Received" field (captured test-run output, not configuration — the payload is still in `text`) and any value containing Pabbly's internal path encoding (`0<=-+*/@/*+-=>events<=-+($@$)+-=>…`).
- Live-page exports no longer copy every step into `raw` as well as `schema.steps`, which roughly halved each file. `raw` now carries a short note, and the system prompt explains that `schema.steps` is authoritative for a live capture while `raw` is the source of truth only for API-JSON captures.

### Security
- Exports embed live credentials found in workflow configuration (for example an `x-api-key` request header) in both `mappings` and `text`. Treat generated files as secrets: keep them out of version control and rotate any key that has been shared.

## [0.9.4] - 2026-07-02

### Added
- Popup state now persists per tab (parsed workflows, inventory, selected card + JSON preview, and search text), so closing and reopening the popup restores exactly what you had instead of resetting. The background bulk crawl already ran independently of the popup.

### Changed
- Clear now also wipes the persisted popup state for a true reset.

### Fixed
- Auto-capture no longer throws a `ReferenceError` (undefined `mapped`) when nothing is parsed; the diagnostic readout renders correctly.

## [0.9.3] - 2026-06-24

### Added
- Extraction of structured app-action parameters (SMTP "Send Email", API, Slack, and similar steps) whose fields live in parameter rows rather than plain form groups — captures From/To/Subject/Body and equivalents.
- Custom request-header capture for API-style steps.

### Changed
- Generic field scan now skips the app/event pickers, parameter/header containers, and the test-response preview, removing "Response Received" and option-list noise.

## [0.9.2] - 2026-06-23

### Added
- Full-workflow capture: filters with condition groups, Code (Pabbly) step JavaScript, and recursive router/route expansion with per-child field mappings.
- Dynamic-reference detection: mapping values shaped like `N. Label : sample` are parsed into a `references` array (step + field), with the schema prompts explaining that the text after the colon is a sample, not a constant.

### Changed
- Hardened bulk crawler and popup rendering for long runs.

### Fixed
- Popup character-encoding (mojibake) issue; brand text and icons cleaned up.

## [0.9.0] - 2026-06-23

### Added
- Chrome/Edge (Manifest V3) extension that captures Pabbly Connect automations directly from the live workflow page.
- Per-step extraction of trigger, actions, app, event, and configured field mappings.
- Filter parsing into structured condition groups (`field` / `operator` / `value`, OR-of-AND groups).
- Router parsing into `routes[]` branches, each with its child steps; first child captured as the branch condition.
- Recursive nested-router crawling (depth-capped) so routers inside routes are fully expanded.
- Clean per-workflow JSON export with an embedded `systemPrompt` explaining the schema for an AI to understand.
- Full-account workflow inventory scraped from the workflow switcher, exportable as its own list.
- Bulk "Export ALL workflows" crawler that navigates the account and deep-captures every workflow.
- Hardened bulk run: per-workflow timeout, watchdog recovery from stalls/service-worker restarts, resumable batching (50 at a time) with a Resume control, throttling, and partial Copy all / Download all.
- Popup UI: Auto-capture, search, per-workflow Export/Download, raw-capture export, and a version handshake that warns when the page is running a stale content script.
- Value cleanup that de-HTMLs mapped values (readable code/JSON) and drops UI noise.

### Security
- Captured exports may contain live tokens and IDs; treat exports as sensitive and move secrets to environment variables before generating code.

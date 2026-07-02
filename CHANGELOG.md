# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

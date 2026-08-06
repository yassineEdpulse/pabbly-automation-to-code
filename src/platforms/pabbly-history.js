// Reads the workflow inventory off Pabbly's Task History page.
//
// Loaded by the manifest as a content script before pabbly-content.js, in the same isolated-world
// scope; registers on __PCE_HISTORY.
//
// Why this exists as a second inventory source: the editor's `#select_change_workflow_id` dropdown is
// only present on a workflow page, so nothing can be enumerated from the history tab. The history
// table is also a different app entirely — React/MUI, not the server-rendered jQuery editor — so it
// shares no selectors with the rest of the Pabbly adapter.
//
// The table lists one row per RUN, not per workflow: a workflow that fired 40 times appears 40 times.
// Rows are folded by workflow id, which is what turns "15 days of executions" into a work queue.
// Nothing here is keyed off MUI's generated class names (`css-1h0wk5n`) — those change whenever
// Pabbly rebuilds, so every selector uses the stable aria-labels and the workflow href instead.
(() => {
  const cleanText = (el) => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();

  const EDITOR_HREF = 'a[href*="/workflow/mapping/"]';
  const AFTER_COLON = /^[^:]*:\s*/;

  const idFromHref = (href) => {
    const m = (href || "").match(/\/workflow\/mapping\/([^/?#]+)/);
    return m ? m[1] : null;
  };

  // aria-labels come in two flavours and they are NOT interchangeable:
  //
  //   "Workflow Name: X" / "Folder Name: Y"        — the label carries the value after the colon.
  //   "Click here to view task details in brief."  — a pure tooltip; the value is the element's text.
  //
  // Treating the second kind like the first returned the tooltip sentence as the Task History ID.
  // Requiring a colon before trusting the label is what separates them.
  const labelled = (row, prefix, fallbackEl) => {
    const el = [...row.querySelectorAll("[aria-label]")].find((e) =>
      (e.getAttribute("aria-label") || "").startsWith(prefix)
    );
    if (el) {
      const aria = el.getAttribute("aria-label") || "";
      if (aria.includes(":")) {
        const v = aria.replace(AFTER_COLON, "").trim();
        if (v) return v;
      }
      if (cleanText(el)) return cleanText(el);
    }
    return fallbackEl ? cleanText(fallbackEl) || null : null;
  };

  const statusOf = (row) => {
    const el = [...row.querySelectorAll("[aria-label]")].find((e) =>
      /^Task execution/.test(e.getAttribute("aria-label") || "")
    );
    return el ? cleanText(el) || null : null;
  };

  // The aria-label is "Execution Time:  Aug 05, 2026 07:59:11, (UTC -04:00) America/New_York" — the
  // zone is appended after the timestamp, and leaving it attached makes Date.parse return NaN, which
  // silently defeats the most-recent-run comparison. The cell's visible text is the bare timestamp.
  const executionOf = (row) => {
    const el = [...row.querySelectorAll("[aria-label]")].find((e) =>
      /^Execution Time:/.test(e.getAttribute("aria-label") || "")
    );
    if (!el) return { executedAt: null, timezone: null };
    const label = (el.getAttribute("aria-label") || "").replace(AFTER_COLON, "").trim();
    const zone = label.match(/,\s*(\(UTC[^)]*\).*)$/);
    return {
      executedAt: cleanText(el) || label.replace(/,\s*\(UTC[\s\S]*$/, "").trim() || null,
      timezone: zone ? zone[1].trim() : null
    };
  };

  const stepCountOf = (row) => {
    const el = [...row.querySelectorAll("[aria-label]")].find((e) =>
      /total number of tasks consumed/.test(e.getAttribute("aria-label") || "")
    );
    const m = cleanText(el).match(/(\d+)\s+Steps?\s+Workflow/i);
    return m ? Number(m[1]) : null;
  };

  const parseRow = (row) => {
    const link = row.querySelector(EDITOR_HREF);
    if (!link) return null;
    const id = idFromHref(link.getAttribute("href"));
    if (!id) return null;
    const { executedAt, timezone } = executionOf(row);
    return {
      id,
      name: labelled(row, "Workflow Name:", link),
      folder: labelled(row, "Folder Name:", null),
      status: statusOf(row),
      executedAt,
      timezone,
      stepCount: stepCountOf(row),
      historyId: labelled(row, "Click here to view task details", null)
    };
  };

  const scrapeRows = (doc) =>
    [...(doc || document).querySelectorAll("tbody tr")].map(parseRow).filter(Boolean);

  const timeOf = (row) => {
    const t = Date.parse(row.executedAt || "");
    return Number.isNaN(t) ? null : t;
  };

  // One entry per workflow, carrying enough run history to triage: how often it fired, whether any
  // run failed, and when it last ran. `runs` is why an account with 400 rows yields ~90 items.
  const foldByWorkflow = (rows) => {
    const byId = new Map();
    rows.forEach((row, order) => {
      const prev = byId.get(row.id);
      if (!prev) {
        byId.set(row.id, {
          id: row.id,
          name: row.name,
          folder: row.folder,
          stepCount: row.stepCount,
          runs: 1,
          statuses: row.status ? { [row.status]: 1 } : {},
          lastRun: row.executedAt || null,
          firstSeenOrder: order
        });
        return;
      }
      prev.runs += 1;
      if (row.status) prev.statuses[row.status] = (prev.statuses[row.status] || 0) + 1;
      // "N Steps Workflow" counts the steps THAT RUN executed, not the steps the workflow has: the
      // same workflow reported 3 on one row and 80 on another, because routers and filters change how
      // much of it runs each time. The largest run is the closest available proxy for its real size, so
      // taking the first one seen was arbitrary and understated big workflows.
      if (row.stepCount != null) {
        prev.stepCount = prev.stepCount == null ? row.stepCount : Math.max(prev.stepCount, row.stepCount);
      }
      if (!prev.folder) prev.folder = row.folder;
      const a = timeOf(row);
      const b = Date.parse(prev.lastRun || "");
      if (a != null && (Number.isNaN(b) || a > b)) prev.lastRun = row.executedAt;
    });
    return [...byId.values()].sort((x, y) => x.firstSeenOrder - y.firstSeenOrder);
  };

  // The footer is the only place that reveals the true size of the run log, and it matters: a real
  // account shows "1–10 of 24052" across 2406 pages. Folding that by workflow yields on the order of
  // a hundred distinct workflows, so paging the table to find them costs thousands of requests to
  // learn something the "Task Usage by Workflows" tab already lists once per workflow. This reader
  // exists so the panel can state the cost up front rather than start a run that never ends.
  const NUM = /(\d[\d,\s]*)/;
  const toInt = (s) => {
    const m = NUM.exec(s || "");
    return m ? Number(m[1].replace(/[,\s]/g, "")) : null;
  };

  const readPagination = (doc) => {
    const root = (doc || document).querySelector(".MuiTablePagination-root");
    if (!root) return null;

    const range = [...root.querySelectorAll("[aria-label]")].find((e) =>
      /^Shows the current range/.test(e.getAttribute("aria-label") || "")
    );
    // "1–10 of 24052" — an en-dash in the live markup, so both dash forms are accepted.
    const rangeText = cleanText(range);
    const rangeMatch = rangeText.match(/([\d,\s]+)\s*[–-]\s*([\d,\s]+)\s+of\s+([\d,\s]+)/i);

    const pageBox = [...root.querySelectorAll("[aria-label]")].find((e) =>
      /^Selected page number/.test(e.getAttribute("aria-label") || "")
    );
    const pageInput = pageBox && pageBox.querySelector("input");
    const totalPages = toInt((cleanText(root.querySelector(".MuiTablePagination-displayedRows")).match(/of\s+([\d,\s]+)\s*$/) || [])[1]);

    const sizeInput = root.querySelector('input[name="table-pagination-select"]');
    const sizeCombo = root.querySelector(".MuiTablePagination-select");
    const next = [...root.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") || "") === "Go to next page"
    );

    return {
      totalRows: rangeMatch ? toInt(rangeMatch[3]) : null,
      rangeFrom: rangeMatch ? toInt(rangeMatch[1]) : null,
      rangeTo: rangeMatch ? toInt(rangeMatch[2]) : null,
      pageSize: toInt(sizeInput ? sizeInput.value : cleanText(sizeCombo)),
      currentPage: toInt(pageInput ? pageInput.getAttribute("value") || pageInput.value : null),
      totalPages,
      hasNext: !!next && !next.hasAttribute("disabled")
    };
  };

  const nextPageButton = (doc) => {
    const root = (doc || document).querySelector(".MuiTablePagination-root");
    if (!root) return null;
    const btn = [...root.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") || "") === "Go to next page"
    );
    return btn && !btn.hasAttribute("disabled") ? btn : null;
  };

  // Clicking is what MUI expects; a real click event reaches React's delegated listener, whereas
  // writing the page-number input's .value does not (React tracks it through its own descriptor).
  // Completion is detected by the displayed range changing rather than by a fixed sleep, so a slow
  // page never gets read twice at the old offset.
  const advancePage = async (waitMs = 8000, gap = 250) => {
    const rangeText = () => cleanText(document.querySelector(".MuiTablePagination-displayedRows"));
    const before = rangeText();
    const btn = nextPageButton();
    if (!btn) return { advanced: false, reason: "no next page" };

    btn.click();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, gap));
      const now = rangeText();
      if (now && now !== before) return { advanced: true, range: now };
    }
    return { advanced: false, reason: "page did not change in time", range: before };
  };

  // Raising rows-per-page is the single biggest win available: at 10/page a 24k-row log is 2400 pages,
  // at 100 it is 240. MUI renders this as a combobox, not a <select>, so it has to be driven by clicks —
  // and the option list is only in the DOM once opened, so the available sizes are discovered rather
  // than assumed. Entirely best-effort: on any surprise it reports what happened and the caller carries
  // on at whatever page size is already in effect.
  const setPageSize = async (target = 100, waitMs = 6000, gap = 200) => {
    const combo = document.querySelector(".MuiTablePagination-select");
    if (!combo) return { changed: false, reason: "no page-size control" };

    const current = readPagination();
    if (current && current.pageSize >= target) {
      return { changed: false, reason: `already ${current.pageSize}/page`, pageSize: current.pageSize };
    }

    combo.click();

    let options = [];
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, gap));
      options = [...document.querySelectorAll('[role="listbox"] [role="option"], [role="listbox"] li')]
        .map((el) => ({ el, n: toInt(cleanText(el)) }))
        .filter((o) => o.n);
      if (options.length) break;
    }
    if (!options.length) {
      try {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      } catch (_) {}
      return { changed: false, reason: "page-size options never appeared" };
    }

    // The largest offered size that does not exceed the target, so an unexpected menu can't be misread
    // into picking something absurd.
    const pick = options.filter((o) => o.n <= target).sort((a, b) => b.n - a.n)[0];
    if (!pick) return { changed: false, reason: `no option at or below ${target}` };

    const before = cleanText(document.querySelector(".MuiTablePagination-displayedRows"));
    pick.el.click();

    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, gap));
      const now = cleanText(document.querySelector(".MuiTablePagination-displayedRows"));
      if (now && now !== before) {
        const after = readPagination();
        return { changed: true, pageSize: after ? after.pageSize : pick.n };
      }
    }
    return { changed: false, reason: "page size did not take effect", requested: pick.n };
  };

  // --- Task Usage by Workflows tab ----------------------------------------------------------------
  // The sibling tab lists each workflow ONCE with its 30-day usage: 276 rows over 28 pages, against
  // 23,828 execution rows over 2,383. It is the authoritative catalogue and it also reports Active vs
  // Inactive, which the run log cannot.
  //
  // The catch, and it is a hard one: these rows contain NO link. The run log's name cell is an <a
  // href="/workflow/mapping/{id}">, this one is a bare <span>. So this tab yields names, never ids —
  // and the crawler navigates by id. It is a catalogue and a cross-check, not a queue by itself.
  //
  // Columns are located by their header text rather than by position or by MUI's generated classes
  // (`css-690vec` is shared by two different columns here), so a reordered or restyled table still reads.
  const usageColumnIndex = (table) => {
    const heads = [...table.querySelectorAll("thead th")].map((th) => cleanText(th).toLowerCase());
    const find = (re) => heads.findIndex((h) => re.test(h));
    return {
      status: find(/status\s*\/\s*last executed/),
      app: find(/^application/),
      name: find(/workflow name/),
      usage: find(/task consumption/)
    };
  };

  const labelledIn = (cell, prefix) => {
    if (!cell) return null;
    const el = [...cell.querySelectorAll("[aria-label]")].find((e) =>
      (e.getAttribute("aria-label") || "").startsWith(prefix)
    );
    return el;
  };

  const usageRow = (row, cols) => {
    const cells = [...row.querySelectorAll("td")];
    if (cells.length < 2) return null;

    const nameCell = cols.name >= 0 ? cells[cols.name] : null;
    if (!nameCell) return null;
    // Long names carry an "Workflow Name: X" aria-label because they are truncated; short ones do not,
    // so the first span's text is the reliable read and the label is only a fallback.
    const spans = [...nameCell.querySelectorAll("span")].map(cleanText).filter(Boolean);
    const labelled = labelledIn(nameCell, "Workflow Name:");
    const name =
      spans[0] ||
      (labelled ? (labelled.getAttribute("aria-label") || "").replace(AFTER_COLON, "").trim() : null);
    if (!name) return null;

    const statusCell = cols.status >= 0 ? cells[cols.status] : null;
    const statusEl = labelledIn(statusCell, "Workflow is");
    const execEl = labelledIn(statusCell, "Last Executed at:");
    const execLabel = execEl ? (execEl.getAttribute("aria-label") || "").replace(AFTER_COLON, "").trim() : "";
    const zone = execLabel.match(/,\s*(\(UTC[^)]*\).*)$/);

    const usageCell = cols.usage >= 0 ? cells[cols.usage] : null;
    const tasksEl = labelledIn(usageCell, "Number of tasks consumed");
    const freeEl = labelledIn(usageCell, "Pabbly Connect does not charge");

    return {
      id: null,
      name,
      folder: spans[1] || null,
      active: statusEl ? /^active$/i.test(cleanText(statusEl)) : null,
      status: statusEl ? cleanText(statusEl) : null,
      lastExecuted: execEl ? cleanText(execEl) || null : null,
      timezone: zone ? zone[1].trim() : null,
      tasks: toInt(cleanText(tasksEl)),
      freeTasks: toInt(cleanText(freeEl))
    };
  };

  const scrapeUsageRows = (doc) => {
    const table = (doc || document).querySelector("table.MuiTable-root");
    if (!table) return [];
    const cols = usageColumnIndex(table);
    if (cols.name < 0) return [];
    return [...table.querySelectorAll("tbody tr")].map((r) => usageRow(r, cols)).filter(Boolean);
  };

  const isUsageTab = (doc) => {
    const table = (doc || document).querySelector("table.MuiTable-root");
    return !!table && usageColumnIndex(table).usage >= 0 && !table.querySelector(EDITOR_HREF);
  };

  // --- Asking the page's realm for the ids React is holding -----------------------------------------
  const RREQ = "PCE_REACT_REQ";
  const RRES = "PCE_REACT_RES";
  let rSeq = 0;

  const askReact = (payload, timeoutMs = 8000) =>
    new Promise((resolve) => {
      rSeq += 1;
      const nonce = `pcer_${Date.now()}_${rSeq}`;
      let done = false;
      const onMessage = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.__pceTag !== RRES || d.nonce !== nonce) return;
        done = true;
        window.removeEventListener("message", onMessage);
        resolve(d.payload || { ok: false, reason: "empty reply" });
      };
      window.addEventListener("message", onMessage);
      try {
        window.postMessage({ __pceTag: RREQ, nonce, ...payload }, "*");
      } catch (e) {
        window.removeEventListener("message", onMessage);
        return resolve({ ok: false, reason: String((e && e.message) || e) });
      }
      setTimeout(() => {
        if (done) return;
        window.removeEventListener("message", onMessage);
        resolve({ ok: false, reason: "react bridge did not respond" });
      }, timeoutMs);
    });

  // Normalizing before comparison: React's copy of a name and the rendered text differ in whitespace and
  // HTML-entity decoding ("&amp;" vs "&"), neither of which means they are different workflows.
  const normalizeName = (s) =>
    (s || "")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  // Pairs each scraped row with the id React holds for it, positionally, then VERIFIES the names agree.
  // A mismatch means the array is not this table's data in this order, and a wrong id here would mean
  // rewriting and saving the wrong workflow — so the whole batch is refused rather than half-trusted.
  const attachIds = async (rows) => {
    if (!rows.length) return { rows, idsOk: false, reason: "no rows" };

    const res = await askReact({ action: "workflowIds" });
    if (!res.ok) return { rows, idsOk: false, reason: res.reason };
    if (res.rows.length !== rows.length) {
      return { rows, idsOk: false, reason: `React had ${res.rows.length} rows, DOM had ${rows.length}` };
    }

    const mismatches = [];
    const merged = rows.map((r, i) => {
      const fromReact = res.rows[i] || {};
      if (fromReact.name && normalizeName(fromReact.name) !== normalizeName(r.name)) {
        mismatches.push({ index: i, dom: r.name, react: fromReact.name });
      }
      return { ...r, id: fromReact.id || null };
    });

    if (mismatches.length) {
      return { rows, idsOk: false, reason: "React row order did not match the table", mismatches };
    }
    const missing = merged.filter((r) => !r.id).length;
    if (missing) return { rows: merged, idsOk: false, reason: `${missing} rows had no id` };

    return { rows: merged, idsOk: true };
  };

  const scrapeUsage = async (doc) => {
    const scraped = scrapeUsageRows(doc);
    const pagination = readPagination(doc);
    const { rows, idsOk, reason, mismatches } = await attachIds(scraped);
    return {
      rows,
      pagination,
      // Stated rather than implied: without verified ids this tab cannot fill a queue.
      hasIds: idsOk,
      idsReason: reason || null,
      mismatches: mismatches || null,
      coverage: pagination && pagination.totalRows
        ? { seenRows: rows.length, totalRows: pagination.totalRows, complete: rows.length >= pagination.totalRows }
        : null
    };
  };

  const isHistoryPage = () => /\/history\/task-history/.test(location.pathname + location.search);

  const scrapeHistory = (doc) => {
    const rows = scrapeRows(doc);
    const workflows = foldByWorkflow(rows);
    const folders = {};
    workflows.forEach((w) => {
      const key = w.folder || "(no folder)";
      folders[key] = (folders[key] || 0) + 1;
    });
    const pagination = readPagination(doc);
    return {
      rowCount: rows.length,
      workflows,
      folders,
      pagination,
      // A run log this size must never be paged silently: the caller is told exactly how much of it
      // this DOM represents so a partial inventory can't be mistaken for the whole account.
      coverage:
        pagination && pagination.totalRows
          ? { seenRows: rows.length, totalRows: pagination.totalRows, complete: rows.length >= pagination.totalRows }
          : null,
      url: location.href
    };
  };

  globalThis.__PCE_HISTORY = {
    scrapeHistory,
    scrapeRows,
    foldByWorkflow,
    readPagination,
    scrapeUsage,
    scrapeUsageRows,
    isUsageTab,
    nextPageButton,
    advancePage,
    setPageSize,
    isHistoryPage,
    parseRow
  };

  try {
    if (globalThis.__PCE_EXPORT_FOR_TESTS__) globalThis.__PCE_TEST_HISTORY__ = globalThis.__PCE_HISTORY;
  } catch (_) {}
})();

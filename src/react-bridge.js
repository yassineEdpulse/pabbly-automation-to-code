// Runs in the page's own JS realm (manifest `world: "MAIN"`) to read data React holds but never renders.
//
// The "Task Usage by Workflows" table lists every workflow once — the authoritative catalogue — but its
// name cell is a bare <span>, not the <a href="/workflow/mapping/{id}"> the run log uses. Clicking a row
// still navigates, so the id exists: it lives in the React props behind the row's onClick, not in the DOM.
// React attaches those under `__reactFiber$<hash>` / `__reactProps$<hash>` keys, which only the page's
// realm can see.
//
// The naive approach — walk up each row's fiber until something id-shaped turns up — is WRONG in a way
// that silently produces plausible garbage: an ancestor holds the data array for the WHOLE table, so
// every row resolves to the first row's id. Instead this finds that array once, and returns the id
// alongside the name React has for it, so the isolated world can verify each id against the text it
// scraped and refuse the batch on any mismatch. An id assigned to the wrong workflow would mean editing
// and saving the wrong automation.
(() => {
  const REQ = "PCE_REACT_REQ";
  const RES = "PCE_REACT_RES";

  // Pabbly's opaque ids are base64-ish and always end in `_pc`:
  // "IjU3NjUwNTY0MDYzNTA0MzM1MjZjNTUzZDUxM2Ei_pc". Distinctive enough to recognise a workflow id by
  // shape, which is what removes any dependence on React prop names.
  const ID_RE = /^[A-Za-z0-9+/=_-]{10,}_pc$/;

  const reply = (nonce, payload) => {
    try {
      window.postMessage({ __pceTag: RES, nonce, payload }, "*");
    } catch (_) {}
  };

  const keyStartingWith = (el, prefix) => {
    for (const k of Object.keys(el)) if (k.startsWith(prefix)) return k;
    return null;
  };

  const fiberOf = (el) => {
    const k =
      keyStartingWith(el, "__reactFiber$") || keyStartingWith(el, "__reactInternalInstance$");
    return k ? el[k] : null;
  };

  const idIn = (obj) => {
    if (!obj || typeof obj !== "object") return null;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "string" && ID_RE.test(v)) return v;
    }
    return null;
  };

  const nameIn = (obj) => {
    if (!obj || typeof obj !== "object") return null;
    // Prefer an explicit name-ish key; fall back to the longest plain string that is not an id.
    for (const k of Object.keys(obj)) {
      if (!/name|title|workflow/i.test(k)) continue;
      const v = obj[k];
      if (typeof v === "string" && v.trim() && !ID_RE.test(v)) return v.trim();
    }
    let best = null;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v !== "string" || ID_RE.test(v) || !v.trim()) continue;
      if (!best || v.length > best.length) best = v;
    }
    return best ? best.trim() : null;
  };

  // An array of row objects: length matches the rendered row count and every element carries an
  // id-shaped string. Requiring BOTH is what stops a random props array being mistaken for the data.
  const looksLikeRowData = (v, rowCount) =>
    Array.isArray(v) &&
    v.length === rowCount &&
    v.every((e) => e && typeof e === "object" && idIn(e));

  const findRowData = (startEl, rowCount, maxDepth = 25) => {
    let fiber = fiberOf(startEl);
    for (let i = 0; fiber && i < maxDepth; i++) {
      for (const bag of [fiber.memoizedProps, fiber.memoizedState]) {
        if (!bag || typeof bag !== "object") continue;
        for (const k of Object.keys(bag)) {
          if (looksLikeRowData(bag[k], rowCount)) return bag[k];
        }
        if (looksLikeRowData(bag, rowCount)) return bag;
      }
      fiber = fiber.return;
    }
    return null;
  };

  const workflowIds = (payload) => {
    const rowSelector = payload.rowSelector || "table.MuiTable-root tbody tr";
    const rows = [...document.querySelectorAll(rowSelector)];
    // Trailing spacer rows carry no cells; they are not data and must not skew the length match.
    const dataRows = rows.filter((r) => r.querySelector("td") && r.textContent.trim());
    if (!dataRows.length) return { ok: false, reason: "no data rows found" };

    const arr = findRowData(dataRows[0], dataRows.length);
    if (!arr) {
      return {
        ok: false,
        reason: `no React row array of length ${dataRows.length} found — Pabbly may have changed the table`
      };
    }

    return {
      ok: true,
      rows: arr.map((e) => ({ id: idIn(e), name: nameIn(e) })),
      count: arr.length
    };
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__pceTag !== REQ || !msg.nonce) return;
    try {
      if (msg.action === "workflowIds") return reply(msg.nonce, workflowIds(msg));
      if (msg.action === "probe") {
        const anyRow = document.querySelector("table.MuiTable-root tbody tr");
        return reply(msg.nonce, { ok: true, react: !!(anyRow && fiberOf(anyRow)) });
      }
      reply(msg.nonce, { ok: false, reason: `unknown action ${msg.action}` });
    } catch (e) {
      reply(msg.nonce, { ok: false, reason: String((e && e.message) || e) });
    }
  });
})();

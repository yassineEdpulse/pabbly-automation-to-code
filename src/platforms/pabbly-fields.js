// Which parts of a Pabbly step hold a user-set value, and how each one must be written.
//
// Loaded by the manifest as a content script after src/rewrite.js and before pabbly-content.js, in
// the same isolated-world scope; registers on __PCE_FIELDS.
//
// This exists as its own file because the read side and the write side must agree exactly. The
// extractor can afford to be greedy — a stray field in an export is noise. A rewrite pass cannot:
// every element listed here is one this extension is willing to modify and save on a live account,
// so the list is deliberately an allowlist of named elements rather than a sweep of the step's HTML.
//
// Two traps, both confirmed against real captures and pinned by the fixtures:
//
//   - A step carries mapping <select> dropdowns whose <option> text contains full URLs from the
//     trigger's sample payload — including the very host being searched for. They are not fields.
//   - A Code (Pabbly) step has a hidden `input.curr_api_url` with the literal value "method_url",
//     so the endpoint rule must require `textarea.curr_api_url`, not `.curr_api_url`.
(() => {
  const cleanText = (el) => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();

  // TinyMCE renders into an iframe and leaves the real textarea display:none. Writing .value on that
  // textarea alone is lost the moment the editor syncs, so the write has to go through the editor's
  // own API — which lives in the page's JS realm, not here. Detected by the iframe TinyMCE injects
  // alongside, named "<textarea-id>_ifr".
  const editorOf = (ta) => {
    if (!ta || !ta.id) return "textarea";
    const doc = ta.ownerDocument || document;
    if (doc.getElementById(`${ta.id}_ifr`)) return "tinymce";
    const wrap = ta.parentElement;
    if (wrap && wrap.querySelector(".tox-tinymce")) return "tinymce";
    return "textarea";
  };

  const ENDPOINT_LABEL = "API Endpoint URL";

  const labelFor = (ta) => {
    if (ta.classList && ta.classList.contains("curr_api_url")) return ENDPOINT_LABEL;

    const param = ta.closest(".api_mapping_curr_params_con");
    if (param) {
      const lbl = cleanText(param.querySelector(".map_data_label"));
      if (lbl) return lbl;
      const key = param.querySelector(".map_data_key");
      if (key && key.value) return key.value;
    }

    const endpoint = ta.closest(".api_app_action_endpoint_url");
    if (endpoint) return ENDPOINT_LABEL;

    if (ta.closest(".filter_mapping_row_div")) {
      const row = ta.closest(".filter_mapping_row_div");
      const src = cleanText(row.querySelector("textarea.source_map_data_key")) || null;
      return src ? `Filter condition: ${src}` : "Filter condition value";
    }

    const group = ta.closest(".form-group");
    const lbl = group && cleanText(group.querySelector("label"));
    return lbl || "(unnamed field)";
  };

  const isCodeBody = (ta) => ta.getAttribute("data-enable_code_render") === "1";

  // The value as Pabbly stores it. `.value` on a textarea whose markup was HTML-escaped in the
  // server response comes back unescaped, which is exactly the string the rule has to run against.
  const readTextarea = (ta) => (ta.value != null ? ta.value : ta.textContent || "");

  const textareaFields = (root) =>
    [...root.querySelectorAll("textarea.map_data_value")]
      .filter((ta) => !ta.closest(".api_response_con"))
      .map((ta) => ({
        field: labelFor(ta),
        value: readTextarea(ta),
        elementId: ta.id || null,
        editor: editorOf(ta),
        code: isCodeBody(ta),
        el: ta
      }));

  const headerFields = (root) =>
    [...root.querySelectorAll(".api_header_div .header_data")]
      .map((row) => {
        const key = row.querySelector(".curr_header_key");
        const val = row.querySelector(".curr_header_value");
        if (!val) return null;
        const name = key && key.value ? `Header: ${key.value}` : "Header";
        return {
          field: name,
          value: val.value != null ? val.value : "",
          elementId: val.id || null,
          editor: "input",
          code: false,
          el: val
        };
      })
      .filter(Boolean);

  const collectFields = (root) => [...textareaFields(root), ...headerFields(root)];

  const stepIdentity = (root) => {
    const header = root.querySelector(".curr_app_name");
    const idxEl = root.querySelector(".gbl_module_index");
    const indexLabel = (cleanText(idxEl).match(/\d+(?:\.\d+)*/) || [null])[0];
    return {
      stepId: root.getAttribute("data_curr_api_index") || null,
      indexLabel,
      app: cleanText(root.querySelector(".choose_app_name_ele")) || null,
      title: header ? cleanText(header).replace(/^[\d.]+\s*/, "") : null
    };
  };

  // Read-only. Produces one entry per field that actually contains a match, carrying the exact
  // before/after strings so the report can be reviewed — and, on the apply pass, so the writer can
  // verify the field still holds `before` before it touches anything.
  const scanStep = (root, rule) => {
    const rewrite = globalThis.__PCE_REWRITE;
    if (!rewrite) return { ...stepIdentity(root), fields: [], error: "rewrite engine not loaded" };

    const fields = [];
    for (const f of collectFields(root)) {
      const res = rewrite.applyToValue(f.value, rule);
      if (!res.hits.length && !res.blocked.length) continue;
      fields.push({
        field: f.field,
        editor: f.editor,
        elementId: f.elementId,
        code: f.code,
        count: res.hits.length,
        before: f.value,
        after: res.value,
        contexts: res.hits.map((h) => h.context),
        blocked: res.blocked.length
      });
    }
    return { ...stepIdentity(root), fields };
  };

  // --- Writing ------------------------------------------------------------------------------------
  // A TinyMCE-backed field cannot be written from this world: `tinymce` lives in the page's realm.
  // src/tinymce-bridge.js runs there and answers over postMessage; this is the client half. Every
  // request carries a nonce so a reply can never be attributed to the wrong request, and a timeout so
  // a missing bridge (e.g. the page never loaded TinyMCE) fails loudly instead of hanging a bulk run.
  const REQ = "PCE_TINYMCE_REQ";
  const RES = "PCE_TINYMCE_RES";
  let nonceSeq = 0;

  const nextNonce = () => {
    nonceSeq += 1;
    return `pce_${Date.now()}_${nonceSeq}`;
  };

  const askBridge = (payload, timeoutMs = 8000) =>
    new Promise((resolve) => {
      const nonce = nextNonce();
      let done = false;

      const onMessage = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.__pceTag !== RES || d.nonce !== nonce) return;
        done = true;
        window.removeEventListener("message", onMessage);
        resolve(d.payload || { ok: false, reason: "empty bridge reply" });
      };

      window.addEventListener("message", onMessage);
      try {
        window.postMessage({ __pceTag: REQ, nonce, ...payload }, "*");
      } catch (e) {
        window.removeEventListener("message", onMessage);
        return resolve({ ok: false, reason: String((e && e.message) || e) });
      }

      setTimeout(() => {
        if (done) return;
        window.removeEventListener("message", onMessage);
        resolve({ ok: false, reason: "tinymce bridge did not respond — is src/tinymce-bridge.js loaded?" });
      }, timeoutMs);
    });

  const bridgeAvailable = () => askBridge({ action: "probe" }, 3000);

  // `expect` is the value the scan recorded. The bridge refuses the write if the field no longer holds
  // it, which is what makes applying a stale report safe: the page having changed produces a skip.
  const writeField = async (descriptor, newValue, expect, marker) => {
    if (!descriptor) return { ok: false, reason: "no field descriptor" };

    if (descriptor.editor === "input") {
      const el = descriptor.el;
      if (!el) return { ok: false, reason: "input element gone" };
      if (expect != null && el.value !== expect) {
        return { ok: false, reason: "field changed since scan", skipped: true };
      }
      el.value = newValue;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, via: "input", verified: el.value === newValue };
    }

    if (!descriptor.elementId) {
      return { ok: false, reason: "field has no id — cannot reach it through the bridge" };
    }

    return askBridge({
      action: "write",
      id: descriptor.elementId,
      value: newValue,
      expect: expect != null ? expect : null,
      marker: marker || null
    });
  };

  const readField = async (descriptor) => {
    if (!descriptor) return { ok: false, reason: "no field descriptor" };
    if (descriptor.editor === "input") {
      return { ok: true, value: descriptor.el ? descriptor.el.value : null };
    }
    if (!descriptor.elementId) return { ok: false, reason: "field has no id" };
    return askBridge({ action: "read", id: descriptor.elementId });
  };

  const saveButton = (root) =>
    root.querySelector("button.save_curr_step") ||
    [...root.querySelectorAll("button")].find((b) =>
      /save_only_curr_api_data/.test(b.getAttribute("onclick") || "")
    ) ||
    null;

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // Pabbly's per-step Save toggles `d-none` on the button's .spinner-clicked span while the POST is in
  // flight. Waiting for that spinner to appear and clear is a real completion signal; a fixed sleep is
  // not, and getting it wrong on a 100-workflow run means saving the next step over an unfinished one.
  const clickSaveAndWait = async (root, timeoutMs = 20000) => {
    const btn = saveButton(root);
    if (!btn) return { ok: false, reason: "no Save button on this step" };
    const spinner = btn.querySelector(".spinner-clicked");
    const spinning = () => spinner && !spinner.classList.contains("d-none");

    btn.scrollIntoView({ block: "center" });
    await delay(150);
    btn.click();

    const deadline = Date.now() + timeoutMs;
    let sawSpin = false;
    while (Date.now() < deadline) {
      if (spinning()) sawSpin = true;
      else if (sawSpin) return { ok: true, observed: "spinner cleared" };
      await delay(150);
    }
    // A save can complete faster than the poll interval, so never having seen the spinner is not proof
    // of failure — it is reported as unconfirmed and the caller verifies by re-reading the field.
    return sawSpin
      ? { ok: false, reason: "save still spinning after timeout" }
      : { ok: true, observed: "spinner never seen — verify by re-read" };
  };

  globalThis.__PCE_FIELDS = {
    collectFields,
    scanStep,
    stepIdentity,
    saveButton,
    clickSaveAndWait,
    writeField,
    readField,
    bridgeAvailable,
    editorOf,
    labelFor
  };

  try {
    if (globalThis.__PCE_EXPORT_FOR_TESTS__) globalThis.__PCE_TEST_FIELDS__ = globalThis.__PCE_FIELDS;
  } catch (_) {}
})();

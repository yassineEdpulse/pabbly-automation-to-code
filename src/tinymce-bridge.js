// Runs in the page's own JS realm (manifest `world: "MAIN"`) so it can reach `window.tinymce`.
//
// Every editable value in a Pabbly step lives in a textarea that TinyMCE has taken over: the textarea
// is left `display:none` and the live content sits in TinyMCE's iframe. Assigning `.value` on that
// hidden textarea from the extension's isolated world appears to work and then loses the edit, because
// the editor's own model still holds the old content and overwrites it on the next sync. So a write
// has to go through `tinymce.get(id)` — and `tinymce` only exists here.
//
// The isolated-world side talks to this over window.postMessage, mirroring how src/interceptor.js
// reports captures. Requests carry a nonce so a reply can never be mistaken for another request's.
//
// This file only ever writes a value it was handed together with the exact `expect` string currently
// in the field. If the field no longer holds `expect`, the write is refused. That is what makes a
// stale scan report safe to apply: the page having changed under it produces a skip, not a clobber.
(() => {
  const REQ = "PCE_TINYMCE_REQ";
  const RES = "PCE_TINYMCE_RES";

  const reply = (nonce, payload) => {
    try {
      window.postMessage({ __pceTag: RES, nonce, payload }, "*");
    } catch (_) {}
  };

  const editorFor = (id) => {
    const tiny = window.tinymce;
    if (!tiny) return null;
    try {
      return (tiny.get && tiny.get(id)) || null;
    } catch (_) {
      return null;
    }
  };

  // The hidden textarea is the source of truth, NOT editor.getContent(). Pabbly keeps the real value
  // there — the editor container is `visibility: hidden` — and save_only_curr_api_data() serializes the
  // textarea. TinyMCE's model is a rendering of it that may be empty or normalized, so:
  //
  //   - the staleness guard compares the TEXTAREA (comparing it against the editor rejected every field
  //     with "field changed since scan" and nothing was ever written), and
  //   - verification reads the TEXTAREA back, since that is what will actually be posted.
  //
  // The editor is still updated when present, because a later editor.save() would otherwise push its
  // stale content over the top of the change.
  const writeValue = (id, value, expect, marker) => {
    const ta = document.getElementById(id);
    if (!ta) return { ok: false, reason: "textarea not found" };

    const before = ta.value || "";
    if (expect != null && before !== expect) {
      return { ok: false, reason: "field changed since scan", skipped: true, before };
    }

    const editor = editorFor(id);
    let via = "textarea";

    if (editor) {
      try {
        editor.setContent(value, { format: "raw" });
        editor.save();
        editor.fire("change");
        via = "tinymce";
      } catch (_) {
        // Fall through to the direct write rather than failing: the textarea is what gets posted.
      }
    }

    // Whether or not the editor cooperated, the textarea must end up holding the new value. If the
    // editor's own save wrote something else (or nothing), overwrite it directly.
    const marked = (v) => (marker ? String(v).includes(marker) : v === value);
    if (!marked(ta.value || "")) {
      ta.value = value;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
      via = editor ? "tinymce+textarea" : "textarea";
    }

    const after = ta.value || "";
    return { ok: true, via, verified: marked(after), after };
  };

  const readValue = (id) => {
    const ta = document.getElementById(id);
    if (!ta) return { ok: false, reason: "textarea not found" };
    const editor = editorFor(id);
    let editorValue = null;
    if (editor) {
      try {
        editorValue = editor.getContent({ format: "raw" });
      } catch (_) {}
    }
    // `value` is deliberately the textarea's: it is what the scan read and what the save will post.
    // `editorValue` is returned only so a mismatch is visible in diagnostics.
    return { ok: true, value: ta.value || "", editorValue, hasEditor: !!editor };
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__pceTag !== REQ || !msg.nonce) return;

    const { action, id, value, expect, marker } = msg;
    try {
      if (action === "write") return reply(msg.nonce, writeValue(id, value, expect, marker));
      if (action === "read") return reply(msg.nonce, readValue(id));
      if (action === "probe") return reply(msg.nonce, { ok: true, tinymce: !!window.tinymce });
      reply(msg.nonce, { ok: false, reason: `unknown action ${action}` });
    } catch (e) {
      reply(msg.nonce, { ok: false, reason: String((e && e.message) || e) });
    }
  });
})();

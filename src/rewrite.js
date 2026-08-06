// Find-and-replace over a single Pabbly field value.
//
// Loaded by the manifest as a content script (NOT an ES module) before the platform adapters, in the
// same isolated-world scope, and registers itself on __PCE_REWRITE. Everything here is pure: it
// takes a string and returns a new string plus a description of what it did. Nothing touches the DOM
// — the adapter owns that — which is what makes the whole rule testable against saved fixtures.
//
// Every editable Pabbly value is HTML, including Code (Pabbly) step bodies. Plain text is
// interleaved with `<span class="dynamic_value" data-attr="…">` chips that encode a step reference,
// and a code body additionally stores its newlines as `<br>` and
// `<span class="pabbly-connect-linebreak">`. A naive String.replace over the whole value can land
// inside a tag; a mangled `data-attr` silently unbinds the mapping and the step starts sending an
// empty value to the API. Tag interiors are therefore skipped outright, and a match found only
// inside one is reported, never rewritten.
//
// A JavaScript body's own `<` and `>` (`if (a < b)`) arrive escaped as `&lt;`/`&gt;`, so every
// unescaped `<…>` run in a stored value really is markup — which is what makes tag-skipping safe
// for code and not just for mapping fields.
(() => {
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // A tag is `<`, then any mix of quoted strings and non-`>` characters, then `>`. The quoted-string
  // alternation is not decoration: Pabbly's chips carry field paths like
  // data-attr="0<=-+*/@/*+-=>email", whose value contains a literal `>`. A plain /<[^>]*>/ stops at that
  // inner `>` and reports the rest of the attribute as ordinary text — which would allow a rewrite
  // INSIDE a data-attr, the one edit that silently unbinds a mapping.
  const TAG = /<[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;
  const CONTEXT = 40;

  // A hostname only matches on a label boundary. Without this, a rule for
  // "secure.tutorcruncher.com" also fires inside "notsecure.tutorcruncher.com" and
  // "eu.secure.tutorcruncher.com" — different hosts that must be left alone.
  const LEFT_LABEL = /[A-Za-z0-9._-]/;
  const RIGHT_LABEL = /[A-Za-z0-9-]/;

  const onLabelBoundary = (text, start, end) => {
    const before = start > 0 ? text[start - 1] : "";
    const after = end < text.length ? text[end] : "";
    if (before && LEFT_LABEL.test(before)) return false;
    if (after && RIGHT_LABEL.test(after)) return false;
    return true;
  };

  const contextAround = (text, start, end) =>
    (start > CONTEXT ? "…" : "") +
    text.slice(Math.max(0, start - CONTEXT), Math.min(text.length, end + CONTEXT)) +
    (end + CONTEXT < text.length ? "…" : "");

  // Hostnames are case-insensitive, so the search is too; the replacement is written verbatim, which
  // also normalizes a stray "SECURE.TutorCruncher.com" on the way past.
  const scanText = (text, rule) => {
    if (typeof text !== "string" || !text || !rule || !rule.find) return [];
    const re = new RegExp(escapeRe(rule.find), "gi");
    const boundary = rule.hostBoundary !== false;
    const found = [];
    let m;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (boundary && !onLabelBoundary(text, start, end)) continue;
      found.push({ start, end, matched: m[0], context: contextAround(text, start, end) });
      if (m[0].length === 0) re.lastIndex += 1;
    }
    return found;
  };

  const applyToText = (text, rule) => {
    const hits = scanText(text, rule);
    if (!hits.length) return { text, hits };
    let out = "";
    let cursor = 0;
    for (const h of hits) {
      out += text.slice(cursor, h.start) + rule.replace;
      cursor = h.end;
    }
    return { text: out + text.slice(cursor), hits };
  };

  // Splits the value into tag / not-tag runs and only rewrites the not-tag runs. `blocked` counts
  // matches that live inside a tag: those are surfaced to the report so a hit is never silently
  // dropped, but they are never written.
  const applyToHtmlValue = (value, rule) => {
    if (typeof value !== "string" || !value) return { value, hits: [], blocked: [] };

    const hits = [];
    const blocked = [];
    let out = "";
    let cursor = 0;
    let m;

    TAG.lastIndex = 0;
    const pushSegment = (segment, offset, isTag) => {
      if (isTag) {
        for (const h of scanText(segment, rule)) {
          blocked.push({ ...h, start: offset + h.start, end: offset + h.end, insideTag: true });
        }
        out += segment;
        return;
      }
      const res = applyToText(segment, rule);
      for (const h of res.hits) hits.push({ ...h, start: offset + h.start, end: offset + h.end });
      out += res.text;
    };

    while ((m = TAG.exec(value))) {
      pushSegment(value.slice(cursor, m.index), cursor, false);
      pushSegment(m[0], m.index, true);
      cursor = m.index + m[0].length;
    }
    pushSegment(value.slice(cursor), cursor, false);

    return { value: out, hits, blocked };
  };

  const RULES = {
    tutorcruncherHost: {
      id: "tutorcruncherHost",
      label: "TutorCruncher API host: secure → app",
      find: "secure.tutorcruncher.com",
      replace: "app.tutorcruncher.com",
      hostBoundary: true
    }
  };

  globalThis.__PCE_REWRITE = { applyToValue: applyToHtmlValue, applyToHtmlValue, applyToText, scanText, RULES };

  try {
    if (globalThis.__PCE_EXPORT_FOR_TESTS__) globalThis.__PCE_TEST_REWRITE__ = globalThis.__PCE_REWRITE;
  } catch (_) {}
})();

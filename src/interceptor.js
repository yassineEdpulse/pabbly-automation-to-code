// Runs in the page's own JS realm (manifest `world: "MAIN"`) so it can replace window.fetch and
// XMLHttpRequest before the app's bundle loads. Manifest-injected MAIN-world scripts are exempt
// from the page's Content-Security-Policy — which matters on Zapier, whose CSP is nonce-based and
// would block a manually appended <script>.
(() => {
  const TAG = "PCE_CAPTURE";
  const MAX_BODY = 2_000_000;
  const MAX_REQ_BODY = 20_000;

  const send = (payload) => {
    try {
      window.postMessage({ __pceTag: TAG, payload }, "*");
    } catch (_) {}
  };

  // Same-site only. Third-party requests (analytics, ad pixels, session replay) are passed through
  // untouched so we never appear in their stack traces or add a promise link to their failures.
  const labels = location.hostname.split(".");
  const BASE = labels.slice(-2).join(".");

  const looksRelevant = (url) => {
    if (!url) return false;
    if (url.startsWith("/")) return true;
    let u;
    try {
      u = new URL(url, location.href);
    } catch (_) {
      return false;
    }
    return u.hostname === location.hostname || u.hostname === BASE || u.hostname.endsWith(`.${BASE}`);
  };

  const parseMaybeJson = (text) => {
    if (typeof text !== "string") return text;
    if (text.length > MAX_BODY) return { __truncated: true, length: text.length };
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return text;
    }
  };

  // A GraphQL endpoint answers every query from one URL, so the response alone cannot be attributed
  // to anything. Keeping a trimmed copy of the request body is what makes those captures usable.
  const readReqBody = (body) => {
    if (typeof body !== "string") return undefined;
    return body.length > MAX_REQ_BODY ? `${body.slice(0, MAX_REQ_BODY)}…[truncated]` : body;
  };

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (...args) {
      const request = args[0];
      const url = typeof request === "string" ? request : request && request.url;
      const method = (args[1] && args[1].method) || (request && request.method) || "GET";
      if (!looksRelevant(url)) return originalFetch.apply(this, args);
      const reqBody = readReqBody(args[1] && args[1].body);
      return originalFetch.apply(this, args).then((response) => {
        response
          .clone()
          .text()
          .then((text) => {
            send({
              source: "fetch",
              url,
              method,
              status: response.status,
              ...(reqBody ? { reqBody } : {}),
              body: parseMaybeJson(text),
              at: new Date().toISOString()
            });
          })
          .catch(() => {});
        return response;
      });
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send_ = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      this.__pceMeta = { method, url };
      return open.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (...args) {
      const reqBody = readReqBody(args[0]);
      this.addEventListener("load", () => {
        const meta = this.__pceMeta || {};
        if (!looksRelevant(meta.url)) return;
        let body = "";
        try {
          body =
            this.responseType === "" || this.responseType === "text"
              ? this.responseText
              : this.response;
        } catch (_) {}
        send({
          source: "xhr",
          url: meta.url,
          method: meta.method,
          status: this.status,
          ...(reqBody ? { reqBody } : {}),
          body: parseMaybeJson(body),
          at: new Date().toISOString()
        });
      });
      return send_.apply(this, args);
    };
  }
})();

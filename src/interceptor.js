(() => {
  const TAG = "PABBLY_CAPTURE";
  const MAX_BODY = 2_000_000;

  const send = (payload) => {
    try {
      window.postMessage({ __pabblyTag: TAG, payload }, "*");
    } catch (_) {}
  };

  const looksRelevant = (url) => {
    if (!url) return false;
    return /pabbly\.com/.test(url) || /\/api\//.test(url) || url.startsWith("/");
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

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (...args) {
      const request = args[0];
      const url = typeof request === "string" ? request : request && request.url;
      const method =
        (args[1] && args[1].method) ||
        (request && request.method) ||
        "GET";
      return originalFetch.apply(this, args).then((response) => {
        if (looksRelevant(url)) {
          response
            .clone()
            .text()
            .then((text) => {
              send({
                source: "fetch",
                url,
                method,
                status: response.status,
                body: parseMaybeJson(text),
                at: new Date().toISOString()
              });
            })
            .catch(() => {});
        }
        return response;
      });
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send_ = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      this.__pabblyMeta = { method, url };
      return open.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (...args) {
      this.addEventListener("load", () => {
        const meta = this.__pabblyMeta || {};
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
          body: parseMaybeJson(body),
          at: new Date().toISOString()
        });
      });
      return send_.apply(this, args);
    };
  }
})();

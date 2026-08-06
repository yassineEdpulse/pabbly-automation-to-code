// Shared content-script shell. Platform-agnostic.
//
// The manifest loads exactly one platform adapter (src/platforms/<platform>-content.js) immediately
// before this file, in the same isolated-world scope. The adapter registers itself on
// __PCE_ADAPTER; everything below just bridges the page to the extension and routes messages to it.
//
// Manifest-declared content scripts are not ES modules, so this cannot `import` the adapter — the
// shared global is the seam. Load order is not relied on for the capture buffer: whichever file
// runs first creates it.
(() => {
  const TAG = "PCE_CAPTURE";
  const CONTENT_VERSION = "0.13.0";

  const localCaptures = (globalThis.__PCE_CAPTURES = globalThis.__PCE_CAPTURES || []);
  let lastResult = null;

  const adapter = () => globalThis.__PCE_ADAPTER || null;

  const LOG = (...a) => {
    try {
      console.log("%c[PCE]", "color:#5b8cff;font-weight:bold", ...a);
    } catch (_) {}
  };
  const ERR = (...a) => {
    try {
      console.error("%c[PCE ERROR]", "color:#ff5b5b;font-weight:bold", ...a);
    } catch (_) {}
  };

  // Capped for the same reason the service worker's copy is: a scan of an 80-step workflow pulls one
  // large step-config payload per click, and an uncapped array holds every one of them for the life of
  // the page. Only recent captures are ever read (parseCaptures matches them to steps just clicked), so
  // dropping the oldest costs nothing.
  const MAX_LOCAL_CAPTURES = 400;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__pceTag !== TAG) return;
    localCaptures.push(data.payload);
    if (localCaptures.length > MAX_LOCAL_CAPTURES) {
      localCaptures.splice(0, localCaptures.length - MAX_LOCAL_CAPTURES);
    }
    try {
      chrome.runtime.sendMessage({ type: "capture", payload: data.payload });
    } catch (_) {}
  });

  const nameOf = () => {
    const a = adapter();
    try {
      return a && a.currentName ? a.currentName() : document.title || null;
    } catch (_) {
      return document.title || null;
    }
  };

  // Every async handler funnels through here so an adapter throwing can never leave the side panel
  // (or, worse, a 60-workflow bulk run) waiting on a response that will never arrive.
  const respond = (promise, sendResponse, label) => {
    Promise.resolve(promise)
      .then((res) => sendResponse(res))
      .catch((e) => {
        ERR(`${label} failed:`, e);
        sendResponse({ error: String((e && e.message) || e) });
      });
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    const a = adapter();

    if (msg.type === "ping") {
      sendResponse({
        ready: true,
        version: CONTENT_VERSION,
        platform: a ? a.id : null,
        url: location.href,
        name: nameOf()
      });
      return true;
    }

    if (!a) {
      sendResponse({ error: "no platform adapter loaded on this page" });
      return true;
    }

    if (msg.type === "scrapeDom") {
      respond(a.scrapeDom(), sendResponse, "scrapeDom");
      return true;
    }

    if (msg.type === "getLastResult") {
      sendResponse(lastResult);
      return true;
    }

    if (msg.type === "diagnostics") {
      respond(
        Promise.resolve(a.diagnostics ? a.diagnostics() : {}).then((d) => ({
          ...d,
          platform: a.id,
          url: location.href,
          contentVersion: CONTENT_VERSION,
          capturedUrls: localCaptures.slice(-80).map((c) => ({
            url: c.url,
            method: c.method,
            status: c.status,
            kind: c && c.body && typeof c.body === "object" ? "json" : "text",
            keys: c && c.body && typeof c.body === "object" && !Array.isArray(c.body) ? Object.keys(c.body).slice(0, 12) : undefined
          }))
        })),
        sendResponse,
        "diagnostics"
      );
      return true;
    }

    // Prepares a bulk run: lets an adapter decide whether it can capture every item in place
    // (fetching each from the site's own API) or whether the crawler must navigate to each one.
    if (msg.type === "prepareBulk") {
      if (!a.prepareBulk) {
        sendResponse({ direct: false, reason: "adapter has no in-place capture" });
        return true;
      }
      respond(a.prepareBulk(msg), sendResponse, "prepareBulk");
      return true;
    }

    // In-place capture of a single item by id, without navigating the tab to it.
    if (msg.type === "captureById") {
      if (!a.captureById) {
        sendResponse({ needsNavigation: true });
        return true;
      }
      respond(a.captureById(msg.id, msg), sendResponse, "captureById");
      return true;
    }

    // Scan (apply:false) and apply (apply:true) share one handler so the two passes can never drift
    // apart in which steps or fields they consider.
    if (msg.type === "rewriteWorkflow") {
      if (!a.rewriteWorkflow) {
        sendResponse({ error: "adapter has no rewrite pass" });
        return true;
      }
      respond(a.rewriteWorkflow(msg), sendResponse, "rewriteWorkflow");
      return true;
    }

    if (msg.type === "scrapeHistory") {
      respond(Promise.resolve(a.scrapeHistory ? a.scrapeHistory() : null), sendResponse, "scrapeHistory");
      return true;
    }

    if (msg.type === "fetchCatalogue") {
      respond(
        Promise.resolve(a.fetchCatalogue ? a.fetchCatalogue() : { workflows: [], errors: [{ error: "no api" }] }),
        sendResponse,
        "fetchCatalogue"
      );
      return true;
    }

    if (msg.type === "scrapeUsage") {
      respond(Promise.resolve(a.scrapeUsage ? a.scrapeUsage() : null), sendResponse, "scrapeUsage");
      return true;
    }

    if (msg.type === "advanceHistoryPage") {
      respond(
        Promise.resolve(a.advanceHistoryPage ? a.advanceHistoryPage(msg) : { advanced: false }),
        sendResponse,
        "advanceHistoryPage"
      );
      return true;
    }

    if (msg.type === "setHistoryPageSize") {
      respond(
        Promise.resolve(a.setHistoryPageSize ? a.setHistoryPageSize(msg) : { changed: false }),
        sendResponse,
        "setHistoryPageSize"
      );
      return true;
    }

    if (msg.type === "expandAndParse") {
      respond(
        Promise.resolve(a.expandAndParse(msg)).then((res) => {
          lastResult = res;
          LOG("expandAndParse complete — result stored (retrievable via getLastResult)");
          return res;
        }),
        sendResponse,
        "expandAndParse"
      );
      return true;
    }

    return true;
  });

  try {
    if (globalThis.__PCE_EXPORT_FOR_TESTS__ && globalThis.__PCE_TEST__) {
      globalThis.__PCE_TEST__.CONTENT_VERSION = CONTENT_VERSION;
    }
  } catch (_) {}
})();

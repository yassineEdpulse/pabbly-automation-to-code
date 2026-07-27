// Single source of truth for everything platform-specific that lives OUTSIDE the page.
//
// Content scripts cannot import this: manifest-declared content scripts are not ES modules. They
// are gated by the manifest's `matches` instead, so `hostRe` here and `matches` in manifest.json
// must be kept in step. Only background.js and popup.js (both real modules) import this file.

const PABBLY = {
  id: "pabbly",
  label: "Pabbly",
  productName: "Pabbly Connect",
  hostRe: /(^|\.)pabbly\.com$/i,
  fileSlug: "pabbly",
  host: "connect.pabbly.com",
  terms: { unit: "workflow", unitPlural: "workflows", Unit: "Workflow", UnitPlural: "Workflows" },
  editorUrl: (id) => `https://connect.pabbly.com/workflow/mapping/${id}`,
  loggedOutRe: /\/(login|signin|sign-in|auth)\b/i,
  // Pabbly has no usable API: every step must be clicked open and scraped, one page load per
  // workflow. The pacing below is what a 1000+ workflow account survives without being throttled.
  directCapture: false,
  bulk: { stepDelay: 1200, throttleMs: 1500, settleMs: 1500, perWorkflowMs: 240000, batchSize: 50 },
  icons: {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png"
  }
};

const ZAPIER = {
  id: "zapier",
  label: "Zapier",
  productName: "Zapier",
  hostRe: /(^|\.)zapier\.com$/i,
  fileSlug: "zapier",
  host: "zapier.com",
  terms: { unit: "Zap", unitPlural: "Zaps", Unit: "Zap", UnitPlural: "Zaps" },
  editorUrl: (id) => `https://zapier.com/editor/${id}`,
  listUrl: "https://zapier.com/app/assets/zaps",
  loggedOutRe: /\/(login|sign-?in|auth|logout)\b/i,
  // Zapier serves the whole Zap as JSON, so a run fetches each Zap in place instead of navigating
  // the tab to it. Only used when the adapter reports it learned a usable endpoint (see
  // `prepareBulk`); otherwise the run falls back to the Pabbly-style navigate-and-parse loop.
  directCapture: true,
  bulk: { stepDelay: 0, throttleMs: 350, settleMs: 600, perWorkflowMs: 60000, batchSize: 200 },
  icons: {
    16: "icons/zapier/icon16.png",
    32: "icons/zapier/icon32.png",
    48: "icons/zapier/icon48.png",
    128: "icons/zapier/icon128.png"
  }
};

export const PLATFORMS = { pabbly: PABBLY, zapier: ZAPIER };

export const NEUTRAL = {
  id: null,
  label: "Automation",
  productName: "an automation platform",
  fileSlug: "automation",
  terms: { unit: "workflow", unitPlural: "workflows", Unit: "Workflow", UnitPlural: "Workflows" },
  directCapture: false,
  bulk: PABBLY.bulk,
  icons: PABBLY.icons
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return "";
  }
};

export const detectPlatform = (url) => {
  const host = hostOf(url);
  if (!host) return null;
  return Object.values(PLATFORMS).find((p) => p.hostRe.test(host)) || null;
};

export const platformById = (id) => PLATFORMS[id] || null;

export const platformOrNeutral = (url) => detectPlatform(url) || NEUTRAL;

// `zapier-zaps.json`, `pabbly-workflows.json`, …
export const exportName = (platform, suffix, ext) =>
  `${(platform || NEUTRAL).fileSlug}-${suffix}.${ext}`;

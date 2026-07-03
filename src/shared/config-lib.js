// Pure logic for the remote-config system (docs/update-resilience-design.md).
// Loaded by the background script in both browsers (importScripts on Chrome,
// manifest "scripts" array on Firefox) and by node:test via module.exports.
// No browser APIs in this file - keep it testable in node.

(function () {
  const KNOWN_FEATURES = [
    "bbref", "statcastIcon", "statcastPanel", "video",
    "liveGame", "fangraphsPanel", "prospectSavantPanel",
  ];
  const STATUS_LEVELS = ["ok", "degraded", "broken"];
  const STORE_KEYS = ["chrome", "firefox", "edge"];
  const MESSAGE_MAX = 500;
  const VERSION_RE = /^\d+(\.\d+){0,3}$/;

  function compareVersions(a, b) {
    const pa = String(a).split(".").map(Number);
    const pb = String(b).split(".").map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  function browserKeyFrom(hasGetBrowserInfo, brands) {
    if (hasGetBrowserInfo) return "firefox";
    if ((brands || []).some((b) => /\bEdge\b/i.test(b?.brand || ""))) return "edge";
    return "chrome";
  }

  function validateConfig(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw._staging === true) return null;
    if (raw.schemaVersion !== 1) return null;

    const s = raw.status && typeof raw.status === "object" ? raw.status : {};
    const status = {
      level: STATUS_LEVELS.includes(s.level) ? s.level : "ok",
      message: typeof s.message === "string" ? s.message.slice(0, MESSAGE_MAX) : "",
      maxAffectedVersion: cleanVersion(s.maxAffectedVersion),
      fixedInVersion: cleanVersion(s.fixedInVersion),
    };

    const killSwitches = {};
    if (raw.killSwitches && typeof raw.killSwitches === "object") {
      for (const key of KNOWN_FEATURES) {
        if (raw.killSwitches[key] === true) killSwitches[key] = true;
      }
    }

    const latestVersion = {};
    if (raw.latestVersion && typeof raw.latestVersion === "object") {
      for (const key of STORE_KEYS) {
        const v = cleanVersion(raw.latestVersion[key]);
        if (v) latestVersion[key] = v;
      }
    }

    // Phase 1: the selectors key exists in the schema but is not yet consumed.
    return { schemaVersion: 1, status, killSwitches, latestVersion, selectors: {} };
  }

  function cleanVersion(v) {
    return typeof v === "string" && VERSION_RE.test(v) ? v : "";
  }

  function configTtlMs(config) {
    return config?.status?.level === "ok" ? 6 * 60 * 60 * 1000 : 15 * 60 * 1000;
  }

  function pickLatest(config, browserKey) {
    return config?.latestVersion?.[browserKey] || null;
  }

  function statusApplies(config, currentVersion) {
    const s = config?.status;
    if (!s || s.level === "ok") return false;
    if (!s.maxAffectedVersion) return true;
    return compareVersions(currentVersion, s.maxAffectedVersion) <= 0;
  }

  const lib = {
    KNOWN_FEATURES,
    compareVersions,
    browserKeyFrom,
    validateConfig,
    configTtlMs,
    pickLatest,
    statusApplies,
  };
  globalThis.OCFConfigLib = lib;
  if (typeof module !== "undefined" && module.exports) module.exports = lib;
})();

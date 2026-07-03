const browser = globalThis.browser || globalThis.chrome;

// Chrome MV3 service worker: load shared config logic synchronously.
// Firefox's event page loads it via the manifest "scripts" array instead
// (importScripts does not exist there, hence the guard).
if (typeof importScripts === "function") {
  importScripts("config-lib.js");
}

const BASE_ORIGINS = ["*://*.fantrax.com/*"];
const FEATURE_ORIGINS = {
  bbref: ["https://statsapi.mlb.com/*"],
  statcastIcon: ["https://statsapi.mlb.com/*"],
  statcastPanel: ["https://statsapi.mlb.com/*", "https://baseballsavant.mlb.com/*"],
  video: [
    "https://statsapi.mlb.com/*",
    "https://fastball-gateway.mlb.com/*",
    "https://fastball-clips.mlb.com/*",
  ],
  liveGame: ["https://statsapi.mlb.com/*"],
  fangraphsPanel: ["https://statsapi.mlb.com/*", "https://www.fangraphs.com/*"],
  prospectSavantPanel: ["https://statsapi.mlb.com/*", "https://oriolebird.pythonanywhere.com/*"],
};
const FEATURE_DEFAULTS = {
  bbref: true,
  statcastIcon: true,
  statcastPanel: true,
  video: true,
  liveGame: true,
  fangraphsPanel: true,
  prospectSavantPanel: true,
};

function getRequiredOrigins(features) {
  const set = new Set(BASE_ORIGINS);
  for (const [feature, origins] of Object.entries(FEATURE_ORIGINS)) {
    if (features[feature]) origins.forEach((o) => set.add(o));
  }
  return [...set];
}

async function getEnabledFeatures() {
  try {
    return await browser.storage.sync.get(FEATURE_DEFAULTS);
  } catch {
    return { ...FEATURE_DEFAULTS };
  }
}

async function refreshActionBadge() {
  try {
    const features = await getEnabledFeatures();
    const origins = getRequiredOrigins(features);
    const granted = await browser.permissions.contains({ origins });
    const text = granted ? "" : "!";
    if (browser.action?.setBadgeText) {
      await browser.action.setBadgeText({ text });
    }
    if (!granted && browser.action?.setBadgeBackgroundColor) {
      await browser.action.setBadgeBackgroundColor({ color: "#e53935" });
    }
  } catch (e) {
    // best-effort; ignore
  }
}

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    let granted = false;
    try {
      const features = await getEnabledFeatures();
      granted = await browser.permissions.contains({
        origins: getRequiredOrigins(features),
      });
    } catch {}
    if (!granted) {
      browser.tabs.create({ url: browser.runtime.getURL("setup.html") });
    }
  }
  refreshActionBadge();
});

async function reloadFantraxTabs() {
  try {
    const tabs = await browser.tabs.query({ url: "*://*.fantrax.com/*" });
    for (const tab of tabs) {
      browser.tabs.reload(tab.id);
    }
  } catch (e) {
    // best-effort
  }
}

browser.runtime.onStartup?.addListener(refreshActionBadge);
browser.permissions.onAdded?.addListener(() => {
  refreshActionBadge();
  reloadFantraxTabs();
});
browser.permissions.onRemoved?.addListener(refreshActionBadge);
browser.storage?.onChanged?.addListener((_changes, area) => {
  if (area === "sync") refreshActionBadge();
});
refreshActionBadge();

// --- Remote config service (docs/update-resilience-design.md, Component 1) ---

const CONFIG_URL =
  "https://raw.githubusercontent.com/chefBrian/fantrax-baseball-plus/main/config/remote-config.json";
const FORCED_FETCH_FLOOR_MS = 5 * 60 * 1000;
const {
  validateConfig, configTtlMs, compareVersions,
  browserKeyFrom, pickLatest, statusApplies,
} = globalThis.OCFConfigLib;

async function getConfig(force) {
  const { ocfConfigCache, ocfLastForcedFetch } = await browser.storage.local.get({
    ocfConfigCache: null,
    ocfLastForcedFetch: 0,
  });

  if (!ocfConfigCache) {
    // First run: block on the network once; fall back to the packaged copy.
    const fresh = await revalidateConfig();
    if (fresh) return fresh;
    return (await loadBundledConfig()) || validateConfig({ schemaVersion: 1 });
  }

  const { config, fetchedAt } = ocfConfigCache;
  const stale = Date.now() - fetchedAt > configTtlMs(config);
  const forceAllowed = force && Date.now() - ocfLastForcedFetch > FORCED_FETCH_FLOOR_MS;
  if (forceAllowed) {
    browser.storage.local.set({ ocfLastForcedFetch: Date.now() });
  }
  if (stale || forceAllowed) {
    revalidateConfig(); // stale-while-revalidate: serve the cache, refresh in background
  }
  return config;
}

async function revalidateConfig() {
  const config = await fetchRemoteConfig();
  if (!config) return null;
  await browser.storage.local.set({ ocfConfigCache: { config, fetchedAt: Date.now() } });
  maybeRequestUpdateCheck(config);
  return config;
}

async function fetchRemoteConfig() {
  try {
    const { ocfConfigUrlOverride } = await browser.storage.local.get({ ocfConfigUrlOverride: null });
    const url = ocfConfigUrlOverride || CONFIG_URL;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000), cache: "no-cache" });
    if (!r.ok) return null;
    return validateConfig(await r.json());
  } catch {
    return null;
  }
}

async function loadBundledConfig() {
  try {
    const r = await fetch(browser.runtime.getURL("remote-config.json"));
    return validateConfig(await r.json());
  } catch {
    return null;
  }
}

function maybeRequestUpdateCheck(config) {
  try {
    if (typeof browser.runtime.requestUpdateCheck !== "function") return; // Firefox
    const latest = pickLatest(config, detectBrowserKey());
    if (!latest) return;
    if (compareVersions(latest, browser.runtime.getManifest().version) <= 0) return;
    // Fire and forget: "throttled" / "no_update" need no handling. Once the
    // download completes, MV3 applies it when this worker next idles out -
    // no runtime.reload() machinery (see design doc, Component 3).
    const p = browser.runtime.requestUpdateCheck(() => void browser.runtime.lastError);
    if (p?.catch) p.catch(() => {});
  } catch {
    // best-effort
  }
}

function detectBrowserKey() {
  return browserKeyFrom(
    typeof browser.runtime.getBrowserInfo === "function",
    globalThis.navigator?.userAgentData?.brands || []
  );
}

function refreshUninstallUrl() {
  try {
    const v = browser.runtime.getManifest().version;
    const url = `https://chefbrian.github.io/fantrax-baseball-plus/uninstall.html?v=${encodeURIComponent(v)}&b=${detectBrowserKey()}`;
    const p = browser.runtime.setUninstallURL(url);
    if (p?.catch) p.catch(() => {});
  } catch {
    // best-effort
  }
}
refreshUninstallUrl();

// Firefox: rewrite Origin/Referer on FanGraphs requests to avoid Cloudflare challenge
// (Chrome handles this via declarativeNetRequest rules.json)
if (typeof browser.webRequest !== "undefined") {
  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const headers = details.requestHeaders.map((h) => {
        if (h.name.toLowerCase() === "origin") return { name: h.name, value: "https://www.fangraphs.com" };
        if (h.name.toLowerCase() === "referer") return { name: h.name, value: "https://www.fangraphs.com/" };
        return h;
      });
      return { requestHeaders: headers };
    },
    { urls: ["https://www.fangraphs.com/api/*"] },
    ["blocking", "requestHeaders"]
  );
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ocf-get-config") {
    (async () => {
      try {
        const config = await getConfig(!!msg.force);
        const currentVersion = browser.runtime.getManifest().version;
        const browserKey = detectBrowserKey();
        const latest = pickLatest(config, browserKey);
        sendResponse({
          ok: true,
          config,
          meta: {
            browserKey,
            currentVersion,
            statusApplies: statusApplies(config, currentVersion),
            updateAvailable: !!latest && compareVersions(latest, currentVersion) > 0,
            latestVersion: latest,
          },
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === "ocf-open-setup") {
    browser.tabs.create({ url: browser.runtime.getURL("setup.html") });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "ocf-check-perms") {
    (async () => {
      try {
        const features = await getEnabledFeatures();
        const origins = getRequiredOrigins(features);
        const granted = await browser.permissions.contains({ origins });
        sendResponse({ ok: true, granted });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === "ocf-fetch-videos") {
    fetch("https://fastball-gateway.mlb.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "q3GnMGKfBMWuvSMY7QBGJ47bscDcFdU47yttVmal",
      },
      body: JSON.stringify({
        query: msg.gqlQuery,
        variables: msg.variables,
      }),
      signal: AbortSignal.timeout(15000),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`MLB API ${r.status}`);
        return r.json();
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "ocf-fetch-video-blob") {
    fetch(msg.url, {
      headers: {
        Referer: "https://www.mlb.com/",
        Origin: "https://www.mlb.com",
      },
      signal: AbortSignal.timeout(30000),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Video fetch ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buffer) => {
        const bytes = new Uint8Array(buffer);
        const CHUNK = 8192;
        let binary = "";
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(
            null,
            bytes.subarray(i, i + CHUNK)
          );
        }
        sendResponse({ ok: true, data: btoa(binary) });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "ocf-fetch-rolling") {
    const url = `https://baseballsavant.mlb.com/player-services/rolling-thumb?playerId=${encodeURIComponent(msg.playerId)}`;
    fetch(url, { signal: AbortSignal.timeout(10000) })
      .then((r) => {
        if (!r.ok) throw new Error(`Savant rolling ${r.status}`);
        return r.json();
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "ocf-fetch-fangraphs") {
    const qual = msg.qual || 0;
    let url = `https://www.fangraphs.com/api/leaders/major-league/data?pos=all&stats=pit&lg=all&qual=${encodeURIComponent(qual)}&season=${encodeURIComponent(msg.season)}&month=${encodeURIComponent(msg.month)}&ind=0&team=0&pageitems=2000000000&pagenum=1&type=36`;
    if (msg.startdate && msg.enddate) {
      url += `&startdate=${encodeURIComponent(msg.startdate)}&enddate=${encodeURIComponent(msg.enddate)}`;
    }
    fetch(url, { signal: AbortSignal.timeout(20000) })
      .then((r) => {
        if (!r.ok) throw new Error(`FanGraphs ${r.status}`);
        return r.json();
      })
      .then((data) => {
        // Response is { data: [...] }
        const rows = data?.data;
        if (!Array.isArray(rows) || rows.length === 0 || !rows[0].xMLBAMID) {
          throw new Error("Invalid FanGraphs response");
        }
        // Strip to essential fields, keyed by MLB ID
        const players = {};
        for (const p of rows) {
          if (!p.xMLBAMID) continue;
          players[p.xMLBAMID] = {
            fgId: p.playerid,
            ip: p.IP,
            stuff: p.sp_stuff,
            location: p.sp_location,
            pitching: p.sp_pitching,
            xfip: p.xFIP,
            siera: p.SIERA,
            xera: p.xERA,
            ev: p.EV,
            barrel_pct: p["Barrel%"],
            hard_hit_pct: p["HardHit%"],
            k_pct: p["K%"],
            bb_pct: p["BB%"],
            fbv: p.FBv,
            chase_pct: p["O-Swing%"],
            whiff_pct: p["SwStr%"],
          };
        }
        sendResponse({ ok: true, data: players });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "ocf-fetch-statcast") {
    const url = `https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=${encodeURIComponent(msg.playerType)}&year=2025&position=&team=&player_id=${encodeURIComponent(msg.playerId)}&csv=true`;
    fetch(url, { signal: AbortSignal.timeout(10000) })
      .then((r) => {
        if (!r.ok) throw new Error(`Savant ${r.status}`);
        return r.text();
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // Per-player expected stats (xwOBA/xBA/xSLG, or opponent expected stats for pitchers).
  // statsapi has no qualification gate, so this works for unqualified players too.
  if (msg.type === "ocf-fetch-expected-stats") {
    const group = msg.playerType === "pitcher" ? "pitching" : "hitting";
    const url = `https://statsapi.mlb.com/api/v1/people/${encodeURIComponent(msg.playerId)}/stats?stats=expectedStatistics&group=${group}&season=${encodeURIComponent(msg.year)}`;
    fetch(url, { signal: AbortSignal.timeout(8000) })
      .then((r) => {
        if (!r.ok) throw new Error(`statsapi ${r.status}`);
        return r.json();
      })
      .then((d) => {
        const splits = d?.stats?.[0]?.splits;
        if (!Array.isArray(splits) || splits.length === 0) {
          sendResponse({ ok: true, data: null });
          return;
        }
        const stat = splits[0].stat || {};
        const num = (s) => { const v = parseFloat(s); return isNaN(v) ? null : v; };
        sendResponse({ ok: true, data: { woba: num(stat.woba), avg: num(stat.avg), slg: num(stat.slg) } });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // Shared season-wide Savant leaderboards used to compute projected percentiles for
  // unqualified players. `min=0`/`minSwings=0` include sub-threshold players' raw values;
  // the qualified `expected_statistics` board supplies mu/sigma + the qualified id set.
  if (msg.type === "ocf-fetch-sc-leaderboard") {
    const year = encodeURIComponent(msg.year);
    const type = msg.playerType === "pitcher" ? "pitcher" : "batter";
    let url;
    if (msg.board === "bat-tracking") {
      url = `https://baseballsavant.mlb.com/leaderboard/bat-tracking?minSwings=0&minGroupSwings=1&seasonStart=${year}&seasonEnd=${year}&type=${type}&csv=true`;
    } else if (msg.board === "expected") {
      url = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=${type}&year=${year}&position=&team=&filter=&csv=true`;
    } else {
      const selections = type === "pitcher"
        ? "est_woba,est_ba,est_slg,xera,exit_velocity_avg,barrel_batted_rate,hard_hit_percent,k_percent,bb_percent,whiff_percent,oz_swing_percent,fastball_avg_speed,p_formatted_ip"
        : "est_woba,est_ba,est_slg,exit_velocity_avg,barrel_batted_rate,hard_hit_percent,k_percent,bb_percent,whiff_percent,oz_swing_percent,sprint_speed,pa";
      url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=${type}&filter=&min=0&csv=true&selections=${selections}`;
    }
    fetch(url, { signal: AbortSignal.timeout(15000) })
      .then((r) => {
        if (!r.ok) throw new Error(`Savant ${r.status}`);
        return r.text();
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "ocf-fetch-prospect-savant") {
    const url = `https://oriolebird.pythonanywhere.com/player/${encodeURIComponent(msg.playerId)}`;
    fetch(url, { signal: AbortSignal.timeout(8000) })
      .then((r) => {
        if (!r.ok) throw new Error(`ProspectSavant ${r.status}`);
        return r.json();
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "ocf-fetch-prospect-rolling") {
    const type = msg.playerType === "pitcher" ? "pitcher" : "batter";
    const url = `https://oriolebird.pythonanywhere.com/rolling-data/${encodeURIComponent(msg.playerId)}/${encodeURIComponent(msg.season)}/25/${type}`;
    fetch(url, { signal: AbortSignal.timeout(8000) })
      .then((r) => {
        if (!r.ok) throw new Error(`ProspectSavant rolling ${r.status}`);
        return r.json();
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  return false;
});

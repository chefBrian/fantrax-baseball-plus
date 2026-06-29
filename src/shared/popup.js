const browser = globalThis.browser || globalThis.chrome;

const FEATURES = ["bbref", "statcastIcon", "statcastPanel", "video", "liveGame", "fangraphsPanel", "prospectSavantPanel"];
const DEFAULTS = { bbref: true, statcastIcon: true, statcastPanel: true, video: true, liveGame: true, fangraphsPanel: true, prospectSavantPanel: true, themeOverride: "auto" };

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

function originsForEnabled(features) {
  const set = new Set(BASE_ORIGINS);
  for (const [feature, origins] of Object.entries(FEATURE_ORIGINS)) {
    if (features[feature]) origins.forEach((o) => set.add(o));
  }
  return [...set];
}

function currentToggleState() {
  const state = {};
  for (const key of FEATURES) state[key] = document.getElementById(key).checked;
  return state;
}

async function refreshPermissionBanner() {
  const banner = document.getElementById("permBanner");
  if (!browser.permissions?.contains) {
    banner.classList.remove("visible");
    return;
  }
  try {
    const origins = originsForEnabled(currentToggleState());
    const granted = await browser.permissions.contains({ origins });
    banner.classList.toggle("visible", !granted);
  } catch {
    banner.classList.remove("visible");
  }
}

async function handleToggleChange(key, el) {
  if (el.checked) {
    const needed = FEATURE_ORIGINS[key];
    if (needed && browser.permissions) {
      try {
        const has = await browser.permissions.contains({ origins: needed });
        if (!has) {
          const granted = await browser.permissions.request({ origins: needed });
          if (!granted) {
            el.checked = false;
          }
        }
      } catch (e) {
        console.warn("[OCF] Permission request failed:", e);
      }
    }
  }
  await save();
  refreshPermissionBanner();
}

async function init() {
  const versionEl = document.getElementById("version");
  versionEl.textContent = "v" + browser.runtime.getManifest().version;
  versionEl.href = "https://github.com/chefBrian/fantrax-baseball-plus/releases";
  const stored = await browser.storage.sync.get(DEFAULTS);
  for (const key of FEATURES) {
    const el = document.getElementById(key);
    el.checked = stored[key];
    el.addEventListener("change", () => handleToggleChange(key, el));
  }
  const seg = document.getElementById("themeSeg");
  const override = stored.themeOverride || "auto";
  applyThemeSeg(seg, override);
  applyPopupTheme(override);
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-theme]");
    if (!btn) return;
    applyThemeSeg(seg, btn.dataset.theme);
    applyPopupTheme(btn.dataset.theme);
    browser.storage.sync.set({ themeOverride: btn.dataset.theme });
  });

  document.getElementById("permBtn").addEventListener("click", async () => {
    try {
      const origins = originsForEnabled(currentToggleState());
      await browser.permissions.request({ origins });
    } catch (e) {
      console.warn("[OCF] Permission request failed:", e);
    }
    refreshPermissionBanner();
  });
  refreshPermissionBanner();
}

function applyThemeSeg(seg, theme) {
  for (const btn of seg.querySelectorAll("button")) {
    btn.classList.toggle("active", btn.dataset.theme === theme);
  }
}

async function applyPopupTheme(override) {
  let theme = override;
  if (theme !== "light" && theme !== "dark") {
    const cached = await browser.storage.local.get({ ocfTheme: null });
    theme = cached.ocfTheme === "light" ? "light" : "dark";
  }
  document.documentElement.classList.toggle("light", theme === "light");
}

async function save() {
  const settings = {};
  for (const key of FEATURES) {
    settings[key] = document.getElementById(key).checked;
  }
  await browser.storage.sync.set(settings);
}

init();

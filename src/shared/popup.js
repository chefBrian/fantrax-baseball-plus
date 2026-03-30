const browser = globalThis.browser || globalThis.chrome;

const FEATURES = ["statcastIcon", "statcastPanel", "video", "liveGame"];
const DEFAULTS = { statcastIcon: true, statcastPanel: true, video: true, liveGame: true };

async function init() {
  const stored = await browser.storage.sync.get(DEFAULTS);
  for (const key of FEATURES) {
    const el = document.getElementById(key);
    el.checked = stored[key];
    el.addEventListener("change", () => save());
  }
}

async function save() {
  const settings = {};
  for (const key of FEATURES) {
    settings[key] = document.getElementById(key).checked;
  }
  await browser.storage.sync.set(settings);
}

init();

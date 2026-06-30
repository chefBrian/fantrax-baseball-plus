const browser = globalThis.browser || globalThis.chrome;

// Welcome flow always asks for everything - users can fine-tune later by
// disabling features in the popup or revoking individual hosts in about:addons.
// Single source of truth for the welcome page: each host's display label, the hostname
// shown to the user, AND the origin we request. The table in setup.html is rendered from
// this list, so the displayed list and the requested permissions can't drift apart.
// Keep in sync with FEATURE_ORIGINS in background.js / popup.js — this is the union of
// every feature's hosts. A host missing here is never requested on the welcome page, so on
// Firefox (host_permissions are optional) it stays ungranted: the perm banner never clears
// and that feature's fetches CORS-fail.
const HOSTS = [
  { label: "Fantrax", host: "www.fantrax.com", origin: "*://*.fantrax.com/*" },
  { label: "MLB Film Room", host: "fastball-gateway.mlb.com", origin: "https://fastball-gateway.mlb.com/*" },
  { label: "MLB Stats", host: "statsapi.mlb.com", origin: "https://statsapi.mlb.com/*" },
  { label: "MLB Video clips", host: "fastball-clips.mlb.com", origin: "https://fastball-clips.mlb.com/*" },
  { label: "Baseball Savant", host: "baseballsavant.mlb.com", origin: "https://baseballsavant.mlb.com/*" },
  { label: "FanGraphs", host: "www.fangraphs.com", origin: "https://www.fangraphs.com/*" },
  { label: "ProspectSavant", host: "oriolebird.pythonanywhere.com", origin: "https://oriolebird.pythonanywhere.com/*" },
];

const ALL_ORIGINS = HOSTS.map((h) => h.origin);

async function getRequestOrigins() {
  return ALL_ORIGINS;
}

function renderHosts() {
  const ul = document.querySelector(".hosts");
  if (!ul) return;
  ul.replaceChildren(...HOSTS.map((h) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = h.label;
    const code = document.createElement("code");
    code.textContent = h.host;
    li.append(span, code);
    return li;
  }));
}

const btn = document.getElementById("grantBtn");
const status = document.getElementById("status");

async function refresh({ justGranted = false } = {}) {
  try {
    const origins = await getRequestOrigins();
    const granted = await browser.permissions.contains({ origins });
    if (granted) {
      btn.textContent = "All set";
      btn.disabled = true;
      status.textContent = justGranted
        ? "Closing this tab..."
        : "You can close this tab and head to Fantrax.";
      status.classList.add("success");
      if (justGranted) {
        setTimeout(() => window.close(), 1500);
      }
    }
  } catch {}
}

btn.addEventListener("click", async () => {
  status.classList.remove("success");
  status.textContent = "";
  try {
    const origins = await getRequestOrigins();
    const granted = await browser.permissions.request({ origins });
    if (granted) {
      refresh({ justGranted: true });
    } else {
      status.textContent = "Permission was not granted. Click to try again.";
    }
  } catch (e) {
    status.textContent = "Couldn't request permissions: " + e.message;
  }
});

renderHosts();
refresh();

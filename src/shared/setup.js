const browser = globalThis.browser || globalThis.chrome;

const REQUIRED_ORIGINS = [
  "*://*.fantrax.com/*",
  "https://fastball-gateway.mlb.com/*",
  "https://statsapi.mlb.com/*",
  "https://fastball-clips.mlb.com/*",
  "https://baseballsavant.mlb.com/*",
  "https://www.fangraphs.com/*",
];

const btn = document.getElementById("grantBtn");
const status = document.getElementById("status");

async function refresh({ justGranted = false } = {}) {
  try {
    const granted = await browser.permissions.contains({ origins: REQUIRED_ORIGINS });
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
    const granted = await browser.permissions.request({ origins: REQUIRED_ORIGINS });
    if (granted) {
      refresh({ justGranted: true });
    } else {
      status.textContent = "Permission was not granted. Click to try again.";
    }
  } catch (e) {
    status.textContent = "Couldn't request permissions: " + e.message;
  }
});

refresh();

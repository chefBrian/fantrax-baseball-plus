# Incident Runbook - remote-config.json

**For `remote-config.json`, committing to `main` IS the deploy.** Every
installed extension reads that file directly. Rehearse in
`remote-config.staging.json` first for anything with blast radius
(kill switches); message-only tweaks can go straight to prod.

## When Fantrax breaks the extension

1. **Confirm** - canary issue, banner reports, or open a player modal yourself.
2. **Announce** (within minutes, phone works):
   Edit `config/remote-config.json` on `main`:
   - `status.level`: `"broken"` (or `"degraded"` if features still mostly work)
   - `status.message`: one plain-text sentence, e.g.
     `"Fantrax changed their site on <date>. A fix is in progress - your browser will update automatically once it's out."`
   - `status.maxAffectedVersion`: the newest broken version (usually current)
   - `killSwitches`: set `true` for visibly broken features, e.g. `{"statcastPanel": true}`
   Actively-affected clients converge within a browsing session (self-detection
   forces a refetch; the specific message shows on their next page load). Installs
   still holding a fresh `"ok"` config only refetch on the 6h TTL - propagation is
   best-effort, not to-the-minute.
3. **Fix**: code fix -> `./version.sh patch` -> commit -> `git tag vX.Y.Z` ->
   `git push origin main --tags`. Stores submit automatically.
4. **As EACH store approves**, bump that store's entry in `latestVersion`
   (`chrome` / `firefox` / `edge`). Do NOT bump before approval - it makes
   the banner cry wolf.
5. **All-clear** (once all stores have the fix):
   - `status.level` -> `"ok"`, `status.message` -> `""`
   - `status.fixedInVersion` -> the fix version (the uninstall page uses it)
   - every kill switch from step 2 -> removed
   Steps 4-5 are the ones that get forgotten. A stale "broken" banner erodes
   trust as much as the breakage did.

## Rehearsal (staging)

- Edit `config/remote-config.staging.json` (keep `"_staging": true` - clients
  reject any config containing it, so a bad paste into prod is a non-event).
- In your own install's background console:
  `chrome.storage.local.set({ocfConfigUrlOverride: "https://raw.githubusercontent.com/chefBrian/fantrax-baseball-plus/main/config/remote-config.staging.json", ocfConfigCache: null})`
  ...but note validation rejects `_staging` configs by design; to *see* the
  staged config live, seed the cache directly instead:
  `chrome.storage.local.set({ocfConfigCache: {config: <staged JSON minus _staging>, fetchedAt: Date.now()}})`
- Go-live = copy the staged contents into `remote-config.json`, WITHOUT the
  `_staging` line, and commit to `main`.
- Cleanup: `chrome.storage.local.remove(["ocfConfigUrlOverride", "ocfConfigCache"])`

## Fire drill (run once after each phase ships)

Push `status.level: "degraded"` + a test message to prod. In a personal install,
clear `ocfConfigCache` in the background console first (else the 6h `"ok"` TTL
delays it), reload Fantrax, and confirm the banner appears on Chrome AND Firefox,
then run the all-clear. Ten minutes total; do not skip.

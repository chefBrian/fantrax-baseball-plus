(function () {
  "use strict";

  const browser = globalThis.browser || globalThis.chrome;

  const PROCESSED_ATTR = "data-ocf-links";
  const THEME_STORAGE_KEY = "ocfTheme";
  let themeOverride = "auto";

  function detectFantraxTheme() {
    const bg = getComputedStyle(document.documentElement).backgroundColor;
    const m = bg && bg.match(/\d+(?:\.\d+)?/g);
    if (!m || m.length < 3) return "dark";
    const [r, g, b] = m.map(Number);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? "light" : "dark";
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    root.classList.toggle("ocf-light", theme === "light");
    root.classList.toggle("ocf-dark", theme !== "light");
  }

  function resolveTheme() {
    return themeOverride === "light" || themeOverride === "dark"
      ? themeOverride
      : detectFantraxTheme();
  }

  function reconcileTheme() {
    const target = resolveTheme();
    const current = document.documentElement.classList.contains("ocf-light") ? "light" : "dark";
    if (target !== current) {
      applyTheme(target);
      if (themeOverride === "auto") {
        try { browser.storage.local.set({ [THEME_STORAGE_KEY]: target }); } catch (e) {}
      }
    }
  }

  // Apply cached theme immediately to avoid flashing on first injected UI
  try {
    browser.storage.local.get({ [THEME_STORAGE_KEY]: null }).then((stored) => {
      if (stored && stored[THEME_STORAGE_KEY]) applyTheme(stored[THEME_STORAGE_KEY]);
      reconcileTheme();
    });
  } catch (e) {
    applyTheme(detectFantraxTheme());
  }

  // Watch for live theme toggles (Fantrax swaps styles without reload)
  new MutationObserver(reconcileTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  });

  const MLB_SEARCH_API = "https://statsapi.mlb.com/api/v1/people/search?names=";
  const VIDEOS_PER_PAGE = 25;
  // Feature toggles (all on by default, overridden by storage)
  const features = { bbref: true, statcastIcon: true, statcastPanel: true, video: true, liveGame: true, fangraphsPanel: true, prospectSavantPanel: true };
  // Cache MLB ID lookups
  const mlbIdCache = new Map();

  // Map Fantrax team abbreviations to MLB API full names (for disambiguating
  // shared-name players like Max Muncy). ATH = Athletics (Sacramento, post-2025
  // rebrand); OAK is a legacy fallback in case Fantrax hasn't updated.
  const TEAM_ABBR_TO_NAME = {
    ARI: "Arizona Diamondbacks",
    ATL: "Atlanta Braves",
    BAL: "Baltimore Orioles",
    BOS: "Boston Red Sox",
    CHC: "Chicago Cubs",
    CHW: "Chicago White Sox",
    CIN: "Cincinnati Reds",
    CLE: "Cleveland Guardians",
    COL: "Colorado Rockies",
    DET: "Detroit Tigers",
    HOU: "Houston Astros",
    KC:  "Kansas City Royals",
    LAA: "Los Angeles Angels",
    LAD: "Los Angeles Dodgers",
    MIA: "Miami Marlins",
    MIL: "Milwaukee Brewers",
    MIN: "Minnesota Twins",
    NYM: "New York Mets",
    NYY: "New York Yankees",
    ATH: "Athletics",
    OAK: "Athletics",
    PHI: "Philadelphia Phillies",
    PIT: "Pittsburgh Pirates",
    SD:  "San Diego Padres",
    SEA: "Seattle Mariners",
    SF:  "San Francisco Giants",
    STL: "St. Louis Cardinals",
    TB:  "Tampa Bay Rays",
    TEX: "Texas Rangers",
    TOR: "Toronto Blue Jays",
    WSH: "Washington Nationals",
  };
  const TEAM_FULL_NAMES = new Set(Object.values(TEAM_ABBR_TO_NAME));

  function normalizeTeam(teamHint) {
    if (!teamHint) return null;
    if (TEAM_FULL_NAMES.has(teamHint)) return teamHint;
    return TEAM_ABBR_TO_NAME[teamHint.toUpperCase()] || null;
  }
  let scheduleData = null;
  let schedulePromise = null;

  // Detect live game scores in DOM text (e.g., "ATH 0@ATL 3", "ATH 0 @ ATL 3 Bot 2nd")
  // Matches "TEAM #@TEAM #" or "TEAM # @ TEAM #" - present for live and final games, absent for scheduled
  const GAME_SCORE_RE = /[A-Z]{2,4}\s+\d+\s*@\s*[A-Z]{2,4}\s+\d+/;
  // Final games end with "F" after the score (e.g., "MIN 1@KC 3 F")
  const FINAL_SCORE_RE = /[A-Z]{2,4}\s+\d+\s*@\s*[A-Z]{2,4}\s+\d+\s*F\b/;

  // Map abbreviated names ("C. Emerson") -> full names ("Corbin Emerson")
  const abbrNameMap = new Map();
  let abbrFetched = false;

  async function fetchScorerNames() {
    if (abbrFetched) return;
    abbrFetched = true;

    // Extract league ID from the current URL
    const leagueMatch = location.pathname.match(/\/league\/([^/]+)/);
    if (!leagueMatch) return;
    const leagueId = leagueMatch[1];

    try {
      const resp = await fetch(`/fxpa/req?leagueId=${leagueId}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({
          msgs: [{ method: "getTransactionDetailsHistory", data: {} }],
          uiv: 3,
        }),
      });
      if (!resp.ok) return;
      const data = await resp.json();

      // Walk the response to find scorer objects with scorerId + name
      let added = false;
      function walk(obj) {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) { obj.forEach(walk); return; }
        if (obj.scorerId && obj.name) {
          const parts = obj.name.split(/\s+/);
          if (parts.length >= 2) {
            const abbr = parts[0][0] + ". " + parts.slice(1).join(" ");
            if (!abbrNameMap.has(abbr)) {
              abbrNameMap.set(abbr, obj.name);
              added = true;
            }
          }
        }
        for (const v of Object.values(obj)) {
          if (typeof v === "object") walk(v);
        }
      }
      walk(data);
      if (added) scanAndInject();
    } catch (e) {
      console.warn("[OCF] Scorer name fetch failed:", e);
    }
  }

  // Strip Fantrax suffixes like "-P", "-H", "-DH" from player names (e.g. "Shohei Ohtani-P")
  function cleanPlayerName(name) {
    return name.replace(/-(P|H|DH)$/i, "").trim();
  }

  // Accent-insensitive, lowercase name key for matching (e.g. "José" -> "jose")
  function normalizeName(s) {
    return (s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  async function lookupMlbId(playerName, teamHint) {
    const normalizedTeam = normalizeTeam(teamHint);
    const cacheKey = `${playerName}|${normalizedTeam || ""}`;
    if (mlbIdCache.has(cacheKey)) {
      return mlbIdCache.get(cacheKey);
    }
    // MLB API name matching is inconsistent with periods:
    //   "T.J. Friedl" / "C.J. Abrams" only match WITHOUT periods
    //   "J.P. Crawford" only matches WITH periods
    // Try the stripped form first, fall back to the original.
    const stripped = playerName.replace(/\./g, "");
    const candidates = stripped !== playerName ? [stripped, playerName] : [playerName];
    try {
      let people = [];
      for (const candidate of candidates) {
        const resp = await fetch(
          `${MLB_SEARCH_API}${encodeURIComponent(candidate)}&hydrate=currentTeam`
        );
        if (!resp.ok) continue;
        const data = await resp.json();
        people = data.people || [];
        if (people.length > 0) break;
      }
      // Fallback: the full-name search misses players whose canonical MLB name
      // carries a middle initial - e.g. "José A. Ferrer" won't match "Jose Ferrer".
      // Search by last name (accents are folded by the API) and keep only exact
      // first+last matches, then let the team disambiguation below pick the right one.
      if (people.length === 0) {
        const parts = playerName.trim().split(/\s+/);
        if (parts.length >= 2) {
          const lastName = parts[parts.length - 1];
          const resp = await fetch(
            `${MLB_SEARCH_API}${encodeURIComponent(lastName)}&hydrate=currentTeam`
          );
          if (resp.ok) {
            const data = await resp.json();
            const wantFirst = normalizeName(parts[0]);
            const wantLast = normalizeName(lastName);
            people = (data.people || []).filter(
              (p) =>
                normalizeName(p.firstName) === wantFirst &&
                normalizeName(p.lastName) === wantLast
            );
          }
        }
      }
      if (people.length === 0) return null;

      let match = people[0];
      if (people.length > 1 && normalizedTeam) {
        const teamMatch = people.find(
          (p) => p.currentTeam?.name === normalizedTeam
        );
        if (teamMatch) {
          match = teamMatch;
        } else {
          console.warn(
            `[OCF] Ambiguous name "${playerName}" with team "${normalizedTeam}" did not match any of: ${people.map((p) => p.currentTeam?.name).join(", ")}`
          );
        }
      }
      mlbIdCache.set(cacheKey, match.id);
      return match.id;
    } catch (e) {
      console.warn("[OCF] MLB ID lookup failed for", playerName, e);
    }
    return null;
  }

  async function fetchTodaySchedule(forceRefresh = false) {
    if (scheduleData && !forceRefresh) return scheduleData;
    if (schedulePromise && !forceRefresh) return schedulePromise;
    schedulePromise = (async () => {
      try {
        const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
        const resp = await fetch(
          `https://statsapi.mlb.com/api/v1/schedule?date=${today}&sportId=1&hydrate=team,broadcasts`
        );
        if (!resp.ok) return null;
        const data = await resp.json();
        const games = data.dates?.[0]?.games || [];
        const map = new Map();
        for (const game of games) {
          const isLive = game.status.detailedState === "In Progress";
          const exclusive = (game.broadcasts || []).find(
            (b) => b.type === "TV" && b.availability?.availabilityCode === "exclusive"
          );
          const info = { gamePk: game.gamePk, isLive, exclusiveBroadcast: exclusive?.callSign || null };
          for (const side of ["away", "home"]) {
            const team = game.teams[side].team;
            map.set(team.abbreviation, info);
            map.set(team.name, info);
          }
        }
        scheduleData = map;
        return map;
      } catch (e) {
        return null;
      } finally {
        schedulePromise = null;
      }
    })();
    return schedulePromise;
  }

  const EXCLUSIVE_BROADCAST_URLS = {
    "Peacock": "https://www.peacocktv.com/sports/mlb",
    "Apple TV": "https://tv.apple.com/us/room/edt.item.62327df1-6874-470e-98b2-a5bbeac509a2",
    "ESPN": "https://www.espn.com/watch/",
    "Netflix": "https://www.netflix.com",
    "TBS": "https://www.tbs.com/mlb-on-tbs",
  };

  function getLiveGameInfo(game) {
    const bc = game.exclusiveBroadcast;
    if (bc && EXCLUSIVE_BROADCAST_URLS[bc]) {
      return { url: EXCLUSIVE_BROADCAST_URLS[bc], title: `Watch on ${bc}` };
    }
    return { url: `https://www.mlb.com/tv/g${game.gamePk}`, title: "Watch Live on MLB.tv" };
  }

  function createLiveIcon(container) {
    const a = document.createElement("a");
    a.className = "ocf-link ocf-link--live";
    a.style.display = "none";
    a.title = "Watch Live on MLB.tv";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    const i = document.createElement("mat-icon");
    i.className = "mat-icon material-icons";
    i.textContent = "live_tv";
    a.appendChild(i);
    a.addEventListener("click", (e) => e.stopPropagation());
    container.appendChild(a);
    return a;
  }

  async function maybeShowLiveIcon(liveIcon, teamStr, forceRefresh = false) {
    if (!teamStr) return;
    const schedule = await fetchTodaySchedule(forceRefresh);
    if (!schedule) return;

    const game = schedule.get(teamStr);
    if (!game || !game.isLive) return;

    const { url, title } = getLiveGameInfo(game);
    liveIcon.href = url;
    liveIcon.title = title;
    liveIcon.style.display = "";
  }

  // --- DOM-based live game detection ---

  // Get the Opp cell text for a scorer element by page layout type
  function getOppText(scorerEl) {
    // i-table layout (roster, players pages) - scorer and Opp in same row
    const iRow = scorerEl.closest(".i-table__row");
    if (iRow) {
      const oppCell = iRow.querySelector(".i-table__cell--small");
      return oppCell?.textContent?.trim() || null;
    }

    // ultimate-table layout (livescoring page) - split DOM trees, index-aligned
    const utAside = scorerEl.closest("aside._ut__aside");
    if (utAside) {
      const scorerCell = scorerEl.closest("td");
      if (!scorerCell) return null;
      const index = [...utAside.children].indexOf(scorerCell);
      if (index === -1) return null;
      const utContent = utAside.parentElement?.querySelector("div._ut__content");
      const container = utContent?.querySelector("tbody") || utContent?.querySelector("table");
      const rows = container ? [...container.querySelectorAll(":scope > tr")] : [];
      return rows[index]?.querySelector("td")?.textContent?.trim() || null;
    }

    // No Opp column (transactions, news, etc.)
    return null;
  }

  // Check if the Opp column text indicates a live (in-progress) game
  function isOppLive(text) {
    if (!text) return false;
    if (!GAME_SCORE_RE.test(text)) return false; // scheduled or no game
    if (FINAL_SCORE_RE.test(text)) return false; // final
    return true;
  }

  // Check DOM for live game status; returns true/false/null (null = no Opp column)
  function isLiveFromDOM(scorerEl) {
    const oppText = getOppText(scorerEl);
    if (oppText === null) return null;
    return isOppLive(oppText);
  }

  // Show live icon using cached schedule data (for gamePk and broadcast info)
  async function showLiveIconFromSchedule(liveIcon, teamStr) {
    if (!teamStr) return;
    const schedule = await fetchTodaySchedule();
    if (!schedule) return;
    const game = schedule.get(teamStr);
    if (!game) return;
    const { url, title } = getLiveGameInfo(game);
    liveIcon.href = url;
    liveIcon.title = title;
    liveIcon.style.display = "";
  }

  // Re-check a single live icon against the DOM Opp column
  function updateLiveIconFromDOM(liveIcon) {
    const links = liveIcon.closest(".ocf-links--sm");
    if (!links) return;
    const scorer = links.closest("scorer") || links.closest(".scorer");
    if (!scorer) return;
    const live = isLiveFromDOM(scorer);
    if (live === true && liveIcon.style.display === "none") {
      const teamStr = getTeamFromScorer(scorer);
      showLiveIconFromSchedule(liveIcon, teamStr);
    } else if (live === false) {
      liveIcon.style.display = "none";
    }
    // live === null: no Opp column, don't change (handled by API on initial load)
  }

  function makeUrlName(name) {
    return name
      .toLowerCase()
      .replace(/[.\s]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/-$/, "");
  }

  function openLink(url) {
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // --- Statcast Percentile Panel ---

  const statcastCache = new Map();
  let statcastPanelRequestId = 0;

  const BATTING_PERCENTILE_STATS = [
    { key: "xwoba", label: "xwOBA" },
    { key: "xba", label: "xBA" },
    { key: "xslg", label: "xSLG" },
    { key: "exit_velocity", label: "Avg Exit Velo" },
    { key: "brl_percent", label: "Barrel %" },
    { key: "hard_hit_percent", label: "Hard-Hit %" },
    { key: "bat_speed", label: "Bat Speed" },
    { key: "squared_up_rate", label: "Squared-Up %" },
    { key: "chase_percent", label: "Chase %" },
    { key: "whiff_percent", label: "Whiff %" },
    { key: "k_percent", label: "K %" },
    { key: "bb_percent", label: "BB %" },
  ];

  const SPEED_PERCENTILE_STATS = [
    { key: "sprint_speed", label: "Sprint Speed" },
  ];

  const PITCHING_PERCENTILE_STATS = [
    { key: "xera", label: "xERA" },
    { key: "xba", label: "xBA" },
    { key: "xslg", label: "xSLG" },
    { key: "fb_velocity", label: "Fastball Velo" },
    { key: "exit_velocity", label: "Avg Exit Velo" },
    { key: "chase_percent", label: "Chase %" },
    { key: "whiff_percent", label: "Whiff %" },
    { key: "k_percent", label: "K %" },
    { key: "bb_percent", label: "BB %" },
    { key: "brl_percent", label: "Barrel %" },
    { key: "hard_hit_percent", label: "Hard-Hit %" },
  ];

  // --- Projected percentiles for unqualified players ---
  // For players below the qualification threshold, Savant's percentile-rankings endpoint
  // returns blanks. We reproduce its projected (hatched) percentiles ourselves:
  //   percentile = Phi((raw - mu) / sigma) * 100   (inverted for lower-is-better metrics)
  // raw values come from small leaderboard/statsapi fetches; mu/sigma from the qualified pop.
  // Maps each panel stat key -> where to read the player's raw value + the mu/sigma column.
  const PROJ_COLUMN = {
    xwoba: { src: "expected", field: "woba", popCol: "est_woba" },
    xba: { src: "expected", field: "avg", popCol: "est_ba" },
    xslg: { src: "expected", field: "slg", popCol: "est_slg" },
    exit_velocity: { src: "custom", col: "exit_velocity_avg" },
    brl_percent: { src: "custom", col: "barrel_batted_rate" },
    hard_hit_percent: { src: "custom", col: "hard_hit_percent" },
    k_percent: { src: "custom", col: "k_percent" },
    bb_percent: { src: "custom", col: "bb_percent" },
    whiff_percent: { src: "custom", col: "whiff_percent" },
    chase_percent: { src: "custom", col: "oz_swing_percent" },
    sprint_speed: { src: "custom", col: "sprint_speed" },
    fb_velocity: { src: "custom", col: "fastball_avg_speed" },
    xera: { src: "custom", col: "xera" },
    bat_speed: { src: "battracking", col: "avg_bat_speed" },
    squared_up_rate: { src: "battracking", col: "squared_up_per_swing" },
  };

  // Lower-is-better metrics: the z-score is negated so a low raw value maps to a high pct.
  const PROJ_INVERT = {
    batter: new Set(["k_percent", "whiff_percent", "chase_percent"]),
    pitcher: new Set(["xera", "xba", "xslg", "exit_velocity", "bb_percent", "brl_percent", "hard_hit_percent"]),
  };

  function getPercentileColor(pct) {
    const colors = [
      "#1c4485", "#1f5b9f", "#2a71b2", "#3b88bd", "#4f9cc8",
      "#66add1", "#81bdd9", "#a0cce1", "#bad5e2", "#cfd8dc",
      "#dfd1c9", "#eac0aa", "#edab8a", "#e8906b", "#e07551",
      "#d75c3d", "#cb4330", "#bc2c29", "#b52426", "#ae1c22",
    ];
    return colors[Math.min(19, Math.floor(pct / 5))];
  }

  function parseCSVLine(line) {
    const fields = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { current += '"'; i++; }
          else inQuotes = false;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  }

  function parsePercentileCSV(csvText) {
    const lines = csvText.trim().split("\n");
    if (lines.length < 2) return null;

    const headers = parseCSVLine(lines[0]);
    const yearData = {};

    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      const row = {};
      headers.forEach((h, idx) => { row[h] = values[idx] || ""; });
      yearData[row.year] = row;
    }

    return yearData;
  }

  async function fetchStatcastPercentiles(mlbId, type) {
    const cacheKey = `${mlbId}-${type}`;
    if (statcastCache.has(cacheKey)) return statcastCache.get(cacheKey);

    try {
      const result = await browser.runtime.sendMessage({
        type: "ocf-fetch-statcast",
        playerId: mlbId,
        playerType: type,
      });

      if (!result.ok) return null;
      const parsed = parsePercentileCSV(result.data);
      if (parsed) statcastCache.set(cacheKey, parsed);
      return parsed;
    } catch (e) {
      console.warn("[OCF] Statcast fetch failed:", e);
      return null;
    }
  }

  // Parse a Savant leaderboard CSV into { rows, byId } keyed by player_id (or id).
  function parseLeaderboardCSV(csvText) {
    const lines = csvText.trim().split("\n");
    if (lines.length < 2) return null;
    const headers = parseCSVLine(lines[0]).map((h) => h.replace(/^\uFEFF/, ""));
    const idKey = headers.includes("player_id") ? "player_id" : "id";
    const rows = [];
    const byId = {};
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      const row = {};
      headers.forEach((h, idx) => { row[h] = values[idx] != null ? values[idx] : ""; });
      rows.push(row);
      byId[String(row[idKey])] = row;
    }
    return { rows, byId };
  }

  // Standard normal CDF via an Abramowitz & Stegun erf approximation (~1e-7 accuracy).
  function normCdf(z) {
    const sign = z < 0 ? -1 : 1;
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
  }

  function computeMuSigma(rows, col, mask) {
    const vals = [];
    for (const r of rows) {
      const id = String(r.player_id != null ? r.player_id : r.id);
      if (mask && !mask.has(id)) continue;
      const v = parseFloat(r[col]);
      if (!isNaN(v)) vals.push(v);
    }
    if (vals.length < 2) return null;
    const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mu) * (b - mu), 0) / vals.length);
    return sd > 0 ? { mu, sd } : null;
  }

  const scLeaderboardCache = new Map();
  const expectedStatsCache = new Map();
  const projStatsCache = new Map();

  async function fetchScLeaderboard(board, type, year) {
    const cacheKey = `${board}-${type}-${year}`;
    if (scLeaderboardCache.has(cacheKey)) return scLeaderboardCache.get(cacheKey);
    let parsed = null;
    try {
      const result = await browser.runtime.sendMessage({
        type: "ocf-fetch-sc-leaderboard", board, playerType: type, year: String(year),
      });
      if (result && result.ok && result.data) parsed = parseLeaderboardCSV(result.data);
    } catch (e) {
      console.warn("[OCF] Savant leaderboard fetch failed:", e);
    }
    scLeaderboardCache.set(cacheKey, parsed);
    return parsed;
  }

  async function fetchExpectedStats(mlbId, type, year) {
    const cacheKey = `${mlbId}-${type}-${year}`;
    if (expectedStatsCache.has(cacheKey)) return expectedStatsCache.get(cacheKey);
    let value = null;
    try {
      const result = await browser.runtime.sendMessage({
        type: "ocf-fetch-expected-stats", playerId: mlbId, playerType: type, year: String(year),
      });
      if (result && result.ok) value = result.data;
    } catch (e) {
      console.warn("[OCF] Expected-stats fetch failed:", e);
    }
    expectedStatsCache.set(cacheKey, value);
    return value;
  }

  // Shared per-(type, season) mu/sigma + the raw-value leaderboards (cached once per session).
  async function getProjStats(type, year) {
    const cacheKey = `${type}-${year}`;
    if (projStatsCache.has(cacheKey)) return projStatsCache.get(cacheKey);
    const [expBoard, custom, bat] = await Promise.all([
      fetchScLeaderboard("expected", type, year),
      fetchScLeaderboard("custom", type, year),
      type === "batter" ? fetchScLeaderboard("bat-tracking", type, year) : Promise.resolve(null),
    ]);
    if (!expBoard || !custom) { projStatsCache.set(cacheKey, null); return null; }
    const qIds = new Set(expBoard.rows.map((r) => String(r.player_id)));
    const stats = {};
    for (const [key, cfg] of Object.entries(PROJ_COLUMN)) {
      let ms;
      if (cfg.src === "expected") ms = computeMuSigma(expBoard.rows, cfg.popCol, null);
      else if (cfg.src === "battracking") ms = bat ? computeMuSigma(bat.rows, cfg.col, qIds) : null;
      else ms = computeMuSigma(custom.rows, cfg.col, qIds);
      if (ms) stats[key] = ms;
    }
    const result = { stats, custom, bat };
    projStatsCache.set(cacheKey, result);
    return result;
  }

  // Panel stat keys we can compute a projection for (i.e. that have a PROJ_COLUMN mapping).
  function projectableKeys(pitcher) {
    return (pitcher ? PITCHING_PERCENTILE_STATS : [...BATTING_PERCENTILE_STATS, ...SPEED_PERCENTILE_STATS])
      .map((s) => s.key).filter((k) => PROJ_COLUMN[k]);
  }

  // True if `row` still has unqualified (blank) cells we can project. Lets the year dropdown
  // decide whether a season needs the loading skeleton + a projections fetch.
  function hasUnfilledProjections(row, pitcher) {
    if (!row || row._enriched) return false;
    return projectableKeys(pitcher).some((k) => isNaN(parseInt(row[k], 10)));
  }

  // Fill blank (unqualified) percentile cells in one season's row with computed projections,
  // mutating yearData in place and tagging projected keys via row._projected. `year` defaults
  // to the latest season; pass an explicit year to enrich a historical season on demand (the
  // year dropdown does this lazily). Idempotent via row._enriched, and a no-op (no network)
  // for fully-qualified seasons, which have no blank cells.
  async function enrichWithProjections(yearData, mlbId, pitcher, year) {
    if (!yearData) return;
    if (year == null) {
      const years = Object.keys(yearData).sort((a, b) => b - a);
      if (!years.length) return;
      year = years[0];
    }
    const row = yearData[year];
    if (!row || row._enriched) return;
    row._enriched = true;
    const type = pitcher ? "pitcher" : "batter";
    const panelKeys = projectableKeys(pitcher);
    const blanks = panelKeys.filter((k) => isNaN(parseInt(row[k], 10)));
    if (!blanks.length) return;

    const needExpected = blanks.some((k) => PROJ_COLUMN[k].src === "expected");
    const [proj, exp] = await Promise.all([
      getProjStats(type, year),
      needExpected ? fetchExpectedStats(mlbId, type, year) : Promise.resolve(null),
    ]);
    if (!proj) return;

    const cRow = proj.custom.byId[String(mlbId)];
    const bRow = proj.bat ? proj.bat.byId[String(mlbId)] : null;
    const invert = PROJ_INVERT[type];
    const projected = row._projected instanceof Set ? row._projected : new Set();
    for (const key of blanks) {
      const cfg = PROJ_COLUMN[key];
      const ms = proj.stats[key];
      if (!ms) continue;
      let raw;
      if (cfg.src === "expected") raw = exp ? exp[cfg.field] : undefined;
      else if (cfg.src === "battracking") raw = bRow ? parseFloat(bRow[cfg.col]) : undefined;
      else raw = cRow ? parseFloat(cRow[cfg.col]) : undefined;
      if (raw == null || isNaN(raw)) continue;
      let z = (raw - ms.mu) / ms.sd;
      if (invert.has(key)) z = -z;
      const pct = Math.max(0, Math.min(100, Math.round(normCdf(z) * 100)));
      row[key] = String(pct);
      projected.add(key);
    }
    if (projected.size) row._projected = projected;
  }

  const prospectCache = new Map();

  async function fetchProspectSavant(mlbId) {
    if (prospectCache.has(mlbId)) return prospectCache.get(mlbId);
    try {
      const result = await browser.runtime.sendMessage({
        type: "ocf-fetch-prospect-savant",
        playerId: mlbId,
      });
      const data = result && result.ok ? result.data : null;
      const value = data && Object.keys(data).length ? data : null;
      prospectCache.set(mlbId, value);
      return value;
    } catch (e) {
      console.warn("[OCF] ProspectSavant fetch failed:", e);
      return null;
    }
  }

  // ProspectSavant rolling-data is PER-GAME (not pre-smoothed) and per-season. We cache the
  // raw per-game series and compute a trailing N-game average on demand for each selectable
  // window, then feed the existing drawRollingChart renderer.
  const prospectRollingCache = new Map();
  const PROSPECT_ROLLING_WINDOW = 20;

  async function fetchProspectRolling(mlbId, season) {
    const cacheKey = `${mlbId}-${season}`;
    if (prospectRollingCache.has(cacheKey)) return prospectRollingCache.get(cacheKey);
    let games = null;
    try {
      const result = await browser.runtime.sendMessage({
        type: "ocf-fetch-prospect-rolling",
        playerId: mlbId,
        season,
        playerType: "batter",
      });
      if (result && result.ok && Array.isArray(result.data)) {
        games = result.data
          .filter((g) => g && g.game_date != null && g.xwoba != null && !isNaN(parseFloat(g.xwoba)))
          .map((g) => ({ xwoba: parseFloat(g.xwoba), abs: Number(g.abs) > 0 ? Number(g.abs) : 1, date: String(g.game_date) }))
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      }
    } catch (e) {
      console.warn("[OCF] ProspectSavant rolling fetch failed:", e);
    }
    prospectRollingCache.set(cacheKey, games);
    return games;
  }

  // Trailing N-game AB-weighted rolling xwOBA; first point lands once N games exist.
  function computeRollingSeries(games, window) {
    const out = [];
    for (let i = window - 1; i < games.length; i++) {
      let num = 0, den = 0;
      for (let j = i - window + 1; j <= i; j++) {
        num += games[j].xwoba * games[j].abs;
        den += games[j].abs;
      }
      if (den > 0) out.push({ xwoba: num / den, max_game_date: games[i].date });
    }
    return out;
  }

  // Savant rows ProspectSavant never provides for MiLB (no bat-tracking / no xERA) -> hidden
  // in the MiLB view rather than shown as permanent "NOT QUALIFIED".
  const PS_UNAVAILABLE_STATS = new Set(["bat_speed", "squared_up_rate", "xera"]);

  // PS percentile field (0-1 decimal) -> existing Savant stat key (bar renderer keys off these)
  const PS_PCT_TO_SAVANT = {
    xwoba_p: "xwoba", xba_p: "xba", xslg_p: "xslg",
    ev_p: "exit_velocity", barrelbbe_p: "brl_percent", hhrate_p: "hard_hit_percent",
    chaserate_p: "chase_percent", whiffrate_p: "whiff_percent",
    krate_p: "k_percent", bbrate_p: "bb_percent",
    spd_p: "sprint_speed",   // batters
    velo_p: "fb_velocity",   // pitchers
  };

  // Batted-ball (Statcast tracking) derived stats. When a player's MiLB park/feed has
  // no batted-ball tracking, ProspectSavant reports these percentiles as a literal 0
  // (not null) even though the underlying value is missing (bip === 0). Treat that as
  // "no data" (NQ) rather than rendering a misleading 0th-percentile bar.
  const PS_BATTED_BALL_KEYS = new Set([
    "xwoba", "xba", "xslg", "exit_velocity", "brl_percent", "hard_hit_percent",
  ]);

  function normalizeProspectRow(row) {
    const data = {};
    const noBattedBall = Number(row.bip) === 0;
    for (const [psKey, savantKey] of Object.entries(PS_PCT_TO_SAVANT)) {
      if (noBattedBall && PS_BATTED_BALL_KEYS.has(savantKey)) continue;
      const v = row[psKey];
      if (v != null && !isNaN(v)) data[savantKey] = String(Math.round(v * 100));
    }
    return data;
  }

  const MILB_LEVEL_ORDER = { MLB: 7, AAA: 6, AA: 5, "A+": 4, A: 3, "A-": 2, R: 1 };

  function prospectEntries(psData, pitcher) {
    return Object.entries(psData)
      .map(([key, row]) => {
        const us = key.indexOf("_");
        const season = key.slice(0, us);
        const level = key.slice(us + 1);
        return {
          key, season, level, source: "MiLB", pitcher,
          label: `${season} ${level}`,
          data: normalizeProspectRow(row),
          fv: row.fv != null ? String(row.fv) : null,
        };
      })
      .sort((a, b) =>
        b.season - a.season ||
        (MILB_LEVEL_ORDER[b.level] || 0) - (MILB_LEVEL_ORDER[a.level] || 0)
      );
  }

  // Mix a palette hex toward white by `frac` (0 = unchanged, 1 = white). Used to build the
  // pastel two-tone diagonal hatch Savant draws for projected (unqualified) bars.
  function lightenColor(hex, frac) {
    const m = hex.replace("#", "");
    const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
    const mix = (c) => Math.round(c + (255 - c) * frac);
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
  }

  // Hatch for projected (unqualified) bars: thin diagonal lines in --ocf-hatch-line, which is
  // a translucent dark on dark theme and translucent white on light theme (so the hatch reads
  // like Savant's "cut to the background" look in both). Paired with background-size below, the
  // pattern is pinned to a fixed pixel grid so every line is perfectly, evenly spaced — a plain
  // repeating-linear-gradient drifts off-grid at this scale and looks raggedly hand-drawn.
  const PROJECTED_HATCH = "repeating-linear-gradient(-45deg, var(--ocf-hatch-line) 0, var(--ocf-hatch-line) 1px, transparent 1px, transparent 50%)";
  const PROJECTED_HATCH_SIZE = "6px 6px";

  function renderBars(panel, data) {
    const deferred = [];
    const projected = data && data._projected instanceof Set ? data._projected : null;
    panel.querySelectorAll(".ocf-statcast-row[data-stat]").forEach((row) => {
      const key = row.dataset.stat;
      const pct = parseInt(data ? data[key] : "", 10);
      const fill = row.querySelector(".ocf-statcast-fill");
      const label = row.querySelector(".ocf-statcast-pct");
      // Clear any leftover lazy-load skeleton state before (re)rendering this row.
      row.querySelector(".ocf-statcast-skeleton")?.remove();
      fill.style.display = "";
      row.querySelector(".ocf-statcast-label").classList.remove("ocf-statcast-label--loading");
      const isProj = !!(projected && projected.has(key));
      if (isNaN(pct)) {
        fill.style.width = "0%"; fill.style.background = "transparent";
        fill.style.backgroundImage = "none";
        label.textContent = ""; label.style.display = "none";
        row.removeAttribute("title");
        const lbl = row.querySelector(".ocf-statcast-label");
        lbl.classList.add("ocf-statcast-label--nq");
        lbl.classList.remove("ocf-statcast-label--qualified");
      } else {
        const color = getPercentileColor(pct);
        const fresh = !fill.style.width || fill.style.width === "0%";
        // Projected rows mirror Savant: hatched bar, no percentile bubble (the value lives
        // in the hover tooltip instead). Qualified rows keep the solid bubble.
        if (isProj) {
          label.style.display = "none"; label.textContent = "";
          row.title = `Projected ${pct}th percentile (below qualification threshold)`;
        } else {
          label.style.display = ""; label.textContent = pct; label.style.background = color;
          label.style.textShadow = pct >= 35 && pct <= 60 ? "0 0 2px rgba(0,0,0,0.9)" : "none";
          row.removeAttribute("title");
        }
        if (isProj) {
          fill.style.background = lightenColor(color, 0.4); // pastel base under the hatch
          fill.style.backgroundImage = PROJECTED_HATCH;
          fill.style.backgroundSize = PROJECTED_HATCH_SIZE;
        } else {
          fill.style.background = color; // shorthand resets background-image + size
        }
        if (fresh) {
          fill.style.width = "0%";
          if (!isProj) label.style.left = "0%";
          deferred.push({ fill, label, pct, isProj });
        } else {
          fill.style.width = Math.max(pct, 6) + "%";
          if (!isProj) label.style.left = Math.max(pct, 4) + "%";
        }
        const lbl = row.querySelector(".ocf-statcast-label");
        lbl.classList.remove("ocf-statcast-label--nq");
        lbl.classList.add("ocf-statcast-label--qualified");
      }
    });
    if (deferred.length) {
      requestAnimationFrame(() => {
        for (const { fill, label, pct, isProj } of deferred) {
          fill.style.width = Math.max(pct, 6) + "%";
          if (!isProj) label.style.left = Math.max(pct, 4) + "%";
        }
      });
    }
  }

  // Put every stat row into the panel's default shimmer-skeleton state (dimmed label, no
  // "NOT QUALIFIED", a shimmer in the track) while a historical season's projected
  // percentiles load. renderBars() clears this state when it (re)renders each row.
  function setRowsLoading(panel) {
    panel.querySelectorAll(".ocf-statcast-row[data-stat]").forEach((row) => {
      const fill = row.querySelector(".ocf-statcast-fill");
      const pct = row.querySelector(".ocf-statcast-pct");
      const lbl = row.querySelector(".ocf-statcast-label");
      const track = row.querySelector(".ocf-statcast-track");
      // Collapse the fill back to 0% so renderBars treats it as "fresh" and re-runs the
      // grow animation once the projected percentiles land (instead of jumping to width).
      if (fill) { fill.style.display = "none"; fill.style.width = "0%"; }
      if (pct) { pct.style.display = "none"; pct.textContent = ""; pct.style.left = "0%"; }
      row.removeAttribute("title");
      lbl.classList.remove("ocf-statcast-label--nq", "ocf-statcast-label--qualified");
      lbl.classList.add("ocf-statcast-label--loading");
      if (track && !track.querySelector(".ocf-statcast-skeleton")) {
        const sk = document.createElement("div");
        sk.className = "ocf-statcast-skeleton";
        track.appendChild(sk);
      }
    });
  }

  function renderSourcePanel(panel, entries, selectedKey, playerName, mlbId, ctx) {
    const entry = entries.find((e) => e.key === selectedKey) || entries[0];
    const pitcher = entry.pitcher;
    const urlName = makeUrlName(playerName);
    const isMiLB = entry.source === "MiLB";
    const title = isMiLB ? `${entry.level} Percentile Rankings` : "MLB Percentile Rankings";
    const scHref = isMiLB
      ? `https://prospectsavant.com/player/${mlbId}`
      : `https://baseballsavant.mlb.com/savant-player/${urlName}-${mlbId}?stats=${pitcher ? "statcast-r-pitching-mlb" : "statcast-r-hitting-mlb"}`;

    // ProspectSavant never provides these (no MiLB bat-tracking / xERA), so hide the rows
    // entirely in the MiLB view instead of showing permanent "NOT QUALIFIED".
    const filterMilb = (stats) => isMiLB ? stats.filter((s) => !PS_UNAVAILABLE_STATS.has(s.key)) : stats;
    const battingStats = filterMilb([...BATTING_PERCENTILE_STATS, ...SPEED_PERCENTILE_STATS]);
    const pitchingStats = filterMilb(PITCHING_PERCENTILE_STATS);
    const bodyHTML = pitcher
      ? `<div class="ocf-statcast-section-title">Statcast</div>${buildStatRowsHTML(pitchingStats)}`
      : buildStatRowsHTML(battingStats);

    panel.innerHTML = `
      <div class="ocf-statcast-header">
        <div class="ocf-statcast-header-top">
          <select class="ocf-statcast-year"></select>
          <span class="ocf-statcast-title">${title}</span>
          <a class="ocf-statcast-savant-link" href="${scHref}" target="_blank" rel="noopener noreferrer">
            <mat-icon class="mat-icon material-icons" style="font-size:14px;width:14px;height:14px;">open_in_new</mat-icon>
            ${isMiLB ? "ps" : "sc"}
          </a>
        </div>
        <div class="ocf-statcast-axis">
          <span class="ocf-statcast-label"></span>
          <div class="ocf-statcast-axis-labels">
            <span class="ocf-statcast-axis--poor">POOR</span>
            <span class="ocf-statcast-axis--avg">AVERAGE</span>
            <span class="ocf-statcast-axis--great">GREAT</span>
          </div>
        </div>
      </div>
      <div class="ocf-statcast-body">${bodyHTML}</div>
    `;

    panel.dataset.source = entry.source;
    if (entry.source === "MiLB") { panel.dataset.noFgData = "true"; updatePanelFullWidth(panel); }
    panel._entries = panel._entries || {};
    panel._entries[entry.source] = entries;
    panel._playerName = playerName;
    panel._mlbId = mlbId;
    panel._pitcher = pitcher;
    renderBars(panel, entry.data);
    wireSourceSelect(panel);
    return entry;
  }

  function wireSourceSelect(panel) {
    const select = panel.querySelector(".ocf-statcast-year");
    if (!select) return;
    const source = panel.dataset.source;
    const entries = panel._entries[source];
    if (!entries) return;
    const current = panel.dataset.selectedKey || entries[0].key;
    panel.dataset.selectedKey = current;

    select.innerHTML = "";
    for (const e of entries) {
      const o = document.createElement("option");
      o.value = e.key; o.textContent = e.label; select.appendChild(o);
    }
    select.value = current;

    // default-year vs full-width parity with the MLB panel
    panel.dataset.defaultStatcastYear = entries[0].key;
    panel.dataset.statcastYear = current;
    updatePanelComposition(panel); // Task 7

    select.onchange = () => {
      const val = select.value;
      panel.dataset.selectedKey = val;
      panel.dataset.statcastYear = val;
      const e = entries.find((x) => x.key === val);
      renderBars(panel, e.data);
      appendFutureValue(panel, e);
      updatePanelComposition(panel); // Task 7
      if (e.source === "MiLB") updateMilbRolling(panel, e);
    };
  }

  function updatePanelComposition(panel) {
    const isMiLB = panel.dataset.source === "MiLB";
    if (isMiLB) {
      // FanGraphs has no MiLB data: remove its section and force full-width.
      panel.querySelector(".ocf-fangraphs-divider")?.remove();
      panel.querySelector(".ocf-fangraphs-section")?.remove();
      panel.dataset.noFgData = "true";
    } else if (panel._pitcher && features.fangraphsPanel) {
      // MLB pitcher: ensure the FanGraphs section exists.
      if (!panel.querySelector(".ocf-fangraphs-section")) {
        appendFangraphsSection(panel, panel._mlbId);
      }
      panel.dataset.noFgData = "false";
    } else {
      panel.dataset.noFgData = "true"; // MLB hitter, as today
    }
    updatePanelFullWidth(panel);
  }
  // ProspectSavant does not compute iso_p / wrcplus_p (always 0 or null, even for elite
  // ProspectSavant doesn't compute usable ISO/wRC+/Max-EV percentiles for the extras
  // group, so we drop it entirely and instead append the Future Value grade (when > 0)
  // under the last stat row (Sprint Speed for hitters).
  // Future Value is a 20-80 scouting grade. The panel's percentile palette washes out in
  // the middle (where most prospects, FV 45-50, land), so use a dedicated ramp that stays
  // saturated and legible across the meaningful 40-60 band. Warmer = better; "+" bumps up.
  function fvColor(fv) {
    const n = parseInt(fv, 10);
    if (isNaN(n) || n <= 0) return null;
    const adj = /\+/.test(String(fv)) ? n + 2 : n;
    if (adj < 38) return "#3f6fa8";   // <=35  org / depth        (blue)
    if (adj < 43) return "#5a92bf";   // 40    fringe / role      (lighter blue)
    if (adj < 48) return "#c98f3f";   // 45    bench / 2nd-div    (amber)
    if (adj < 53) return "#d4783c";   // 50    avg regular        (orange)
    if (adj < 58) return "#d2602f";   // 55    above-avg regular  (deep orange)
    if (adj < 63) return "#c84a2c";   // 60    All-Star           (orange-red)
    if (adj < 70) return "#b63326";   // 65    star               (red)
    return "#9e1620";                 // 70+   elite              (deep red)
  }

  function appendFutureValue(panel, entry) {
    panel.querySelector(".ocf-ps-fv-row")?.remove();
    if (!entry || entry.source !== "MiLB") return;
    const fv = entry.fv;
    if (!fv || !(parseInt(fv, 10) > 0)) return;
    const body = panel.querySelector(".ocf-statcast-body");
    if (!body) return;
    const color = fvColor(fv);
    const badgeStyle = color ? ` style="background:${color};color:#fff;"` : "";
    const row = document.createElement("div");
    row.className = "ocf-statcast-row ocf-ps-fv-row";
    row.innerHTML = `<span class="ocf-statcast-label ocf-statcast-label--qualified">Future Value</span><span class="ocf-ps-fv-grade"${badgeStyle}>${fv}</span>`;
    body.appendChild(row);
  }

  function removeStatcastPanel() {
    const existing = document.querySelector(".ocf-statcast-panel");
    if (existing) {
      if (existing._dismissObserver) existing._dismissObserver.disconnect();
      if (existing._resizeHandler) {
        window.removeEventListener("resize", existing._resizeHandler);
        window.removeEventListener("scroll", existing._resizeHandler, true);
      }
      existing.remove();
    }
  }

  function buildStatRowsHTML(stats) {
    return stats.map(({ key, label }) => `
      <div class="ocf-statcast-row" data-stat="${key}">
        <span class="ocf-statcast-label">${label}</span>
        <div class="ocf-statcast-track">
          <div class="ocf-statcast-fill"></div>
          <span class="ocf-statcast-pct"></span>
        </div>
      </div>`).join("");
  }

  function populateStatcastPanel(panel, yearData, playerName, mlbId, pitcher) {
    const years = Object.keys(yearData).sort((a, b) => b - a);
    if (years.length === 0) return;

    let currentYear = years[0];
    const urlName = makeUrlName(playerName);
    const savantTab = pitcher ? "statcast-r-pitching-mlb" : "statcast-r-hitting-mlb";

    const bodyHTML = pitcher
      ? `<div class="ocf-statcast-section-title">Statcast</div>
         ${buildStatRowsHTML(PITCHING_PERCENTILE_STATS)}`
      : buildStatRowsHTML([...BATTING_PERCENTILE_STATS, ...SPEED_PERCENTILE_STATS]);

    panel.innerHTML = `
      <div class="ocf-statcast-header">
        <div class="ocf-statcast-header-top">
          <select class="ocf-statcast-year"></select>
          <span class="ocf-statcast-title">MLB Percentile Rankings</span>
          <a class="ocf-statcast-savant-link" href="https://baseballsavant.mlb.com/savant-player/${urlName}-${mlbId}?stats=${savantTab}" target="_blank" rel="noopener noreferrer">
            <mat-icon class="mat-icon material-icons" style="font-size:14px;width:14px;height:14px;">open_in_new</mat-icon>
            sc
          </a>
          <div class="ocf-statcast-load-spinner" style="display:none;"></div>
        </div>
        <div class="ocf-statcast-axis">
          <span class="ocf-statcast-label"></span>
          <div class="ocf-statcast-axis-labels">
            <span class="ocf-statcast-axis--poor">POOR</span>
            <span class="ocf-statcast-axis--avg">AVERAGE</span>
            <span class="ocf-statcast-axis--great">GREAT</span>
          </div>
        </div>
      </div>
      <div class="ocf-statcast-body">
        ${bodyHTML}
      </div>
    `;

    const select = panel.querySelector(".ocf-statcast-year");
    for (const year of years) {
      const option = document.createElement("option");
      option.value = year;
      option.textContent = year;
      select.appendChild(option);
    }
    select.value = currentYear;
    panel.dataset.defaultStatcastYear = currentYear;
    panel.dataset.statcastYear = currentYear;
    if (!pitcher) {
      panel.dataset.noFgData = "true";
      updatePanelFullWidth(panel);
    }

    function updateBars() {
      renderBars(panel, yearData[currentYear]);
    }

    updateBars();

    const spinner = panel.querySelector(".ocf-statcast-load-spinner");
    select.addEventListener("change", () => {
      currentYear = select.value;
      panel.dataset.statcastYear = currentYear;
      updatePanelFullWidth(panel);
      // Historical seasons are enriched lazily (only the default year is filled before first
      // render). For an unqualified season, show the default loading state (shimmer rows +
      // top-right spinner) while we fetch its projected percentiles, then render the bars.
      const year = currentYear;
      if (hasUnfilledProjections(yearData[year], pitcher)) {
        if (spinner) spinner.style.display = "";
        setRowsLoading(panel);
        enrichWithProjections(yearData, mlbId, pitcher, year).then(() => {
          if (currentYear !== year || !document.contains(panel)) return;
          if (spinner) spinner.style.display = "none";
          updateBars();
        });
      } else {
        if (spinner) spinner.style.display = "none";
        updateBars();
      }
    });
  }

  function showStatcastSkeleton(overlayPane) {
    ++statcastPanelRequestId;
    removeStatcastPanel();

    // Default to batter skeleton (more stats = better placeholder)
    const skeletonStats = [...BATTING_PERCENTILE_STATS, ...SPEED_PERCENTILE_STATS];

    const panel = document.createElement("div");
    panel.className = "ocf-statcast-panel";
    const skeletonRows = skeletonStats
      .map(({ label }) => `
        <div class="ocf-statcast-row">
          <span class="ocf-statcast-label" style="opacity:0.3">${label}</span>
          <div class="ocf-statcast-track"><div class="ocf-statcast-skeleton"></div></div>
        </div>
      `).join("");
    panel.innerHTML = `
      <div class="ocf-statcast-header">
        <div class="ocf-statcast-header-top">
          <span class="ocf-statcast-title">MLB Percentile Rankings</span>
          <div class="ocf-statcast-spinner" style="width:16px;height:16px;border-width:2px;margin-left:auto;"></div>
        </div>
        <div class="ocf-statcast-axis">
          <span class="ocf-statcast-label"></span>
          <div class="ocf-statcast-axis-labels">
            <span class="ocf-statcast-axis--poor">POOR</span>
            <span class="ocf-statcast-axis--avg">AVERAGE</span>
            <span class="ocf-statcast-axis--great">GREAT</span>
          </div>
        </div>
      </div>
      <div class="ocf-statcast-body">
        ${skeletonRows}
      </div>
    `;
    document.body.appendChild(panel);

    function updatePosition() {
      const rect = overlayPane.getBoundingClientRect();
      const panelWidth = 340;
      const gap = 5;

      panel.style.left = "";
      panel.style.right = "";

      if (window.innerWidth - rect.right >= panelWidth + gap + 8) {
        panel.style.left = (rect.right + gap) + "px";
      } else if (rect.left >= panelWidth + gap + 8) {
        panel.style.left = (rect.left - panelWidth - gap) + "px";
      } else {
        panel.style.right = "8px";
      }

      // Size to content with a min floor and a viewport-aware max cap,
      // rather than slaving the panel to the (variable) modal height.
      const MIN_H = 360;
      const HARD_MAX = 620;
      let top = Math.max(8, Math.min(rect.top, window.innerHeight - MIN_H - 8));
      const maxH = Math.min(HARD_MAX, window.innerHeight - top - 8);
      panel.style.top = top + "px";
      panel.style.height = "";
      panel.style.minHeight = MIN_H + "px";
      panel.style.maxHeight = maxH + "px";
    }

    updatePosition();
    panel.classList.add("ocf-statcast-panel--visible");

    // Dismiss when overlay is removed
    const dismissParent = overlayPane.parentNode;
    if (dismissParent) {
      const dismissObserver = new MutationObserver(() => {
        if (!dismissParent.contains(overlayPane)) {
          removeStatcastPanel();
        }
      });
      dismissObserver.observe(dismissParent, { childList: true });
      panel._dismissObserver = dismissObserver;
    }

    let rafPending = false;
    const resizeHandler = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (document.contains(overlayPane)) {
          updatePosition();
          if (panel._rollingSection && panel._rollingSection._redraw) {
            panel._rollingSection._redraw();
          }
        }
      });
    };
    window.addEventListener("resize", resizeHandler);
    window.addEventListener("scroll", resizeHandler, true);
    panel._resizeHandler = resizeHandler;

    return panel;
  }

  // Replace the loading skeleton with a clear message when neither source has data, instead
  // of leaving the spinner running forever.
  function showStatcastNoData(panel, isMinors) {
    panel._rollingSection = null;
    panel.dataset.noFgData = "true";
    const msg = isMinors
      ? "No MiLB or MLB Statcast data available for this player."
      : "No MLB Statcast data available for this player.";
    panel.innerHTML = `
      <div class="ocf-statcast-header">
        <div class="ocf-statcast-header-top">
          <span class="ocf-statcast-title">Percentile Rankings</span>
        </div>
      </div>
      <div class="ocf-statcast-empty">${msg}</div>
    `;
  }

  async function populateStatcastFromModal(panel, playerName, positionText, teamHint, isMinors) {
    const requestId = ++statcastPanelRequestId;
    const pitcher = isPitcher(positionText);
    // Reset cached per-source entries so a reused panel (modal recycled for a new
    // player) never shows the previous player's data when toggling sources.
    panel._entries = {};
    delete panel.dataset.selectedKey;

    // If pitcher, rebuild the skeleton body with pitcher stats + FanGraphs shimmer
    if (pitcher) {
      const body = panel.querySelector(".ocf-statcast-body");
      if (body) {
        body.innerHTML = `
          <div class="ocf-statcast-section-title">Statcast</div>
          ${buildStatRowsHTML(PITCHING_PERCENTILE_STATS).replace(/<div class="ocf-statcast-fill"><\/div>\s*<span class="ocf-statcast-pct"><\/span>/g,
            '<div class="ocf-statcast-skeleton"></div>')}
        `;
      }
      if (features.fangraphsPanel) {
        const fgDivider = document.createElement("div");
        fgDivider.className = "ocf-fangraphs-divider";
        panel.appendChild(fgDivider);
        const fgShimmer = document.createElement("div");
        fgShimmer.className = "ocf-fangraphs-section";
        fgShimmer.innerHTML = `<div class="ocf-fangraphs-header"><span class="ocf-fangraphs-title">FanGraphs</span></div>${FANGRAPHS_METRICS.map((m) => `<div class="ocf-fangraphs-row"><span class="ocf-statcast-label" style="opacity:0.3">${m.label}</span><div class="ocf-statcast-track"><div class="ocf-statcast-skeleton"></div></div><span class="ocf-fangraphs-value-right"></span></div>`).join("")}`;
        panel.appendChild(fgShimmer);
      }
    } else {
      // Show rolling chart shimmer placeholder for hitters while loading
      const divider = document.createElement("div");
      divider.className = "ocf-rolling-divider";
      panel.appendChild(divider);
      const shimmerSection = document.createElement("div");
      shimmerSection.className = "ocf-rolling-section";
      shimmerSection.innerHTML = `<div class="ocf-rolling-header"><span class="ocf-rolling-title">Rolling xwOBA</span></div><div class="ocf-rolling-shimmer"></div>`;
      panel.appendChild(shimmerSection);
    }

    const mlbId = await lookupMlbId(playerName, teamHint);
    if (requestId !== statcastPanelRequestId || !document.contains(panel)) return;
    if (!mlbId) { showStatcastNoData(panel, isMinors); return; }

    if (isMinors && features.prospectSavantPanel) {
      const psData = await fetchProspectSavant(mlbId);
      if (requestId !== statcastPanelRequestId || !document.contains(panel)) return;
      if (psData) {
        const entries = prospectEntries(psData, pitcher);
        renderSourcePanel(panel, entries, entries[0].key, playerName, mlbId, { isMinors });
        appendFutureValue(panel, entries[0]);
        updateMilbRolling(panel, entries[0]);
        return;
      }
      // fall through to MLB if PS empty despite the flag
    }

    // Fetch percentiles and rolling data in parallel
    const [yearData, rollingData] = await Promise.all([
      fetchStatcastPercentiles(mlbId, pitcher ? "pitcher" : "batter"),
      pitcher ? Promise.resolve(null) : fetchRollingData(mlbId),
    ]);
    if (requestId !== statcastPanelRequestId || !document.contains(panel)) return;
    if (!yearData) { showStatcastNoData(panel, isMinors); return; }

    // Fill projected (hatched) percentiles for unqualified players before first render.
    // No-op for qualified players (no blank cells -> no extra network).
    await enrichWithProjections(yearData, mlbId, pitcher);
    if (requestId !== statcastPanelRequestId || !document.contains(panel)) return;

    populateStatcastPanel(panel, yearData, playerName, mlbId, pitcher);

    // Append rolling xwOBA chart for hitters only
    if (!pitcher) {
      appendRollingSection(panel, rollingData);
    }

    // Append FanGraphs section for pitchers
    if (pitcher && features.fangraphsPanel) {
      appendFangraphsSection(panel, mlbId);
    }
  }

  // Map statcast row keys to FanGraphs player data keys + formatters
  const STATCAST_TO_FANGRAPHS = {
    xera:             { fg: "xera",         fmt: (v) => v.toFixed(2) },
    fb_velocity:      { fg: "fbv",          fmt: (v) => v.toFixed(1) },
    exit_velocity:    { fg: "ev",           fmt: (v) => v.toFixed(1) },
    k_percent:        { fg: "k_pct",        fmt: (v) => (v * 100).toFixed(1) + "%" },
    bb_percent:       { fg: "bb_pct",       fmt: (v) => (v * 100).toFixed(1) + "%" },
    chase_percent:    { fg: "chase_pct",     fmt: (v) => (v * 100).toFixed(1) + "%" },
    whiff_percent:    { fg: "whiff_pct",    fmt: (v) => (v * 100).toFixed(1) + "%" },
    brl_percent:      { fg: "barrel_pct",   fmt: (v) => (v * 100).toFixed(1) + "%" },
    hard_hit_percent: { fg: "hard_hit_pct", fmt: (v) => (v * 100).toFixed(1) + "%" },
  };

  function injectStatcastActualValues(panel, fgPlayer) {
    // Add actual value or empty placeholder to every statcast row so bars align
    panel.querySelectorAll(".ocf-statcast-row[data-stat]").forEach((row) => {
      if (row.querySelector(".ocf-statcast-actual")) return;
      const statKey = row.dataset.stat;
      const mapping = STATCAST_TO_FANGRAPHS[statKey];
      const val = mapping && fgPlayer ? fgPlayer[mapping.fg] : null;
      const span = document.createElement("span");
      span.className = "ocf-statcast-actual";
      span.textContent = val != null ? mapping.fmt(val) : "";
      row.appendChild(span);
    });
  }

  function updatePanelFullWidth(panel) {
    const year = panel.dataset.statcastYear;
    const defaultYear = panel.dataset.defaultStatcastYear;
    const isNonDefaultYear = year && defaultYear && year !== defaultYear;
    const noFgData = panel.dataset.noFgData === "true";
    if (isNonDefaultYear || noFgData) {
      panel.classList.add("ocf-statcast-full-width");
    } else {
      panel.classList.remove("ocf-statcast-full-width");
    }
  }

  // --- Rolling xwOBA Chart ---

  const rollingCache = new Map();

  async function fetchRollingData(mlbId) {
    if (rollingCache.has(mlbId)) return rollingCache.get(mlbId);
    try {
      const result = await browser.runtime.sendMessage({
        type: "ocf-fetch-rolling",
        playerId: mlbId,
      });
      if (!result.ok) return null;
      rollingCache.set(mlbId, result.data);
      return result.data;
    } catch (e) {
      console.warn("[OCF] Rolling fetch failed:", e);
      return null;
    }
  }

  function getRollingColor(xwoba, pitcher) {
    const stops = pitcher
      ? [
          { v: 0.210, r: 255, g: 0, b: 0 },
          { v: 0.300, r: 194, g: 194, b: 194 },
          { v: 0.320, r: 194, g: 194, b: 194 },
          { v: 0.340, r: 194, g: 194, b: 205 },
          { v: 0.410, r: 0, g: 0, b: 255 },
        ]
      : [
          { v: 0.210, r: 0, g: 0, b: 255 },
          { v: 0.300, r: 194, g: 194, b: 205 },
          { v: 0.320, r: 194, g: 194, b: 194 },
          { v: 0.340, r: 194, g: 194, b: 194 },
          { v: 0.410, r: 255, g: 0, b: 0 },
        ];
    if (xwoba <= stops[0].v) return `rgb(${stops[0].r},${stops[0].g},${stops[0].b})`;
    if (xwoba >= stops[4].v) return `rgb(${stops[4].r},${stops[4].g},${stops[4].b})`;
    for (let i = 0; i < stops.length - 1; i++) {
      if (xwoba <= stops[i + 1].v) {
        const t = (xwoba - stops[i].v) / (stops[i + 1].v - stops[i].v);
        const r = Math.round(stops[i].r + t * (stops[i + 1].r - stops[i].r));
        const g = Math.round(stops[i].g + t * (stops[i + 1].g - stops[i].g));
        const b = Math.round(stops[i].b + t * (stops[i + 1].b - stops[i].b));
        return `rgb(${r},${g},${b})`;
      }
    }
    return `rgb(255,0,0)`;
  }

  function formatRollingDate(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const day = d.getUTCDate();
    const suffix = [, "st", "nd", "rd"][day % 10 > 3 ? 0 : (day % 100 - day % 10 !== 10) * (day % 10)] || "th";
    return `${months[d.getUTCMonth()]} ${day}${suffix}`;
  }

  function drawRollingChart(canvas, data, tooltip, pitcher, animate = true) {
    if (!data || data.length === 0) return;

    const container = canvas.parentElement;
    const cssWidth = container.clientWidth;
    const cssHeight = container.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    canvas.style.width = cssWidth + "px";
    canvas.style.height = cssHeight + "px";

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const padLeft = 38;
    const padRight = 8;
    const padTop = 10;
    const padBottom = 10;
    const chartW = cssWidth - padLeft - padRight;
    const chartH = cssHeight - padTop - padBottom;

    const dataMax = Math.max(...data.map((d) => d.xwoba));
    const dataMin = Math.min(...data.map((d) => d.xwoba));
    const yMin = Math.min(0.150, Math.floor(dataMin * 10) / 10);
    const yMax = Math.max(0.530, Math.ceil(dataMax * 10) / 10 + 0.03);

    function xPos(i) { return padLeft + (i / (data.length - 1)) * chartW; }
    function yPos(val) { return padTop + (1 - (val - yMin) / (yMax - yMin)) * chartH; }

    // Cancel any reveal animation still running from a prior draw on this canvas
    if (canvas._rollAnim) { cancelAnimationFrame(canvas._rollAnim); canvas._rollAnim = null; }

    // Static-layer constants (theme colors, gridlines, LG AVG geometry) - frame-invariant
    const rootStyle = getComputedStyle(document.documentElement);
    const gridLineColor = rootStyle.getPropertyValue("--ocf-grid-line").trim() || "rgba(255,255,255,0.08)";
    const gridLabelColor = rootStyle.getPropertyValue("--ocf-grid-label").trim() || "rgba(255,255,255,0.3)";
    const gridValues = [];
    for (let v = Math.ceil(yMin * 10) / 10; v <= yMax; v = Math.round((v + 0.1) * 10) / 10) {
      gridValues.push(v);
    }
    const lgY = yPos(0.320);
    const tail = data.slice(-Math.max(1, Math.ceil(data.length * 0.1)));
    const aboveCount = tail.filter((d) => d.xwoba >= 0.320).length;
    const lgLabelBelow = aboveCount >= tail.length / 2;

    // Gridlines + league-average line, painted beneath the data line each frame
    function drawStatic() {
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      ctx.font = "9px Poppins, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (const gv of gridValues) {
        const gy = yPos(gv);
        ctx.strokeStyle = gridLineColor;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padLeft, gy);
        ctx.lineTo(padLeft + chartW, gy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = gridLabelColor;
        ctx.fillText(gv.toFixed(3), padLeft - 4, gy);
      }

      ctx.strokeStyle = "rgb(20,184,166)";
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, lgY);
      ctx.lineTo(padLeft + chartW, lgY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgb(20,184,166)";
      ctx.textAlign = "right";
      ctx.fillText("LG AVG", padLeft + chartW, lgY + (lgLabelBelow ? 11 : -7));
    }

    // Data line - colored segments revealed left-to-right up to fractional progress p (0..1)
    function drawLine(p) {
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      const segs = data.length - 1;
      const edge = p * segs;          // leading-edge position, in segment units
      const full = Math.floor(edge);  // count of fully-drawn segments
      const frac = edge - full;       // progress into the partial leading segment
      for (let i = 0; i < segs; i++) {
        if (i > full) break;
        const x1 = xPos(i);
        const y1 = yPos(data[i].xwoba);
        let x2, y2, midVal;
        if (i < full) {
          x2 = xPos(i + 1);
          y2 = yPos(data[i + 1].xwoba);
          midVal = (data[i].xwoba + data[i + 1].xwoba) / 2;
        } else {
          // partial leading segment: interpolate toward the next point
          const ev = data[i].xwoba + (data[i + 1].xwoba - data[i].xwoba) * frac;
          x2 = x1 + (xPos(i + 1) - x1) * frac;
          y2 = yPos(ev);
          midVal = (data[i].xwoba + ev) / 2;
        }
        ctx.strokeStyle = getRollingColor(midVal, pitcher);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }

    function renderFrame(p) {
      drawStatic();
      drawLine(p);
    }

    // Store data for tooltip hit testing (geometry is final from the first frame)
    canvas._rollingData = data;
    canvas._xPos = xPos;
    canvas._yPos = yPos;
    canvas._tooltip = tooltip;
    canvas._padLeft = padLeft;
    canvas._chartW = chartW;

    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduceMotion || data.length < 2) {
      renderFrame(1);
      return;
    }

    // Reveal the line left-to-right, matching the percentile bars' 0.3s grow-in
    const DURATION = 300;
    let start = null;
    function step(ts) {
      if (start === null) start = ts;
      const p = Math.min(1, (ts - start) / DURATION);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      renderFrame(eased);
      canvas._rollAnim = p < 1 ? requestAnimationFrame(step) : null;
    }
    canvas._rollAnim = requestAnimationFrame(step);
  }

  function handleRollingMouseMove(e) {
    const canvas = e.currentTarget;
    const data = canvas._rollingData;
    const tooltip = canvas._tooltip;
    if (!data || !tooltip) return;

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;

    // Find nearest point by x
    let closest = 0;
    let closestDist = Infinity;
    for (let i = 0; i < data.length; i++) {
      const px = canvas._xPos(i);
      const dist = Math.abs(mx - px);
      if (dist < closestDist) {
        closestDist = dist;
        closest = i;
      }
    }

    const dot = canvas._dot;
    if (closestDist > 20) {
      tooltip.classList.remove("ocf-rolling-tooltip--visible");
      if (dot) dot.classList.remove("ocf-rolling-dot--visible");
      return;
    }

    const pt = data[closest];
    const px = canvas._xPos(closest);
    const py = canvas._yPos(pt.xwoba);
    tooltip.innerHTML = `<div>xwOBA: <b>${pt.xwoba.toFixed(3)}</b></div><div>Last PA: ${formatRollingDate(pt.max_game_date)}</div>`;
    tooltip.classList.add("ocf-rolling-tooltip--visible");

    if (dot) {
      dot.style.left = px + "px";
      dot.style.top = py + "px";
      dot.style.background = getRollingColor(pt.xwoba, canvas._pitcher);
      dot.classList.add("ocf-rolling-dot--visible");
    }

    // Position tooltip, clamping horizontally within the canvas wrapper
    const wrapWidth = canvas.parentElement.clientWidth;
    const tipW = tooltip.offsetWidth;
    let left = px - tipW / 2;
    if (left < 0) left = 0;
    if (left + tipW > wrapWidth) left = wrapWidth - tipW;
    tooltip.style.left = left + "px";
    const tipH = tooltip.offsetHeight;
    const wrapHeight = canvas.parentElement.clientHeight;
    // Prefer placing above the point; flip below only if no room above
    const above = py - tipH - 8 >= 0;
    let top = above ? (py - tipH - 8) : (py + 8);
    if (top < 0) top = 0;
    if (top + tipH > wrapHeight) top = wrapHeight - tipH;
    tooltip.style.top = top + "px";
  }

  function handleRollingMouseLeave(e) {
    const tooltip = e.currentTarget._tooltip;
    const dot = e.currentTarget._dot;
    if (tooltip) tooltip.classList.remove("ocf-rolling-tooltip--visible");
    if (dot) dot.classList.remove("ocf-rolling-dot--visible");
  }

  function appendRollingSection(panel, rollingData) {
    const hasRollingData = rollingData && (rollingData.plate50?.length || rollingData.plate100?.length || rollingData.plate250?.length);
    if (hasRollingData) {
      appendRollingChart(panel, rollingData, false);
    } else {
      panel.querySelector(".ocf-rolling-divider")?.remove();
      panel.querySelector(".ocf-rolling-section")?.remove();
      const divider = document.createElement("div");
      divider.className = "ocf-rolling-divider";
      panel.appendChild(divider);
      const errSection = document.createElement("div");
      errSection.className = "ocf-rolling-section";
      const msg = rollingData ? "Not enough data yet" : "Unable to load rolling data";
      errSection.innerHTML = `<div class="ocf-rolling-header"><span class="ocf-rolling-title">Rolling xwOBA</span></div><div class="ocf-rolling-error">${msg}</div>`;
      panel.appendChild(errSection);
    }
  }

  function appendRollingChart(panel, rollingData, pitcher) {
    if (!rollingData || (!rollingData.plate50?.length && !rollingData.plate100?.length && !rollingData.plate250?.length)) return;

    // Remove any existing rolling section
    panel.querySelector(".ocf-rolling-divider")?.remove();
    panel.querySelector(".ocf-rolling-section")?.remove();

    const divider = document.createElement("div");
    divider.className = "ocf-rolling-divider";
    panel.appendChild(divider);

    const section = document.createElement("div");
    section.className = "ocf-rolling-section";

    const windows = [
      { key: "plate50", label: "50 PA" },
      { key: "plate100", label: "100 PA" },
      { key: "plate250", label: "250 PA" },
    ];

    section.innerHTML = `
      <div class="ocf-rolling-header">
        <span class="ocf-rolling-title">Rolling xwOBA</span>
        <div class="ocf-rolling-toggle">
          ${windows.map((w) => `<button data-window="${w.key}" class="${w.key === "plate50" ? "ocf-rolling-toggle--active" : ""}">${w.label}</button>`).join("")}
        </div>
      </div>
      <div class="ocf-rolling-canvas-wrap">
        <canvas></canvas>
        <div class="ocf-rolling-dot"></div>
        <div class="ocf-rolling-tooltip"></div>
      </div>
    `;
    panel.appendChild(section);

    const canvasEl = section.querySelector("canvas");
    const tooltipEl = section.querySelector(".ocf-rolling-tooltip");
    const dotEl = section.querySelector(".ocf-rolling-dot");
    canvasEl._dot = dotEl;
    canvasEl._pitcher = pitcher;
    let activeWindow = "plate50";

    function parseAndDraw(key, animate = true) {
      const arr = rollingData[key];
      if (!arr || arr.length === 0) return;
      // API returns rn=1 as most recent - reverse for chronological order
      const sorted = arr.slice().sort((a, b) => b.rn - a.rn);
      const parsed = sorted.map((d) => ({ xwoba: parseFloat(d.xwoba), max_game_date: d.max_game_date }));
      drawRollingChart(canvasEl, parsed, tooltipEl, pitcher, animate);
    }

    parseAndDraw(activeWindow);

    // PA toggle
    section.querySelector(".ocf-rolling-toggle").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-window]");
      if (!btn) return;
      section.querySelectorAll(".ocf-rolling-toggle button").forEach((b) => b.classList.remove("ocf-rolling-toggle--active"));
      btn.classList.add("ocf-rolling-toggle--active");
      activeWindow = btn.dataset.window;
      parseAndDraw(activeWindow);
    });

    // Tooltip events
    canvasEl.addEventListener("mousemove", handleRollingMouseMove);
    canvasEl.addEventListener("mouseleave", handleRollingMouseLeave);

    // Store redraw function for resize handling (no reveal animation on resize)
    section._redraw = () => parseAndDraw(activeWindow, false);
    panel._rollingSection = section;
  }

  // Rolling-xwOBA chart for the MiLB (ProspectSavant) view: a single fixed-window series
  // recomputed from the raw per-game data, reusing the MLB canvas renderer.
  function appendProspectRollingChart(panel, games) {
    panel.querySelector(".ocf-rolling-divider")?.remove();
    panel.querySelector(".ocf-rolling-section")?.remove();

    const series = computeRollingSeries(games, PROSPECT_ROLLING_WINDOW);
    if (!series.length) return;

    const divider = document.createElement("div");
    divider.className = "ocf-rolling-divider";
    panel.appendChild(divider);

    const section = document.createElement("div");
    section.className = "ocf-rolling-section";
    section.innerHTML = `
      <div class="ocf-rolling-header">
        <span class="ocf-rolling-title">Rolling xwOBA</span>
        <span class="ocf-rolling-subtitle">${PROSPECT_ROLLING_WINDOW}-game</span>
      </div>
      <div class="ocf-rolling-canvas-wrap">
        <canvas></canvas>
        <div class="ocf-rolling-dot"></div>
        <div class="ocf-rolling-tooltip"></div>
      </div>
    `;
    panel.appendChild(section);

    const canvasEl = section.querySelector("canvas");
    const tooltipEl = section.querySelector(".ocf-rolling-tooltip");
    const dotEl = section.querySelector(".ocf-rolling-dot");
    canvasEl._dot = dotEl;
    canvasEl._pitcher = false;

    const draw = (animate = true) => drawRollingChart(canvasEl, series, tooltipEl, false, animate);
    draw();

    canvasEl.addEventListener("mousemove", handleRollingMouseMove);
    canvasEl.addEventListener("mouseleave", handleRollingMouseLeave);

    // No reveal animation on resize redraws
    section._redraw = () => draw(false);
    panel._rollingSection = section;
  }

  // Fetch + render the MiLB rolling chart for the currently-selected entry. Guards against
  // the user switching player/entry while the fetch is in flight.
  async function updateMilbRolling(panel, entry) {
    panel.querySelector(".ocf-rolling-divider")?.remove();
    panel.querySelector(".ocf-rolling-section")?.remove();
    if (!entry || entry.source !== "MiLB" || entry.pitcher) return;
    const wantKey = entry.key;
    const games = await fetchProspectRolling(panel._mlbId, entry.season);
    if (!document.contains(panel)) return;
    if (panel.dataset.source !== "MiLB" || panel.dataset.selectedKey !== wantKey) return;
    if (!games || games.length < PROSPECT_ROLLING_WINDOW) return;
    appendProspectRollingChart(panel, games);
  }

  // --- FanGraphs Section ---

  const FANGRAPHS_SPLITS = {
    season: { month: 0, label: "Season" },
    "60d": { month: 1000, days: 60, label: "60D" },
    "30d": { month: 3, label: "30D" },
    "14d": { month: 2, label: "14D" },
  };

  const FANGRAPHS_METRICS = [
    { key: "pitching", label: "Pitching+" },
    { key: "stuff", label: "Stuff+" },
    { key: "location", label: "Location+" },
    { key: "xfip", label: "xFIP", inverted: true },
    { key: "siera", label: "SIERA", inverted: true },
  ];

  async function fetchFangraphsSplit(splitKey) {
    const split = FANGRAPHS_SPLITS[splitKey];
    let season = new Date().getFullYear();
    const msg = {
      type: "ocf-fetch-fangraphs",
      season,
      month: split.month,
      qual: "y",
    };
    // Custom date range for splits like 60D
    if (split.days) {
      const end = new Date();
      const start = new Date(end);
      start.setDate(start.getDate() - split.days);
      msg.startdate = start.toLocaleDateString("en-CA");
      msg.enddate = end.toLocaleDateString("en-CA");
    }
    try {
      let result = await browser.runtime.sendMessage(msg);
      // If empty, try previous year (offseason)
      if (result.ok && Object.keys(result.data).length === 0) {
        season = season - 1;
        msg.season = season;
        result = await browser.runtime.sendMessage(msg);
      }
      if (!result.ok) return { error: result.error || "Unknown error" };
      return result.data;
    } catch (e) {
      console.warn("[OCF] FanGraphs fetch failed:", e);
      return { error: e.message };
    }
  }

  function computeFangraphsRanks(players, mlbId, metricKey, inverted) {
    const eligible = [];
    for (const [id, p] of Object.entries(players)) {
      if (p[metricKey] != null) {
        eligible.push({ id, value: p[metricKey] });
      }
    }
    // Higher is better by default; inverted (ERA-like) = lower is better
    eligible.sort((a, b) => inverted ? a.value - b.value : b.value - a.value);

    // Standard competition ranking with tie detection
    let rank = 1;
    const ranks = {};
    const tiedRanks = new Set();
    for (let i = 0; i < eligible.length; i++) {
      if (i > 0 && eligible[i].value !== eligible[i - 1].value) {
        rank = i + 1;
      } else if (i > 0) {
        tiedRanks.add(rank);
      }
      ranks[eligible[i].id] = rank;
    }

    const playerRank = ranks[String(mlbId)];
    if (playerRank == null) return null;
    const tied = tiedRanks.has(playerRank);
    return { rank: playerRank, total: eligible.length, tied };
  }

  function fangraphsExternalUrl(splitKey) {
    const split = FANGRAPHS_SPLITS[splitKey];
    let url = `https://www.fangraphs.com/leaders/major-league?month=${split.month}&pos=all&stats=pit&type=36&qual=y&pagenum=1&pageitems=2000000000&sortcol=14&sortdir=default`;
    if (split.days) {
      const end = new Date();
      const start = new Date(end);
      start.setDate(start.getDate() - split.days);
      url += `&startdate=${start.toLocaleDateString("en-CA")}&enddate=${end.toLocaleDateString("en-CA")}`;
    }
    return url;
  }

  function appendFangraphsSection(panel, mlbId) {
    // Remove any existing section
    panel.querySelector(".ocf-fangraphs-divider")?.remove();
    panel.querySelector(".ocf-fangraphs-section")?.remove();

    const divider = document.createElement("div");
    divider.className = "ocf-fangraphs-divider";
    panel.appendChild(divider);

    const section = document.createElement("div");
    section.className = "ocf-fangraphs-section";

    const splits = Object.entries(FANGRAPHS_SPLITS);
    section.innerHTML = `
      <div class="ocf-fangraphs-header">
        <span class="ocf-fangraphs-title">FanGraphs</span>
        <a class="ocf-fangraphs-link" href="${fangraphsExternalUrl("season")}" target="_blank" rel="noopener noreferrer">
          <mat-icon class="mat-icon material-icons" style="font-size:14px;width:14px;height:14px;">open_in_new</mat-icon>
          fg
        </a>
      </div>
      <div class="ocf-fangraphs-body"></div>
      <div class="ocf-fangraphs-footer">
        <div class="ocf-fangraphs-toggle">
          ${splits.map(([key, s]) => `<button data-split="${key}" class="${key === "season" ? "ocf-fangraphs-toggle--active" : ""}">${s.label}</button>`).join("")}
        </div>
      </div>
    `;
    panel.appendChild(section);

    const body = section.querySelector(".ocf-fangraphs-body");
    const fgLink = section.querySelector(".ocf-fangraphs-link");
    let activeSplit = "season";

    function renderBars(players) {
      body.innerHTML = "";

      const player = players?.[String(mlbId)];
      if (!player) {
        body.innerHTML = `<div class="ocf-fangraphs-empty">No data available<br><span style="font-size:9px;color:rgba(255,255,255,0.2)">Qualified starters only</span></div>`;
        return;
      }

      const animations = [];
      for (const metric of FANGRAPHS_METRICS) {
        const value = player[metric.key];
        if (value == null) continue;

        const rankInfo = computeFangraphsRanks(players, mlbId, metric.key, metric.inverted);
        // Convert rank to percentile (rank 1 = 99th, last = 0th)
        const pct = rankInfo ? Math.round((1 - (rankInfo.rank - 1) / (rankInfo.total - 1)) * 100) : 50;
        const color = getPercentileColor(pct);
        const barPct = Math.max(pct, 6);
        const labelLeft = Math.max(pct, 4);
        const displayValue = metric.inverted ? value.toFixed(2) : Math.round(value);

        const row = document.createElement("div");
        row.className = "ocf-fangraphs-row";
        // Start collapsed and grow in via rAF so the .ocf-statcast-fill width transition
        // fires, matching the Statcast bars' load-in animation.
        row.innerHTML = `
          <span class="ocf-statcast-label ocf-statcast-label--qualified">${metric.label}</span>
          <div class="ocf-statcast-track">
            <div class="ocf-statcast-fill" style="width:0%;background:${color}"></div>
            <span class="ocf-statcast-pct" style="left:0%;background:${color}${pct >= 35 && pct <= 60 ? ";text-shadow:0 0 2px rgba(0,0,0,0.9)" : ""}">${pct}</span>
          </div>
          <span class="ocf-fangraphs-value-right">${displayValue}</span>
        `;
        body.appendChild(row);
        animations.push({
          fill: row.querySelector(".ocf-statcast-fill"),
          label: row.querySelector(".ocf-statcast-pct"),
          barPct, labelLeft,
        });
      }
      if (animations.length) {
        requestAnimationFrame(() => {
          for (const { fill, label, barPct, labelLeft } of animations) {
            fill.style.width = barPct + "%";
            label.style.left = labelLeft + "%";
          }
        });
      }
    }

    function showShimmer() {
      body.innerHTML = FANGRAPHS_METRICS.map((m) => `
        <div class="ocf-fangraphs-row">
          <span class="ocf-statcast-label" style="opacity:0.3">${m.label}</span>
          <div class="ocf-statcast-track"><div class="ocf-statcast-skeleton"></div></div>
          <span class="ocf-fangraphs-value-right"></span>
        </div>
      `).join("");
    }

    async function loadSplit(splitKey, injectActuals) {
      fgLink.href = fangraphsExternalUrl(splitKey);
      showShimmer();
      const players = await fetchFangraphsSplit(splitKey);
      if (players?.error) {
        body.innerHTML = `<div class="ocf-fangraphs-empty">FanGraphs data unavailable</div>`;
      } else if (players) {
        renderBars(players);
        if (injectActuals) {
          injectStatcastActualValues(panel, players[String(mlbId)]);
        }
      } else {
        body.innerHTML = `<div class="ocf-fangraphs-empty">No data available</div>`;
      }
      if (injectActuals) {
        const hasPlayerData = players && !players.error && players[String(mlbId)] != null;
        panel.dataset.noFgData = hasPlayerData ? "false" : "true";
        updatePanelFullWidth(panel);
      }
    }

    // Toggle clicks
    section.querySelector(".ocf-fangraphs-toggle").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-split]");
      if (!btn || btn.dataset.split === activeSplit) return;
      section.querySelectorAll(".ocf-fangraphs-toggle button").forEach((b) => b.classList.remove("ocf-fangraphs-toggle--active"));
      btn.classList.add("ocf-fangraphs-toggle--active");
      activeSplit = btn.dataset.split;
      loadSplit(activeSplit);
    });

    // Initial load (season) - also inject actual values into Statcast bars
    loadSplit(activeSplit, true);
  }

  // --- MLB Video API (GraphQL) ---

  function isPitcher(positionText) {
    if (!positionText) return false;
    const positions = positionText.split(/[,/]/).map((p) => p.trim().toUpperCase());
    return positions.some((p) => p === "SP" || p === "RP" || p === "P");
  }

  function detectMinorsFromHeader(header) {
    if (!header) return false;
    const scope = header.querySelector(".player-profile__header__info") || header;
    const RE = /minor league/i;
    // Direct accessible attributes (aria-label / title / aria-description / Material tooltip attrs)
    if (scope.querySelector(
          '[aria-label*="Minor League" i],[title*="Minor League" i],' +
          '[aria-description*="Minor League" i],[mattooltip*="Minor League" i],' +
          '[ng-reflect-message*="Minor League" i]')) {
      return true;
    }
    // Material tooltips reference their text via aria-describedby/aria-labelledby
    for (const el of scope.querySelectorAll("[aria-describedby],[aria-labelledby]")) {
      const ids = `${el.getAttribute("aria-describedby") || ""} ${el.getAttribute("aria-labelledby") || ""}`.trim().split(/\s+/);
      for (const id of ids) {
        const ref = id && document.getElementById(id);
        if (ref && RE.test(ref.textContent || "")) return true;
      }
    }
    // Fallback: visible text in the info row
    return RE.test(scope.textContent || "");
  }

  const VIDEO_GQL_QUERY = `query Search($query: String!, $page: Int, $limit: Int, $feedPreference: FeedPreference, $languagePreference: LanguagePreference, $contentPreference: ContentPreference, $queryType: QueryType) {
    search(query: $query, limit: $limit, page: $page, feedPreference: $feedPreference, languagePreference: $languagePreference, contentPreference: $contentPreference, queryType: $queryType) {
      total
      plays {
        mediaPlayback {
          id
          title
          slug
          date
          feeds {
            type
            duration
            playbacks { name url }
            image { cuts { src width height } }
          }
        }
      }
    }
  }`;

  // Each filter pairs a Film Room (gateway) query with a MiLB tag. Page 1 of
  // each filter merges results from both sources so MiLB-only clips appear
  // alongside Film Room clips. milbTag=null means don't query MiLB for this
  // filter; milbTag="" means query MiLB by player only (no extra tag filter).
  const HITTER_FILTERS = {
    "all-bip": {
      label: "All BIP",
      query: (id) => 'BatterId = [' + id + '] AND HitResult = ["Hit","Out","Error","Home Run"] Order By Timestamp DESC',
      milbTag: "",
    },
    "hits": {
      label: "Hits",
      query: (id) => 'BatterId = [' + id + '] AND HitResult = ["Hit","Home Run"] Order By Timestamp DESC',
      milbTag: "",
      milbTitleFilter: "hits",
    },
    "hr": {
      label: "Home Runs",
      query: (id) => 'BatterId = [' + id + '] AND HitResult = ["Home Run"] Order By Timestamp DESC',
      milbTag: "home-run",
      // Some MiLB HR clips lack the home-run tag, so also scan the player's
      // recent clips and pick any with HR titles.
      milbTitleRescue: "hr",
    },
  };

  const PITCHER_FILTERS = {
    "all": {
      label: "All Highlights",
      queryType: "FREETEXT",
      query: (_id, playerName) => playerName,
      milbTag: "",
    },
    "strikeouts": {
      label: "Strikeouts",
      query: (id) => 'PitcherId = [' + id + '] AND HitResult = ["Strikeout"] Order By Timestamp DESC',
      milbTag: null,
    },
    "hr-against": {
      label: "HRs Against",
      query: (id) => 'PitcherId = [' + id + '] AND HitResult = ["Home Run"] Order By Timestamp DESC',
      milbTag: "home-run",
    },
  };

  function getFilters(positionText) {
    return isPitcher(positionText) ? PITCHER_FILTERS : HITTER_FILTERS;
  }

  function getDefaultFilter(positionText) {
    return isPitcher(positionText) ? "all" : "all-bip";
  }

  async function doVideoFetch(query, page, queryType) {
    const isFreetext = queryType === "FREETEXT";
    const result = await browser.runtime.sendMessage({
      type: "ocf-fetch-videos",
      gqlQuery: VIDEO_GQL_QUERY,
      variables: {
        query,
        page,
        limit: VIDEOS_PER_PAGE,
        languagePreference: "EN",
        contentPreference: isFreetext ? "CMS_FIRST" : "MIXED",
        ...(queryType ? { queryType } : {}),
      },
    });

    if (!result.ok) throw new Error(result.error);
    return result.data.data.search;
  }

  // Strikeouts come back under HitResult="Out" in structured queries, so filter
  // them out by title. Used for hitter "all-bip" / "hits" filters where we
  // intentionally don't constrain by HitDistance (MiLB clips often lack it).
  const STRIKEOUT_TITLE_RE = /\b(?:strikes? out|out on strikes|strikeout|K['']?s)\b/i;
  // ABS challenge review clips (ball/strike call reviews) also leak into
  // BatterId-based structured queries but aren't balls in play.
  const ABS_CHALLENGE_TITLE_RE = /ABS challenge/i;

  function isNonBipTitle(title) {
    return !!title && (STRIKEOUT_TITLE_RE.test(title) || ABS_CHALLENGE_TITLE_RE.test(title));
  }

  const MILB_PAGE_SIZE = 25;
  // Match titles for hits-only (singles, doubles, triples, home runs - excludes
  // outs, walks, defense). The MiLB API has no equivalent of HitResult, so we
  // post-filter when the user picks "Hits".
  const HIT_TITLE_RE = /\b(?:singles?|doubles?|triples?|homers?|home run|RBI|hits? a)\b/i;
  const HR_TITLE_RE = /\b(?:homers?|home run|two-run homer|three-run homer|grand slam)\b/i;

  // MiLB contentDate is a UTC timestamp, so slicing it produces tomorrow's date
  // for late-evening West-Coast games. Prefer the ballpark-local game date from
  // the gamepk tag; fall back to the user-local date derived from contentDate.
  function extractMilbDate(item) {
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const gameTag = tags.find((t) => typeof t?.slug === "string" && t.slug.startsWith("gamepk-"));
    const gameId = gameTag?.extraData?.gameId;
    const fromGameId = typeof gameId === "string" && gameId.match(/\d{4}-\d{2}-\d{2}$/);
    if (fromGameId) return fromGameId[0];
    const title = gameTag?.title;
    const fromTitle = typeof title === "string" && title.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
    if (fromTitle) return `${fromTitle[1]}-${fromTitle[2]}-${fromTitle[3]}`;
    const raw = item.contentDate;
    if (typeof raw === "string") {
      const d = new Date(raw);
      if (!isNaN(d)) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      }
      return raw.slice(0, 10);
    }
    return "";
  }

  async function fetchMilbPage(mlbId, { tag = "", page = 1 } = {}) {
    const tagSlug = tag
      ? `playerid-${encodeURIComponent(mlbId)},${encodeURIComponent(tag)}`
      : `playerid-${encodeURIComponent(mlbId)}`;
    const skip = (page - 1) * MILB_PAGE_SIZE;
    const url =
      "https://dapi-milb.mlbinfra.com/v2/content/en-us/videos" +
      `?tags.slug=${tagSlug}&%24skip=${skip}&%24limit=${MILB_PAGE_SIZE}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`MiLB API ${resp.status}`);
    const data = await resp.json();
    const items = Array.isArray(data.items) ? data.items : [];

    const videos = items.map((item) => {
      const fields = item.fields || {};
      const scenarios = Array.isArray(fields.playbackScenarios) ? fields.playbackScenarios : [];
      const mp4 = scenarios.find((s) => s.playback === "mp4Avc")
        || scenarios.find((s) => s.location?.endsWith?.(".mp4"));
      const videoUrl = mp4?.location || fields.url;
      if (!videoUrl) return null;
      const thumb = item.thumbnail || {};
      const thumbUrl = thumb.thumbnailUrl
        || (thumb.templateUrl && thumb.templateUrl.replace("{formatInstructions}", "w_372,h_209,c_fill,q_auto,f_jpg"))
        || null;
      return {
        id: item._entityId || item.slug,
        title: item.title || fields.description || "Untitled",
        date: extractMilbDate(item),
        duration: fields.duration || "",
        videoUrl,
        thumbUrl,
      };
    }).filter(Boolean);

    const maxItems = data.pagination?.maxItems;
    const exhausted = items.length === 0
      || items.length < MILB_PAGE_SIZE
      || (typeof maxItems === "number" && skip + items.length >= maxItems);

    return { videos, exhausted };
  }

  async function fetchGatewayPage(playerName, { mlbId, filter, positionText, page = 1 } = {}) {
    const filters = getFilters(positionText);
    const activeFilter = filters[filter];
    const query = activeFilter.query(mlbId, playerName);
    const search = await doVideoFetch(query, page - 1, activeFilter.queryType);
    const dropNonBip = filter === "all-bip" || filter === "hits";
    const rawCount = (search.plays || []).length;

    const videos = (search.plays || []).map((play) => {
      const mp = play.mediaPlayback?.[0];
      if (!mp) return null;
      if (dropNonBip && isNonBipTitle(mp.title)) return null;

      const feeds = mp.feeds || [];
      let videoUrl = null;
      let bestFeed = null;
      for (const feed of feeds) {
        const playbacks = feed.playbacks || [];
        const mp4 = playbacks.find((p) => p.name === "mp4Avc")
          || playbacks.find((p) => p.name?.startsWith("mp4"))
          || playbacks.find((p) => p.url?.endsWith(".mp4"));
        if (mp4) {
          videoUrl = mp4.url;
          bestFeed = feed;
          break;
        }
      }
      if (!videoUrl) {
        for (const feed of feeds) {
          if (feed.playbacks?.[0]?.url) {
            videoUrl = feed.playbacks[0].url;
            bestFeed = feed;
            break;
          }
        }
      }
      if (!videoUrl) return null;

      const thumbFeed = bestFeed || feeds[0];
      const thumb = thumbFeed?.image?.cuts
        ?.filter((c) => c.width >= 300 && c.width <= 700)
        .sort((a, b) => a.width - b.width)[0];

      return {
        id: mp.id,
        title: mp.title || "Untitled",
        date: mp.date || "",
        duration: bestFeed?.duration || "",
        videoUrl,
        thumbUrl: thumb?.src || thumbFeed?.image?.cuts?.[0]?.src,
      };
    }).filter(Boolean);

    return { videos, exhausted: rawCount < VIDEOS_PER_PAGE };
  }

  // Fetch one MiLB page with optional title-rescue (HR clips missing tag).
  async function fetchMilbPageForFilter(mlbId, activeFilter, page) {
    const tag = activeFilter.milbTag;
    const main = await fetchMilbPage(mlbId, { tag, page });
    let videos = main.videos;
    let exhausted = main.exhausted;

    if (activeFilter.milbTitleRescue === "hr" && tag) {
      // Also pull untagged page N and pick HR titles. Cheap because limit=25.
      try {
        const rescue = await fetchMilbPage(mlbId, { page });
        const rescued = rescue.videos.filter((v) => HR_TITLE_RE.test(v.title));
        const seen = new Set(videos.map((v) => v.id));
        videos = videos.concat(rescued.filter((v) => !seen.has(v.id)));
        exhausted = exhausted && rescue.exhausted;
      } catch {}
    }

    if (activeFilter.milbTitleFilter === "hits") {
      videos = videos.filter((v) => HIT_TITLE_RE.test(v.title) && !isNonBipTitle(v.title));
    } else if (activeFilter === HITTER_FILTERS["all-bip"]) {
      videos = videos.filter((v) => !isNonBipTitle(v.title));
    }

    return { videos, exhausted };
  }

  // --- Video Modal ---

  function removeModal() {
    const modal = document.querySelector(".ocf-video-modal");
    if (modal) {
      const player = modal.querySelector(".ocf-video-modal__player");
      if (player) {
        player.pause();
        if (player._blobUrl) URL.revokeObjectURL(player._blobUrl);
      }
      modal.classList.remove("ocf-video-modal--visible");
      setTimeout(() => modal.remove(), 200);
    }
  }

  async function selectVideo(modal, video) {
    const player = modal.querySelector(".ocf-video-modal__player");
    const title = modal.querySelector(".ocf-video-modal__title");
    const date = modal.querySelector(".ocf-video-modal__date");

    // Revoke previous blob URL to free memory
    if (player._blobUrl) {
      URL.revokeObjectURL(player._blobUrl);
      player._blobUrl = null;
    }

    title.textContent = video.title;
    date.textContent = video.date;

    modal.querySelectorAll(".ocf-video-modal__list-item").forEach((item) => {
      item.classList.toggle("ocf-video-modal__list-item--active", item.dataset.videoId === video.id);
    });

    let src = video.videoUrl;

    // Proxy fastball-clips through background script to set required headers
    if (src.includes("fastball-clips.mlb.com")) {
      try {
        const result = await browser.runtime.sendMessage({
          type: "ocf-fetch-video-blob",
          url: src,
        });
        if (result.ok) {
          const binary = atob(result.data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: "video/mp4" });
          src = URL.createObjectURL(blob);
          player._blobUrl = src;
        }
      } catch (e) {
        console.warn("[OCF] Video proxy failed:", e);
      }
    }

    player.src = src;
    player.play().catch(() => {});
  }

  function appendVideoItems(container, videos, modal) {
    const frag = document.createDocumentFragment();
    for (const video of videos) {
      const item = document.createElement("div");
      item.className = "ocf-video-modal__list-item";
      item.dataset.videoId = video.id;
      item.innerHTML = `
        <div class="ocf-video-modal__list-thumb">
          ${video.thumbUrl ? `<img src="${escapeHtml(video.thumbUrl)}" loading="lazy" alt="" />` : ""}
          <span class="ocf-video-modal__list-duration">${formatDuration(video.duration)}</span>
        </div>
        <div class="ocf-video-modal__list-info">
          <span class="ocf-video-modal__list-title">${escapeHtml(video.title)}</span>
          <span class="ocf-video-modal__list-date">${escapeHtml(video.date)}</span>
        </div>
      `;
      item.addEventListener("click", () => selectVideo(modal, video));
      frag.appendChild(item);
    }
    container.appendChild(frag);
  }

  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function formatDuration(dur) {
    if (!dur) return "";
    // dur is "HH:MM:SS" format
    const parts = dur.split(":");
    if (parts.length === 3) {
      const m = parseInt(parts[1], 10);
      const s = parts[2];
      return `${m}:${s}`;
    }
    return dur;
  }

  async function showVideoModal(playerName, { mlbId, positionText } = {}) {
    removeModal();

    const overlay = document.createElement("div");
    overlay.className = "ocf-video-modal";

    overlay.innerHTML = `
      <div class="ocf-video-modal__backdrop"></div>
      <div class="ocf-video-modal__container">
        <div class="ocf-video-modal__header">
          <mat-icon class="mat-icon material-icons ocf-video-modal__header-icon">play_circle</mat-icon>
          <span class="ocf-video-modal__date"></span>
          <span class="ocf-video-modal__title">${escapeHtml(playerName)}</span>
          <div class="ocf-video-modal__filters"></div>
          <button class="ocf-video-modal__close" title="Close">
            <mat-icon class="mat-icon material-icons">close</mat-icon>
          </button>
        </div>
        <div class="ocf-video-modal__layout">
          <div class="ocf-video-modal__body">
            <div class="ocf-video-modal__player-wrap">
              <video
                class="ocf-video-modal__player"
                controls
                playsinline
              ></video>
            </div>
          </div>
          <div class="ocf-video-modal__sidebar">
            <div class="ocf-video-modal__list"></div>
          </div>
        </div>
      </div>
    `;

    overlay.querySelector(".ocf-video-modal__backdrop").addEventListener("click", removeModal);
    overlay.querySelector(".ocf-video-modal__close").addEventListener("click", removeModal);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("ocf-video-modal--visible"));

    const onKey = (e) => {
      if (e.key === "Escape") {
        removeModal();
        document.removeEventListener("keydown", onKey);
      }
    };
    document.addEventListener("keydown", onKey);

    // Auto-play next video when current one ends
    const player = overlay.querySelector(".ocf-video-modal__player");
    let allVideos = [];
    player.addEventListener("ended", () => {
      const activeItem = overlay.querySelector(".ocf-video-modal__list-item--active");
      const nextItem = activeItem?.nextElementSibling;
      if (nextItem) {
        const idx = Array.from(overlay.querySelectorAll(".ocf-video-modal__list-item")).indexOf(nextItem);
        if (idx >= 0 && allVideos[idx]) selectVideo(overlay, allVideos[idx]);
      }
    });

    let activeFilter = getDefaultFilter(positionText);
    let loading = false;
    let seenIds = new Set();
    let seenKeys = new Set();
    // Same play from different sources gets different ids. Title+date matches
    // are treated as duplicates so MLB and MiLB feeds of the same clip don't
    // both render.
    function dupKey(v) {
      return ((v.title || "").trim().toLowerCase()) + "|" + (v.date || "");
    }
    // Per-source pagination cursors. buffer holds items already fetched but
    // not yet drained into the rendered list. exhausted = no more pages from
    // that source. The merger picks the buffer head with the newer date.
    let cursors = newCursors();

    function newCursors() {
      const filters = getFilters(positionText);
      const wantMilb = filters[activeFilter]?.milbTag !== undefined
        && filters[activeFilter]?.milbTag !== null;
      return {
        gateway: { page: 0, exhausted: false, buffer: [] },
        milb: wantMilb
          ? { page: 0, exhausted: false, buffer: [] }
          : { page: 0, exhausted: true, buffer: [] },
      };
    }

    const list = overlay.querySelector(".ocf-video-modal__list");

    async function ensureBuffer(source) {
      const cur = cursors[source];
      if (cur.buffer.length > 0 || cur.exhausted) return;
      const filters = getFilters(positionText);
      const activeFilterDef = filters[activeFilter];
      const next = cur.page + 1;
      try {
        const result = source === "gateway"
          ? await fetchGatewayPage(playerName, { mlbId, filter: activeFilter, positionText, page: next })
          : await fetchMilbPageForFilter(mlbId, activeFilterDef, next);
        cur.page = next;
        cur.exhausted = result.exhausted;
        // Filter out already-rendered items (by id and by title+date)
        cur.buffer = result.videos.filter(
          (v) => v && !seenIds.has(v.id) && !seenKeys.has(dupKey(v))
        );
      } catch (e) {
        console.warn(`[OCF] ${source} fetch failed`, e);
        cur.exhausted = true;
      }
    }

    async function loadMore(autoSelect = false) {
      if (loading) return;
      if (cursors.gateway.exhausted && cursors.milb.exhausted
          && cursors.gateway.buffer.length === 0 && cursors.milb.buffer.length === 0) {
        return;
      }
      loading = true;

      const spinner = document.createElement("div");
      spinner.className = "ocf-video-modal__loader";
      spinner.innerHTML = `<div class="ocf-video-modal__spinner"></div>`;
      list.appendChild(spinner);

      try {
        // Top up both buffers in parallel so we can compare heads.
        await Promise.all([ensureBuffer("gateway"), ensureBuffer("milb")]);

        const newItems = [];
        while (newItems.length < VIDEOS_PER_PAGE) {
          // Refill any empty buffer (one source may run out before the other).
          const refills = [];
          if (cursors.gateway.buffer.length === 0 && !cursors.gateway.exhausted) refills.push(ensureBuffer("gateway"));
          if (cursors.milb.buffer.length === 0 && !cursors.milb.exhausted) refills.push(ensureBuffer("milb"));
          if (refills.length) await Promise.all(refills);

          const gw = cursors.gateway.buffer[0];
          const mb = cursors.milb.buffer[0];
          if (!gw && !mb) break; // both exhausted and drained

          let pick;
          if (!gw) pick = "milb";
          else if (!mb) pick = "gateway";
          else pick = (gw.date || "") >= (mb.date || "") ? "gateway" : "milb";

          const item = cursors[pick].buffer.shift();
          if (!item) continue;
          const key = dupKey(item);
          if (seenIds.has(item.id) || seenKeys.has(key)) continue;
          seenIds.add(item.id);
          seenKeys.add(key);
          newItems.push(item);
        }

        spinner.remove();

        if (newItems.length === 0) {
          if (allVideos.length === 0) {
            list.innerHTML = `<div class="ocf-video-modal__empty">No videos found</div>`;
          }
          return;
        }

        allVideos = allVideos.concat(newItems);
        appendVideoItems(list, newItems, overlay);

        if (autoSelect) selectVideo(overlay, newItems[0]);
      } catch (e) {
        console.warn("[OCF] Video fetch failed", e);
        spinner.remove();
        if (allVideos.length === 0) {
          list.innerHTML = `<div class="ocf-video-modal__empty">Failed to load videos</div>`;
        }
      } finally {
        loading = false;
      }
    }

    list.addEventListener("scroll", () => {
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 100) {
        loadMore();
      }
    });

    // Filter buttons
    const filtersDiv = overlay.querySelector(".ocf-video-modal__filters");
    {
      const filters = getFilters(positionText);
      for (const [key, { label }] of Object.entries(filters)) {
        const btn = document.createElement("button");
        btn.className = "ocf-video-modal__filter-btn" + (key === activeFilter ? " ocf-video-modal__filter-btn--active" : "");
        btn.textContent = label;
        btn.addEventListener("click", () => {
          if (key === activeFilter) return;
          activeFilter = key;
          // Reset state for new filter
          allVideos = [];
          seenIds = new Set();
          seenKeys = new Set();
          cursors = newCursors();
          list.innerHTML = "";
          player.removeAttribute("src");
          overlay.querySelector(".ocf-video-modal__title").textContent = playerName;
          overlay.querySelector(".ocf-video-modal__date").textContent = "";
          // Update active button
          filtersDiv.querySelectorAll(".ocf-video-modal__filter-btn").forEach((b) => {
            b.classList.toggle("ocf-video-modal__filter-btn--active", b === btn);
          });
          loadMore(true);
        });
        filtersDiv.appendChild(btn);
      }
    }

    loadMore(true);
  }

  async function handleLinkClick(e, type, playerName, positionText, teamHint) {
    e.preventDefault();
    e.stopPropagation();

    const btn = e.currentTarget;
    btn.classList.add("ocf-link--loading");

    const mlbId = await lookupMlbId(playerName, teamHint);
    const urlName = makeUrlName(playerName);

    btn.classList.remove("ocf-link--loading");

    switch (type) {
      case "bbref":
        openLink(
          mlbId
            ? `https://www.baseball-reference.com/redirect.fcgi?player=1&mlb_ID=${mlbId}`
            : `https://www.baseball-reference.com/search/search.fcgi?search=${encodeURIComponent(playerName)}`
        );
        break;
      case "statcast": {
        const statType = isPitcher(positionText) ? "pitching" : "hitting";
        openLink(
          mlbId
            ? `https://baseballsavant.mlb.com/savant-player/${urlName}-${mlbId}?stats=statcast-r-${statType}-mlb`
            : `https://baseballsavant.mlb.com/savant-player/${urlName}?stats=statcast-r-${statType}-mlb`
        );
        break;
      }
      case "video":
        showVideoModal(playerName, { mlbId, positionText });
        break;
    }
  }

  function buildLinks(playerName, positionText, teamHint, size) {
    const container = document.createElement("span");
    container.className = size === "lg" ? "ocf-links--lg" : "ocf-links--sm";
    container.dataset.ocfPlayer = playerName;
    container.dataset.ocfPos = positionText || "";
    container.dataset.ocfTeam = teamHint || "";

    const links = [
      { type: "bbref", icon: "sports_baseball", title: "Baseball Reference", feature: "bbref" },
      { type: "statcast", icon: "insights", title: "Statcast", feature: "statcastIcon" },
      { type: "video", icon: "play_circle", title: "MLB Video", feature: "video" },
    ];

    for (const { type, icon, title, feature } of links) {
      if (!features[feature]) continue;
      const a = document.createElement("a");
      a.className = "ocf-link";
      a.title = title;
      a.href = "#";
      const i = document.createElement("mat-icon");
      i.className = "mat-icon material-icons";
      i.textContent = icon;
      a.appendChild(i);
      a.addEventListener("click", (e) =>
        handleLinkClick(
          e,
          type,
          container.dataset.ocfPlayer,
          container.dataset.ocfPos,
          container.dataset.ocfTeam || null
        )
      );
      container.appendChild(a);
    }

    return container;
  }

  function updateLinks(container, playerName, positionText, teamHint) {
    container.dataset.ocfPlayer = playerName;
    container.dataset.ocfPos = positionText || "";
    container.dataset.ocfTeam = teamHint || "";
  }

  // --- Table row players (roster, matchup, players pages) ---

  function getPositionFromScorer(scorerEl) {
    const posDiv = scorerEl.querySelector(".scorer__info__positions");
    if (posDiv) {
      const firstSpan = posDiv.querySelector("span");
      if (firstSpan) return firstSpan.textContent.trim();
    }
    return null;
  }

  function getTeamFromScorer(scorerEl) {
    const posDiv = scorerEl?.querySelector(".scorer__info__positions");
    if (!posDiv) return null;
    const teamSpan = posDiv.querySelector("span.mat-mdc-tooltip-trigger");
    if (!teamSpan) return null;
    return teamSpan.textContent.replace(/^[\s-]+/, "").trim();
  }

  function processTablePlayers(roots) {
    const nameLinks = roots
      ? roots.flatMap((r) => [...r.querySelectorAll(".scorer__info__name > a")])
      : [...document.querySelectorAll(".scorer__info__name > a")];

    for (const nameLink of nameLinks) {
      let playerName = cleanPlayerName(nameLink.textContent.trim());
      if (!playerName || playerName.split(/\s+/).length < 2) continue;
      // Resolve abbreviated names (e.g. "C. Emerson" -> "Corbin Emerson")
      if (/^[A-Z]\. [A-Z]/.test(playerName)) {
        const fullName = abbrNameMap.get(playerName);
        if (!fullName) {
          fetchScorerNames(); // Triggers API call + re-scan on first encounter
          // Remove stale links from recycled DOM elements so they don't point to the wrong player
          const scorerInfo = nameLink.closest(".scorer__info");
          if (scorerInfo) {
            const stale = scorerInfo.querySelector(".ocf-links--sm");
            if (stale) stale.remove();
          }
          continue;
        }
        playerName = fullName;
      }

      const scorerInfo = nameLink.closest(".scorer__info");
      if (!scorerInfo) continue;

      const scorerEl = nameLink.closest("scorer") || nameLink.closest(".scorer");
      const positionText = scorerEl ? getPositionFromScorer(scorerEl) : null;
      const teamAbbr = scorerEl ? getTeamFromScorer(scorerEl) : null;

      // Reuse existing link container if present, otherwise create one
      const existing = scorerInfo.querySelector(".ocf-links--sm");
      if (existing) {
        if (existing.dataset.ocfPlayer === playerName) continue;
        updateLinks(existing, playerName, positionText, teamAbbr);
        // Update live icon
        const liveIcon = existing.querySelector(".ocf-link--live");
        if (liveIcon) {
          liveIcon.style.display = "none";
          const live = isLiveFromDOM(scorerEl);
          if (live === true) {
            showLiveIconFromSchedule(liveIcon, teamAbbr);
          } else if (live === null) {
            maybeShowLiveIcon(liveIcon, teamAbbr);
          }
        }
        continue;
      }

      const links = buildLinks(playerName, positionText, teamAbbr, "sm");
      if (features.liveGame) {
        const liveIcon = createLiveIcon(links);
        const live = isLiveFromDOM(scorerEl);
        if (live === true) {
          showLiveIconFromSchedule(liveIcon, teamAbbr);
        } else if (live === null) {
          // No Opp column (transactions, etc.) - fall back to one-time API check
          maybeShowLiveIcon(liveIcon, teamAbbr);
        }
      }

      const posDiv = scorerInfo.querySelector(".scorer__info__positions");
      if (posDiv) {
        posDiv.appendChild(links);
      } else {
        const nameDiv = scorerInfo.querySelector(".scorer__info__name");
        if (nameDiv) nameDiv.after(links);
      }
    }
  }

  // --- Player modal/popup ---

  function processModals() {
    const headers = document.querySelectorAll(
      `.player-profile__header`
    );

    for (const header of headers) {
      const nameLink = header.querySelector(".player-profile__header__name a");
      if (!nameLink) continue;

      const playerName = cleanPlayerName(nameLink.textContent.trim());
      if (!playerName) continue;

      const prevName = header.getAttribute(PROCESSED_ATTR);
      if (prevName === playerName) continue;

      // Remove stale links if recycled
      if (prevName) {
        header.querySelectorAll(".ocf-links--lg").forEach((el) => el.remove());
      }

      header.setAttribute(PROCESSED_ATTR, playerName);

      // Info row: <a>Team</a> • <span>Position</span> • #number ...icons
      // Position is the only bare <span> (bullets carry ng-star-inserted, icons
      // carry scorer-icon classes); team is the leading <a>.
      let positionText = null;
      let teamName = null;
      const infoEl = header.querySelector(".player-profile__header__info");
      if (infoEl) {
        const posSpan = infoEl.querySelector("span:not([class])");
        if (posSpan) positionText = posSpan.textContent.trim();
        const teamLink = infoEl.querySelector("a");
        if (teamLink) teamName = teamLink.textContent.trim();
      }

      const isMinors = detectMinorsFromHeader(header);

      const links = buildLinks(playerName, positionText, teamName, "lg");

      // Insert right after the player name
      nameLink.after(links);

      if (features.liveGame) {
        const liveIcon = createLiveIcon(links);
        maybeShowLiveIcon(liveIcon, teamName, true);
      }

      // Populate the skeleton panel if it's already showing, otherwise create fresh
      if (features.statcastPanel) {
        const existingPanel = document.querySelector(".ocf-statcast-panel");
        if (existingPanel) {
          populateStatcastFromModal(existingPanel, playerName, positionText, teamName, isMinors);
        } else {
          const overlayPane = header.closest(".cdk-overlay-pane");
          if (overlayPane) {
            const panel = showStatcastSkeleton(overlayPane);
            populateStatcastFromModal(panel, playerName, positionText, teamName, isMinors);
          }
        }
      }
    }
  }

  // --- Main scan ---

  function scanAndInject() {
    processTablePlayers();
    processModals();
  }

  // Load feature settings then inject
  browser.storage.sync.get({ bbref: true, statcastIcon: true, statcastPanel: true, video: true, liveGame: true, fangraphsPanel: true, prospectSavantPanel: true, themeOverride: "auto" }).then((stored) => {
    Object.assign(features, stored);
    themeOverride = stored.themeOverride || "auto";
    reconcileTheme();
    scanAndInject();
  });

  // Re-inject when settings change (user toggles in popup)
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let changed = false;
    if (changes.themeOverride) {
      themeOverride = changes.themeOverride.newValue || "auto";
      reconcileTheme();
    }
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in features) {
        features[key] = newValue;
        changed = true;
      }
    }
    if (changed) {
      // Remove all injected elements and re-scan
      document.querySelectorAll(".ocf-links--sm, .ocf-links--lg").forEach((el) => el.remove());
      document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => el.removeAttribute(PROCESSED_ATTR));
      removeStatcastPanel();
      scanAndInject();
    }
  });

  // --- Overlay observer: watch CDK overlay container directly for instant modal detection ---

  function isPlayerModal(overlay) {
    // Player modals use mat-dialog-container with a player profile header;
    // skip tooltips, dropdowns, and other dialogs (e.g. League Layout).
    return overlay.querySelector("mat-dialog-container") !== null &&
      overlay.querySelector(".player-profile__header") !== null;
  }

  function watchOverlayForModal(overlay) {
    function tryShowSkeleton() {
      if (features.statcastPanel && isPlayerModal(overlay) && !document.querySelector(".ocf-statcast-panel")) {
        showStatcastSkeleton(overlay);
      }
    }

    function hasPlayerName() {
      const link = overlay.querySelector(".player-profile__header__name a");
      return link && link.textContent.trim();
    }

    // Show skeleton as soon as we can confirm it's a player modal
    tryShowSkeleton();

    const inner = new MutationObserver(() => {
      tryShowSkeleton();
      if (hasPlayerName()) {
        inner.disconnect();
        processModals();
      }
    });
    inner.observe(overlay, { childList: true, subtree: true, characterData: true });
    if (hasPlayerName()) {
      inner.disconnect();
      processModals();
    }
  }

  function observeOverlayContainer(containerEl) {
    // Process any overlay panes that already exist
    for (const pane of containerEl.querySelectorAll(".cdk-overlay-pane")) {
      watchOverlayForModal(pane);
    }
    const overlayObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const pane = node.classList?.contains("cdk-overlay-pane") ? node : node.querySelector?.(".cdk-overlay-pane");
          if (pane) watchOverlayForModal(pane);
        }
      }
    });
    overlayObserver.observe(containerEl, { childList: true });
  }

  // CDK overlay container may already exist or appear later
  const existingOverlayContainer = document.querySelector(".cdk-overlay-container");
  if (existingOverlayContainer) {
    observeOverlayContainer(existingOverlayContainer);
  }

  // --- Body observer: scorers + fallback overlay container detection ---

  const observer = new MutationObserver((mutations) => {
    const scorerRoots = [];
    let recheckLive = false;
    for (const mutation of mutations) {
      // Detect in-place content updates inside existing scorer elements
      // (e.g., Fantrax filter/sort/page changes that reuse DOM rows)
      if (mutation.target.nodeType === Node.ELEMENT_NODE) {
        const scorer = mutation.target.closest?.("scorer, .scorer");
        if (scorer) scorerRoots.push(scorer);

        // Detect Opp column updates (game status changes)
        if (!scorer && (mutation.target.closest?.(".i-table__cell--small") || mutation.target.closest?.("._ut__content"))) {
          recheckLive = true;
        }
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        // Detect CDK overlay container appearing (if it wasn't present at startup)
        if (node.classList?.contains("cdk-overlay-container")) {
          observeOverlayContainer(node);
        } else if (node.querySelector?.(".cdk-overlay-container")) {
          const c = node.querySelector(".cdk-overlay-container");
          if (c) observeOverlayContainer(c);
        }
        if (node.matches?.("scorer, .scorer")) {
          scorerRoots.push(node);
        } else {
          const nested = node.querySelectorAll?.("scorer, .scorer");
          if (nested?.length) scorerRoots.push(...nested);
        }
      }
    }
    if (scorerRoots.length) processTablePlayers(scorerRoots);

    // Re-check live icons when Opp column content changes
    if (recheckLive) {
      document.querySelectorAll(".ocf-links--sm .ocf-link--live").forEach(updateLiveIconFromDOM);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // --- Permission banner (Firefox MV3 user-controlled host_permissions) ---

  const PERM_BANNER_DISMISS_KEY = "ocfPermBannerDismissed";

  async function maybeShowPermBanner() {
    let response;
    try {
      response = await browser.runtime.sendMessage({ type: "ocf-check-perms" });
    } catch {
      return;
    }
    if (!response?.ok || response.granted) return;

    if (document.querySelector(".ocf-perm-banner")) return;

    const banner = document.createElement("div");
    banner.className = "ocf-perm-banner";
    banner.innerHTML = `
      <span class="ocf-perm-banner__msg">
        <strong>FantraxBaseball+</strong> needs site access to load player video, Statcast, and live game links.
      </span>
      <button class="ocf-perm-banner__btn" type="button">Grant access</button>
      <button class="ocf-perm-banner__close" type="button" aria-label="Dismiss">×</button>
    `;
    document.body.appendChild(banner);

    banner.querySelector(".ocf-perm-banner__btn").addEventListener("click", () => {
      browser.runtime.sendMessage({ type: "ocf-open-setup" });
    });
    banner.querySelector(".ocf-perm-banner__close").addEventListener("click", () => {
      banner.remove();
      try { sessionStorage.setItem(PERM_BANNER_DISMISS_KEY, "1"); } catch {}
    });
  }

  try {
    if (sessionStorage.getItem(PERM_BANNER_DISMISS_KEY) !== "1") {
      maybeShowPermBanner();
    }
  } catch {
    maybeShowPermBanner();
  }
})();

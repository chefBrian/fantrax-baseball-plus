(function () {
  "use strict";

  const browser = globalThis.browser || globalThis.chrome;

  const PROCESSED_ATTR = "data-ocf-links";
  const MLB_SEARCH_API = "https://statsapi.mlb.com/api/v1/people/search?names=";
  const VIDEOS_PER_PAGE = 25;
  // Feature toggles (all on by default, overridden by storage)
  const features = { bbref: true, statcastIcon: true, statcastPanel: true, video: true, liveGame: true };
  // Cache MLB ID lookups
  const mlbIdCache = new Map();
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

  async function lookupMlbId(playerName) {
    if (mlbIdCache.has(playerName)) {
      return mlbIdCache.get(playerName);
    }
    try {
      const resp = await fetch(
        `${MLB_SEARCH_API}${encodeURIComponent(playerName)}`
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      if (data.people && data.people.length > 0) {
        const id = data.people[0].id;
        mlbIdCache.set(playerName, id);
        return id;
      }
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

  function getPercentileColor(pct) {
    const colors = [
      "#2166ac", "#2a6fb1", "#3278b5", "#3b81ba", "#4488c4",
      "#5392c7", "#5e99c9", "#7dacc2", "#93b8bc", "#a8a8a8",
      "#c49484", "#d47c64", "#d06c5a", "#d06150", "#cc5445",
      "#c6463a", "#be3630", "#b52026", "#ab1c22", "#a01c20",
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
      ? `<div class="ocf-statcast-section-title">Pitching</div>
         ${buildStatRowsHTML(PITCHING_PERCENTILE_STATS)}`
      : buildStatRowsHTML([...BATTING_PERCENTILE_STATS, ...SPEED_PERCENTILE_STATS]);

    panel.innerHTML = `
      <div class="ocf-statcast-header">
        <div class="ocf-statcast-header-top">
          <select class="ocf-statcast-year"></select>
          <span class="ocf-statcast-title">MLB Percentile Rankings</span>
          <a class="ocf-statcast-savant-link" href="https://baseballsavant.mlb.com/savant-player/${urlName}-${mlbId}?stats=${savantTab}" target="_blank" rel="noopener noreferrer">
            <mat-icon class="mat-icon material-icons" style="font-size:14px;width:14px;height:14px;">open_in_new</mat-icon>
            savant
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

    function updateBars() {
      const data = yearData[currentYear];
      const deferred = [];
      panel.querySelectorAll(".ocf-statcast-row[data-stat]").forEach((row) => {
        const key = row.dataset.stat;
        const pct = parseInt(data ? data[key] : "", 10);
        const fill = row.querySelector(".ocf-statcast-fill");
        const label = row.querySelector(".ocf-statcast-pct");

        if (isNaN(pct)) {
          fill.style.width = "0%";
          fill.style.background = "transparent";
          label.textContent = "";
          label.style.display = "none";
          const lbl = row.querySelector(".ocf-statcast-label");
          lbl.classList.add("ocf-statcast-label--nq");
          lbl.classList.remove("ocf-statcast-label--qualified");
        } else {
          const wasHidden = label.style.display === "none";
          const color = getPercentileColor(pct);
          label.textContent = pct;
          label.style.background = color;
          if (wasHidden) {
            // Set initial state at 0, defer targets to next frame for transition
            label.style.left = "0%";
            label.style.display = "";
            fill.style.width = "0%";
            fill.style.background = color;
            deferred.push({ fill, label, pct });
          } else {
            fill.style.width = Math.max(pct, 6) + "%";
            fill.style.background = color;
            label.style.left = Math.max(pct, 4) + "%";
          }
          const lbl = row.querySelector(".ocf-statcast-label");
          lbl.classList.remove("ocf-statcast-label--nq");
          lbl.classList.add("ocf-statcast-label--qualified");
        }
      });
      if (deferred.length) {
        requestAnimationFrame(() => {
          for (const { fill, label, pct } of deferred) {
            fill.style.width = Math.max(pct, 6) + "%";
            label.style.left = Math.max(pct, 4) + "%";
          }
        });
      }
    }

    updateBars();

    select.addEventListener("change", () => {
      currentYear = select.value;
      updateBars();
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
      const gap = 8;

      panel.style.left = "";
      panel.style.right = "";

      if (window.innerWidth - rect.right >= panelWidth + gap + 8) {
        panel.style.left = (rect.right + gap) + "px";
      } else if (rect.left >= panelWidth + gap + 8) {
        panel.style.left = (rect.left - panelWidth - gap) + "px";
      } else {
        panel.style.right = "8px";
      }

      panel.style.top = rect.top + "px";
      panel.style.maxHeight = (window.innerHeight - rect.top - 16) + "px";
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

  async function populateStatcastFromModal(panel, playerName, positionText) {
    const requestId = ++statcastPanelRequestId;
    const pitcher = isPitcher(positionText);

    // If pitcher, rebuild the skeleton body with pitcher stats
    if (pitcher) {
      const body = panel.querySelector(".ocf-statcast-body");
      if (body) {
        body.innerHTML = `
          <div class="ocf-statcast-section-title">Pitching</div>
          ${buildStatRowsHTML(PITCHING_PERCENTILE_STATS).replace(/<div class="ocf-statcast-fill"><\/div>\s*<span class="ocf-statcast-pct"><\/span>/g,
            '<div class="ocf-statcast-skeleton"></div>')}
        `;
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

    const mlbId = await lookupMlbId(playerName);
    if (!mlbId || requestId !== statcastPanelRequestId) return;
    if (!document.contains(panel)) return;

    // Fetch percentiles and rolling data in parallel
    const [yearData, rollingData] = await Promise.all([
      fetchStatcastPercentiles(mlbId, pitcher ? "pitcher" : "batter"),
      pitcher ? Promise.resolve(null) : fetchRollingData(mlbId),
    ]);
    if (!yearData || requestId !== statcastPanelRequestId) return;
    if (!document.contains(panel)) return;

    populateStatcastPanel(panel, yearData, playerName, mlbId, pitcher);

    // Append rolling xwOBA chart for hitters only
    if (!pitcher && rollingData) {
      appendRollingChart(panel, rollingData, pitcher);
    } else if (!pitcher) {
      // Show error for fetch failure
      panel.querySelector(".ocf-rolling-divider")?.remove();
      panel.querySelector(".ocf-rolling-section")?.remove();
      const divider = document.createElement("div");
      divider.className = "ocf-rolling-divider";
      panel.appendChild(divider);
      const errSection = document.createElement("div");
      errSection.className = "ocf-rolling-section";
      errSection.innerHTML = `<div class="ocf-rolling-header"><span class="ocf-rolling-title">Rolling xwOBA</span></div><div class="ocf-rolling-error">Unable to load rolling data</div>`;
      panel.appendChild(errSection);
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
          { v: 0.200, r: 255, g: 0, b: 0 },
          { v: 0.290, r: 194, g: 194, b: 194 },
          { v: 0.310, r: 194, g: 194, b: 194 },
          { v: 0.330, r: 194, g: 194, b: 205 },
          { v: 0.400, r: 0, g: 0, b: 255 },
        ]
      : [
          { v: 0.200, r: 0, g: 0, b: 255 },
          { v: 0.290, r: 194, g: 194, b: 205 },
          { v: 0.310, r: 194, g: 194, b: 194 },
          { v: 0.330, r: 194, g: 194, b: 194 },
          { v: 0.400, r: 255, g: 0, b: 0 },
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

  function drawRollingChart(canvas, data, tooltip, pitcher) {
    if (!data || data.length === 0) return;

    const container = canvas.parentElement;
    const cssWidth = container.clientWidth;
    const cssHeight = 140;
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

    const yMin = 0.150;
    const yMax = 0.530;

    function xPos(i) { return padLeft + (i / (data.length - 1)) * chartW; }
    function yPos(val) { return padTop + (1 - (val - yMin) / (yMax - yMin)) * chartH; }

    // Clear
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // Gridlines
    const gridValues = [0.200, 0.300, 0.400, 0.500];
    ctx.font = "9px Poppins, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const gv of gridValues) {
      const gy = yPos(gv);
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, gy);
      ctx.lineTo(padLeft + chartW, gy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.fillText(gv.toFixed(3), padLeft - 4, gy);
    }

    // League average line at .310
    const lgY = yPos(0.310);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, lgY);
    ctx.lineTo(padLeft + chartW, lgY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.textAlign = "left";
    ctx.fillText("LG AVG", padLeft + 2, lgY - 7);

    // Data line - colored segments
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    for (let i = 0; i < data.length - 1; i++) {
      const x1 = xPos(i);
      const y1 = yPos(data[i].xwoba);
      const x2 = xPos(i + 1);
      const y2 = yPos(data[i + 1].xwoba);
      const midVal = (data[i].xwoba + data[i + 1].xwoba) / 2;
      ctx.strokeStyle = getRollingColor(midVal, pitcher);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // Store data for tooltip hit testing
    canvas._rollingData = data;
    canvas._xPos = xPos;
    canvas._yPos = yPos;
    canvas._tooltip = tooltip;
    canvas._padLeft = padLeft;
    canvas._chartW = chartW;
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

    if (closestDist > 20) {
      tooltip.classList.remove("ocf-rolling-tooltip--visible");
      return;
    }

    const pt = data[closest];
    const px = canvas._xPos(closest);
    const py = canvas._yPos(pt.xwoba);
    tooltip.innerHTML = `<div>xwOBA: <b>${pt.xwoba.toFixed(3)}</b></div><div>Last PA: ${formatRollingDate(pt.max_game_date)}</div>`;
    tooltip.classList.add("ocf-rolling-tooltip--visible");

    // Position tooltip, clamping horizontally within the canvas wrapper
    const above = pt.xwoba > 0.330;
    const wrapWidth = canvas.parentElement.clientWidth;
    const tipW = tooltip.offsetWidth;
    let left = px - tipW / 2;
    if (left < 0) left = 0;
    if (left + tipW > wrapWidth) left = wrapWidth - tipW;
    tooltip.style.left = left + "px";
    const tipH = tooltip.offsetHeight;
    const wrapHeight = canvas.parentElement.clientHeight;
    let top = above ? (py - tipH - 8) : (py + 8);
    if (top < 0) top = 0;
    if (top + tipH > wrapHeight) top = wrapHeight - tipH;
    tooltip.style.top = top + "px";
  }

  function handleRollingMouseLeave(e) {
    const tooltip = e.currentTarget._tooltip;
    if (tooltip) tooltip.classList.remove("ocf-rolling-tooltip--visible");
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
      { key: "plate50", label: "50" },
      { key: "plate100", label: "100" },
      { key: "plate250", label: "250" },
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
        <div class="ocf-rolling-tooltip"></div>
      </div>
    `;
    panel.appendChild(section);

    const canvasEl = section.querySelector("canvas");
    const tooltipEl = section.querySelector(".ocf-rolling-tooltip");
    let activeWindow = "plate50";

    function parseAndDraw(key) {
      const arr = rollingData[key];
      if (!arr || arr.length === 0) return;
      // API returns rn=1 as most recent - reverse for chronological order
      const sorted = arr.slice().sort((a, b) => b.rn - a.rn);
      const parsed = sorted.map((d) => ({ xwoba: parseFloat(d.xwoba), max_game_date: d.max_game_date }));
      drawRollingChart(canvasEl, parsed, tooltipEl, pitcher);
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

    // Store redraw function for resize handling
    section._redraw = () => parseAndDraw(activeWindow);
    panel._rollingSection = section;
  }

  // --- MLB Video API (GraphQL) ---

  function isPitcher(positionText) {
    if (!positionText) return false;
    const positions = positionText.split(/[,/]/).map((p) => p.trim().toUpperCase());
    return positions.some((p) => p === "SP" || p === "RP" || p === "P");
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

  const HITTER_FILTERS = {
    "all-bip": {
      label: "All BIP",
      query: (id) => 'BatterId = [' + id + '] AND HitResult = ["Hit","Out","Error"] AND HitDistance = {{ 5, 790 }} Order By Timestamp DESC',
    },
    "hits": {
      label: "Hits",
      query: (id) => 'BatterId = [' + id + '] AND HitResult = ["Hit"] AND HitDistance = {{ 5, 790 }} Order By Timestamp DESC',
    },
    "hr": {
      label: "Home Runs",
      query: (id) => 'BatterId = [' + id + '] AND HitResult = ["Home Run"] AND HitDistance = {{ 5, 790 }} Order By Timestamp DESC',
    },
  };

  const PITCHER_FILTERS = {
    "all": {
      label: "All Highlights",
      queryType: "FREETEXT",
      query: (_id, playerName) => playerName,
    },
    "strikeouts": {
      label: "Strikeouts",
      query: (id) => 'PitcherId = [' + id + '] AND HitResult = ["Strikeout"] Order By Timestamp DESC',
    },
    "hr-against": {
      label: "HRs Against",
      query: (id) => 'PitcherId = [' + id + '] AND HitResult = ["Home Run"] Order By Timestamp DESC',
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

  async function fetchVideos(playerName, page = 1, { mlbId, positionText, filter } = {}) {
    if (!mlbId) return { videos: [], total: 0 };

    const filters = getFilters(positionText);
    const activeFilter = filters[filter];
    const query = activeFilter.query(mlbId, playerName);
    const search = await doVideoFetch(query, page - 1, activeFilter.queryType);

    const videos = (search.plays || []).map((play) => {
      const mp = play.mediaPlayback?.[0];
      if (!mp) return null;

      const feeds = mp.feeds || [];

      // Find a playable mp4 URL across all feeds, preferring mp4Avc
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

    return { videos, total: search.total || 0 };
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

    let currentPage = 0;
    let loading = false;
    let exhausted = false;
    let activeFilter = getDefaultFilter(positionText);

    const list = overlay.querySelector(".ocf-video-modal__list");

    async function loadMore(autoSelect = false) {
      if (loading || exhausted) return;
      loading = true;

      const spinner = document.createElement("div");
      spinner.className = "ocf-video-modal__loader";
      spinner.innerHTML = `<div class="ocf-video-modal__spinner"></div>`;
      list.appendChild(spinner);

      try {
        currentPage++;
        const result = await fetchVideos(playerName, currentPage, { mlbId, positionText, filter: activeFilter });
        spinner.remove();

        if (result.videos.length === 0) {
          if (allVideos.length === 0) {
            list.innerHTML = `<div class="ocf-video-modal__empty">No videos found</div>`;
          }
          exhausted = true;
          return;
        }

        allVideos = allVideos.concat(result.videos);
        appendVideoItems(list, result.videos, overlay);

        if (autoSelect && result.videos.length > 0) {
          selectVideo(overlay, result.videos[0]);
        }

        if (result.videos.length < VIDEOS_PER_PAGE) {
          exhausted = true;
        }
      } catch (e) {
        console.warn("[OCF] Video fetch failed", e);
        spinner.remove();
        if (currentPage === 1) {
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
          // Reset state
          currentPage = 0;
          allVideos = [];
          exhausted = false;
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

  async function handleLinkClick(e, type, playerName, positionText) {
    e.preventDefault();
    e.stopPropagation();

    const btn = e.currentTarget;
    btn.classList.add("ocf-link--loading");

    const mlbId = await lookupMlbId(playerName);
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

  function buildLinks(playerName, positionText, size) {
    const container = document.createElement("span");
    container.className = size === "lg" ? "ocf-links--lg" : "ocf-links--sm";
    container.dataset.ocfPlayer = playerName;
    container.dataset.ocfPos = positionText || "";

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
        handleLinkClick(e, type, container.dataset.ocfPlayer, container.dataset.ocfPos)
      );
      container.appendChild(a);
    }

    return container;
  }

  function updateLinks(container, playerName, positionText) {
    container.dataset.ocfPlayer = playerName;
    container.dataset.ocfPos = positionText || "";
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
      if (/^[A-Z]\./.test(playerName)) {
        const fullName = abbrNameMap.get(playerName);
        if (!fullName) {
          fetchScorerNames(); // Triggers API call + re-scan on first encounter
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
        updateLinks(existing, playerName, positionText);
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

      const links = buildLinks(playerName, positionText, "sm");
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
      const titleDiv = header.querySelector(".player-profile__header__title");
      if (!titleDiv) continue;

      const nameLink = titleDiv.querySelector("h1 a");
      if (!nameLink) continue;

      const playerName = cleanPlayerName(nameLink.textContent.trim());
      if (!playerName) continue;

      const prevName = header.getAttribute(PROCESSED_ATTR);
      if (prevName === playerName) continue;

      // Remove stale links if recycled
      if (prevName) {
        titleDiv.querySelectorAll(".ocf-links--lg").forEach((el) => el.remove());
      }

      header.setAttribute(PROCESSED_ATTR, playerName);

      let positionText = null;
      let teamName = null;
      const pEl = titleDiv.querySelector("p");
      if (pEl) {
        const posSpan = pEl.querySelector("span:not([class])");
        if (posSpan) positionText = posSpan.textContent.trim();
        // Team name is the text node before the first span (e.g. "Baltimore Orioles")
        const firstChild = pEl.firstChild;
        if (firstChild && firstChild.nodeType === Node.TEXT_NODE) {
          teamName = firstChild.textContent.trim();
        }
      }

      const links = buildLinks(playerName, positionText, "lg");

      // Insert right after the player name in h1
      nameLink.after(links);

      if (features.liveGame) {
        const liveIcon = createLiveIcon(links);
        maybeShowLiveIcon(liveIcon, teamName, true);
      }

      // Populate the skeleton panel if it's already showing, otherwise create fresh
      if (features.statcastPanel) {
        const existingPanel = document.querySelector(".ocf-statcast-panel");
        if (existingPanel) {
          populateStatcastFromModal(existingPanel, playerName, positionText);
        } else {
          const overlayPane = header.closest(".cdk-overlay-pane");
          if (overlayPane) {
            const panel = showStatcastSkeleton(overlayPane);
            populateStatcastFromModal(panel, playerName, positionText);
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
  browser.storage.sync.get({ bbref: true, statcastIcon: true, statcastPanel: true, video: true, liveGame: true }).then((stored) => {
    Object.assign(features, stored);
    scanAndInject();
  });

  // Re-inject when settings change (user toggles in popup)
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let changed = false;
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
      const link = overlay.querySelector(".player-profile__header h1 a");
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
})();

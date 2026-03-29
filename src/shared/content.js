(function () {
  "use strict";

  const browser = globalThis.browser || globalThis.chrome;

  const PROCESSED_ATTR = "data-ocf-links";
  const MLB_SEARCH_API = "https://statsapi.mlb.com/api/v1/people/search?names=";
  const VIDEOS_PER_PAGE = 25;
  // Cache MLB ID lookups
  const mlbIdCache = new Map();
  let scheduleData = null;
  const LIVE_POLL_INTERVAL = 120000; // 2 minutes

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
    try {
      const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
      const resp = await fetch(
        `https://statsapi.mlb.com/api/v1/schedule?date=${today}&sportId=1&hydrate=team`
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      const games = data.dates?.[0]?.games || [];
      const map = new Map();
      for (const game of games) {
        const isLive = game.status.detailedState === "In Progress";
        const info = { gamePk: game.gamePk, isLive };
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
    }
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

  async function maybeShowLiveIcon(liveIcon, teamStr) {
    if (!teamStr) return;
    const schedule = await fetchTodaySchedule();
    if (!schedule) return;

    const game = schedule.get(teamStr);
    if (!game || !game.isLive) return;

    liveIcon.href = `https://www.mlb.com/tv/g${game.gamePk}`;
    liveIcon.style.display = "";
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
      "#2166ac", "#3278b5", "#4488c4", "#5e99c9", "#a8a8a8",
      "#d47c64", "#d06150", "#c6463a", "#b52026", "#a01c20",
    ];
    return colors[Math.min(9, Math.floor(pct / 10))];
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
      if (existing._checkInterval) clearInterval(existing._checkInterval);
      if (existing._resizeHandler) window.removeEventListener("resize", existing._resizeHandler);
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
      : `<div class="ocf-statcast-section-title">Batting</div>
         ${buildStatRowsHTML(BATTING_PERCENTILE_STATS)}
         <div class="ocf-statcast-section-title">Running</div>
         ${buildStatRowsHTML(SPEED_PERCENTILE_STATS)}`;

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
          const color = getPercentileColor(pct);
          fill.style.width = Math.max(pct, 6) + "%";
          fill.style.background = color;
          label.textContent = pct;
          label.style.left = Math.max(pct, 4) + "%";
          label.style.background = color;
          label.style.display = "";
          const lbl = row.querySelector(".ocf-statcast-label");
          lbl.classList.remove("ocf-statcast-label--nq");
          lbl.classList.add("ocf-statcast-label--qualified");
        }
      });
    }

    updateBars();

    select.addEventListener("change", () => {
      currentYear = select.value;
      updateBars();
    });
  }

  async function showStatcastPanel(playerName, positionText, header) {
    const requestId = ++statcastPanelRequestId;
    removeStatcastPanel();

    const pitcher = isPitcher(positionText);
    const skeletonStats = pitcher ? PITCHING_PERCENTILE_STATS : [...BATTING_PERCENTILE_STATS, ...SPEED_PERCENTILE_STATS];
    const sectionTitle = pitcher ? "Pitching" : "Batting";

    // Create panel and show loading state immediately
    const panel = document.createElement("div");
    panel.className = "ocf-statcast-panel";
    const skeletonRows = skeletonStats
      .map(({ label }, i) => `
        <div class="ocf-statcast-row">
          <span class="ocf-statcast-label" style="opacity:0.3">${label}</span>
          <div class="ocf-statcast-track"><div class="ocf-statcast-skeleton"></div></div>
        </div>
        ${!pitcher && i === BATTING_PERCENTILE_STATS.length - 1 ? '<div class="ocf-statcast-section-title">Running</div>' : ""}
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
        <div class="ocf-statcast-section-title">${sectionTitle}</div>
        ${skeletonRows}
      </div>
    `;
    document.body.appendChild(panel);

    // Position and attach to modal
    const container = header.closest(".cdk-overlay-pane")
      || header.closest("mat-dialog-container")
      || header.closest("[class*='modal']")
      || header.closest("[class*='popup']")
      || header.closest("[class*='dialog']");

    function updatePosition() {
      const ref = container || header;
      const rect = ref.getBoundingClientRect();
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

    const checkInterval = setInterval(() => {
      if (!document.contains(container || header)) {
        removeStatcastPanel();
      }
    }, 100);
    panel._checkInterval = checkInterval;

    const resizeHandler = () => {
      if (document.contains(container || header)) updatePosition();
    };
    window.addEventListener("resize", resizeHandler);
    panel._resizeHandler = resizeHandler;

    // Fetch data (panel already visible with spinner)
    const mlbId = await lookupMlbId(playerName);
    if (!mlbId || requestId !== statcastPanelRequestId) return;
    if (!document.contains(header)) { removeStatcastPanel(); return; }

    const yearData = await fetchStatcastPercentiles(mlbId, pitcher ? "pitcher" : "batter");
    if (!yearData || requestId !== statcastPanelRequestId) return;
    if (!document.contains(header)) { removeStatcastPanel(); return; }

    // Populate the same panel in-place (no swap)
    populateStatcastPanel(panel, yearData, playerName, mlbId, pitcher);
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
    for (const video of videos) {
      const item = document.createElement("div");
      item.className = "ocf-video-modal__list-item";
      item.dataset.videoId = video.id;
      item.innerHTML = `
        <div class="ocf-video-modal__list-thumb">
          ${video.thumbUrl ? `<img src="${escapeHtml(video.thumbUrl)}" alt="" />` : ""}
          <span class="ocf-video-modal__list-duration">${formatDuration(video.duration)}</span>
        </div>
        <div class="ocf-video-modal__list-info">
          <span class="ocf-video-modal__list-title">${escapeHtml(video.title)}</span>
          <span class="ocf-video-modal__list-date">${escapeHtml(video.date)}</span>
        </div>
      `;
      item.addEventListener("click", () => selectVideo(modal, video));
      container.appendChild(item);
    }
  }

  function escapeHtml(str) {
    const el = document.createElement("span");
    el.textContent = str;
    return el.innerHTML;
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
      { type: "statcast", icon: "insights", title: "Statcast" },
      { type: "video", icon: "play_circle", title: "MLB Video" },
    ];

    for (const { type, icon, title } of links) {
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

  function processTablePlayers() {
    const nameLinks = document.querySelectorAll(
      `.scorer__info__name > a`
    );

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
          maybeShowLiveIcon(liveIcon, teamAbbr);
        }
        continue;
      }

      const links = buildLinks(playerName, positionText, "sm");
      const liveIcon = createLiveIcon(links);
      maybeShowLiveIcon(liveIcon, teamAbbr);

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

      const liveIcon = createLiveIcon(links);
      maybeShowLiveIcon(liveIcon, teamName);

      showStatcastPanel(playerName, positionText, header);
    }
  }

  // --- Main scan ---

  function scanAndInject() {
    processTablePlayers();
    processModals();
  }

  scanAndInject();

  function watchOverlayForModal(overlay) {
    function hasPlayerName() {
      const link = overlay.querySelector(".player-profile__header h1 a");
      return link && link.textContent.trim();
    }
    const inner = new MutationObserver(() => {
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

  const observer = new MutationObserver((mutations) => {
    let hasScorers = false;
    let hasOtherNodes = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const overlay = node.classList?.contains("cdk-overlay-pane")
          ? node
          : node.querySelector?.(".cdk-overlay-pane");
        if (overlay) watchOverlayForModal(overlay);
        if (node.matches?.("scorer, .scorer") || node.querySelector?.("scorer, .scorer")) {
          hasScorers = true;
        } else if (node.querySelector?.(".player-profile__header")) {
          hasOtherNodes = true;
        }
      }
    }
    // Process scorers immediately - no debounce
    if (hasScorers) processTablePlayers();
    // Debounce other changes (modals handled by watchOverlayForModal)
    if (hasOtherNodes) {
      clearTimeout(observer._timeout);
      observer._timeout = setTimeout(processModals, 300);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Periodically re-check for games that went live since last scan
  setInterval(async () => {
    const schedule = await fetchTodaySchedule(true);
    if (!schedule) return;

    document.querySelectorAll(".ocf-link--live").forEach((liveIcon) => {
      const links = liveIcon.closest(".ocf-links--sm, .ocf-links--lg");
      if (!links) return;
      const scorer = links.closest("scorer") || links.closest(".scorer");
      let teamStr = null;
      if (scorer) {
        teamStr = getTeamFromScorer(scorer);
      } else {
        const header = links.closest(".player-profile__header");
        const pEl = header?.querySelector(".player-profile__header__title p");
        const firstChild = pEl?.firstChild;
        if (firstChild && firstChild.nodeType === Node.TEXT_NODE) {
          teamStr = firstChild.textContent.trim();
        }
      }
      if (!teamStr) return;
      const game = schedule.get(teamStr);
      if (game && game.isLive) {
        liveIcon.href = `https://www.mlb.com/tv/g${game.gamePk}`;
        liveIcon.style.display = "";
      } else {
        liveIcon.style.display = "none";
      }
    });
  }, LIVE_POLL_INTERVAL);
})();

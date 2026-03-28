(function () {
  "use strict";

  const PROCESSED_ATTR = "data-ocf-links";
  const MLB_SEARCH_API = "https://statsapi.mlb.com/api/v1/people/search?names=";
  const VIDEOS_PER_PAGE = 10;
  // Cache MLB ID lookups
  const mlbIdCache = new Map();

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

  // --- MLB Video API ---

  function buildVideoQuery(queryType) {
    return `query Search($query: String!, $page: Int, $limit: Int) {
      search(query: $query, limit: $limit, page: $page, queryType: ${queryType}) {
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
  }

  async function doVideoFetch(searchQuery, queryType, page) {
    const result = await browser.runtime.sendMessage({
      type: "ocf-fetch-videos",
      gqlQuery: buildVideoQuery(queryType),
      variables: { query: searchQuery, page, limit: VIDEOS_PER_PAGE },
    });

    if (!result.ok) throw new Error(result.error);
    return result.data.data.search;
  }

  async function fetchVideos(playerName, page = 1) {
    const search = await doVideoFetch(playerName, "FREETEXT", page);

    const videos = (search.plays || []).map((play) => {
      const mp = play.mediaPlayback?.[0];
      if (!mp) return null;

      const cmsFeed = mp.feeds?.find((f) => f.type === "CMS") || mp.feeds?.[0];
      if (!cmsFeed) return null;

      const mp4 = cmsFeed.playbacks?.find((p) => p.name === "mp4Avc");
      const thumb = cmsFeed.image?.cuts
        ?.filter((c) => c.width >= 300 && c.width <= 700)
        .sort((a, b) => a.width - b.width)[0];

      return {
        id: mp.id,
        title: mp.title || "Untitled",
        date: mp.date || "",
        duration: cmsFeed.duration || "",
        videoUrl: mp4?.url || cmsFeed.playbacks?.[0]?.url,
        thumbUrl: thumb?.src || cmsFeed.image?.cuts?.[0]?.src,
      };
    }).filter(Boolean);

    return { videos, total: search.total || 0 };
  }

  // --- Video Modal ---

  function removeModal() {
    const modal = document.querySelector(".ocf-video-modal");
    if (modal) {
      const player = modal.querySelector(".ocf-video-modal__player");
      if (player) player.pause();
      modal.classList.remove("ocf-video-modal--visible");
      setTimeout(() => modal.remove(), 200);
    }
  }

  function selectVideo(modal, video) {
    const player = modal.querySelector(".ocf-video-modal__player");
    const title = modal.querySelector(".ocf-video-modal__title");
    const date = modal.querySelector(".ocf-video-modal__date");

    player.src = video.videoUrl;
    player.play();
    title.textContent = video.title;
    date.textContent = video.date;

    modal.querySelectorAll(".ocf-video-modal__list-item").forEach((item) => {
      item.classList.toggle("ocf-video-modal__list-item--active", item.dataset.videoId === video.id);
    });
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

  async function showVideoModal(playerName) {
    removeModal();

    const overlay = document.createElement("div");
    overlay.className = "ocf-video-modal";

    overlay.innerHTML = `
      <div class="ocf-video-modal__backdrop"></div>
      <div class="ocf-video-modal__container">
        <div class="ocf-video-modal__header">
          <mat-icon class="mat-icon material-icons ocf-video-modal__header-icon">videocam</mat-icon>
          <span class="ocf-video-modal__title">${escapeHtml(playerName)}</span>
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
                autoplay
                playsinline
              ></video>
            </div>
            <div class="ocf-video-modal__footer">
              <span class="ocf-video-modal__date"></span>
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
    let totalResults = 0;
    let loading = false;
    let exhausted = false;

    const list = overlay.querySelector(".ocf-video-modal__list");

    async function loadMore(autoSelect = false) {
      if (loading || exhausted) return;
      loading = true;

      // Show spinner at the bottom of the list
      const spinner = document.createElement("div");
      spinner.className = "ocf-video-modal__loader";
      spinner.innerHTML = `<div class="ocf-video-modal__spinner"></div>`;
      list.appendChild(spinner);

      try {
        currentPage++;
        const result = await fetchVideos(playerName, currentPage);
        totalResults = result.total;

        spinner.remove();

        if (result.videos.length === 0 && currentPage === 1) {
          list.innerHTML = `<div class="ocf-video-modal__empty">No videos found</div>`;
          exhausted = true;
          return;
        }

        allVideos = allVideos.concat(result.videos);
        appendVideoItems(list, result.videos, overlay);

        if (autoSelect && result.videos.length > 0) {
          selectVideo(overlay, result.videos[0]);
        }

        if (allVideos.length >= totalResults) {
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
      case "statcast":
        openLink(
          mlbId
            ? `https://baseballsavant.mlb.com/savant-player/${urlName}-${mlbId}`
            : `https://baseballsavant.mlb.com/savant-player/${urlName}`
        );
        break;
      case "video":
        showVideoModal(playerName);
        break;
    }
  }

  function buildLinks(playerName, positionText, size) {
    const container = document.createElement("span");
    container.className = size === "lg" ? "ocf-links--lg" : "ocf-links--sm";

    const links = [
      { type: "bbref", icon: "sports_baseball", title: "Baseball Reference" },
      { type: "statcast", icon: "insights", title: "Statcast" },
      { type: "video", icon: "videocam", title: "MLB Video" },
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
        handleLinkClick(e, type, playerName, positionText)
      );
      container.appendChild(a);
    }

    return container;
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

  function processTablePlayers() {
    const nameLinks = document.querySelectorAll(
      `.scorer__info__name > a:not([${PROCESSED_ATTR}])`
    );

    for (const nameLink of nameLinks) {
      nameLink.setAttribute(PROCESSED_ATTR, "true");

      const playerName = nameLink.textContent.trim();
      if (!playerName || playerName.split(/\s+/).length < 2) continue;

      const scorerEl = nameLink.closest("scorer") || nameLink.closest(".scorer");
      const positionText = scorerEl ? getPositionFromScorer(scorerEl) : null;

      const links = buildLinks(playerName, positionText, "sm");

      // Insert into .scorer__info__positions if it exists, otherwise after name
      const scorerInfo = nameLink.closest(".scorer__info");
      if (scorerInfo) {
        const posDiv = scorerInfo.querySelector(".scorer__info__positions");
        if (posDiv) {
          posDiv.appendChild(links);
        } else {
          // No position div - add after the name div
          const nameDiv = scorerInfo.querySelector(".scorer__info__name");
          if (nameDiv) nameDiv.after(links);
        }
      }
    }
  }

  // --- Player modal/popup ---

  function processModals() {
    const headers = document.querySelectorAll(
      `.player-profile__header:not([${PROCESSED_ATTR}])`
    );

    for (const header of headers) {
      header.setAttribute(PROCESSED_ATTR, "true");

      const titleDiv = header.querySelector(".player-profile__header__title");
      if (!titleDiv) continue;

      const nameLink = titleDiv.querySelector("h1 a");
      if (!nameLink) continue;

      const playerName = nameLink.textContent.trim();
      if (!playerName) continue;

      let positionText = null;
      const pEl = titleDiv.querySelector("p");
      if (pEl) {
        const posSpan = pEl.querySelector("span:not([class])");
        if (posSpan) positionText = posSpan.textContent.trim();
      }

      const links = buildLinks(playerName, positionText, "lg");

      // Insert right after the player name in h1
      nameLink.after(links);
    }
  }

  // --- Main scan ---

  function scanAndInject() {
    processTablePlayers();
    processModals();
  }

  scanAndInject();

  const observer = new MutationObserver((mutations) => {
    let hasNewNodes = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        hasNewNodes = true;
        break;
      }
    }
    if (hasNewNodes) {
      clearTimeout(observer._timeout);
      observer._timeout = setTimeout(scanAndInject, 300);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();

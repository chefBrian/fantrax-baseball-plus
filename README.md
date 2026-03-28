# oneConstantFirefox

Firefox extension that adds quick-access links to Fantrax fantasy baseball player pages.

## Features

- **Baseball Reference** - direct link via MLB ID, with search fallback
- **Statcast** - links to Baseball Savant player page
- **MLB Video** - inline video modal with auto-play and infinite scroll sidebar

Links appear in two places:
- **Player modals** - larger icons next to the player name
- **Roster/matchup tables** - small icons on the position line

### Video Modal

Clicking the video icon opens a modal with:
- 16:9 video player on the left, auto-playing the first result
- Scrollable video list on the right with infinite scroll
- Auto-advances to the next video when the current one ends

## Install

1. Clone the repo
2. Open `about:debugging#/runtime/this-firefox` in Firefox
3. Click **Load Temporary Add-on**
4. Select `manifest.json`

## How It Works

- Content script injects links into Fantrax DOM elements via a MutationObserver
- MLB player IDs are looked up via the [MLB Stats API](https://statsapi.mlb.com/api/v1/people/search)
- Videos are fetched from the MLB GraphQL API via the background script (to handle CORS)

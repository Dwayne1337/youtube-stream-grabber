# YouTube Live Link Saver

This script checks if one or more YouTube channels are **currently live**. If any are, it saves the live stream URL(s) to a text file so you can watch it later (even if the VOD becomes unlisted).

## Setup

0. Install Bun: https://bun.sh
1. Create a Google Cloud project and enable **YouTube Data API v3**
2. Create an **API key**
3. Get the channel identifier:
   - Channel ID looks like `UCxxxxxxxxxxxxxxxxxxxxxx`
   - Or use the channel URL / `@handle`

## Configure

Create a `.env` file (or copy `example.env`) with:

```bash
YOUTUBE_API_KEY=YOUR_KEY_HERE
YOUTUBE_CHANNELS=@channelhandle_or_UCxxxxxxxxxxxxxxxxxxxxxx,@anotherchannel
YOUTUBE_OUTPUT=saved_live_links.txt
YOUTUBE_INTERVAL_SECONDS=3600
# Optional (defaults shown)
# YOUTUBE_SCAN_LATEST=50
# YOUTUBE_USE_SEARCH=false

# Optional: also add saved videos to a playlist on *your* YouTube account
# (Requires OAuth; API keys alone can't modify playlists.)
# 1) Create an OAuth client in Google Cloud (Desktop app) and enable YouTube Data API v3.
# 2) Set the client ID/secret:
# YOUTUBE_OAUTH_CLIENT_ID=...
# YOUTUBE_OAUTH_CLIENT_SECRET=...
# 3) Get a refresh token (one-time):
# - EITHER run `bun yt_live_link_saver.js --env-file .env --oauth-setup`
# - OR just run with playlist saving enabled and it will prompt you automatically (interactive terminals only)
# - If your browser is on a different machine, copy the final `http://127.0.0.1:...` redirect URL and paste it into the terminal when prompted
# The refresh token is stored in `.youtube_oauth_tokens.json` by default (override with YOUTUBE_OAUTH_TOKEN_FILE).
# 4) Enable playlist saving (defaults shown):
# YOUTUBE_SAVE_TO_PLAYLIST=true
# YOUTUBE_PLAYLIST_TITLE=Saved Streams
# YOUTUBE_PLAYLIST_PRIVACY=private
```

## Run once

```bash
bun yt_live_link_saver.js --env-file .env --with-timestamp
```

If any channel is live, the script appends the link(s) to `saved_live_links.txt`.

If `YOUTUBE_SAVE_TO_PLAYLIST=true` (or you pass `--save-to-playlist`), it also adds newly saved videos to your `Saved Streams` playlist (creating it if needed).

By default it also keeps the playlist in sync with your output file (auto-backfills older saved links). Disable with `YOUTUBE_PLAYLIST_SYNC_OUTPUT=false` or `--no-playlist-sync-output`.

## Run every hour

### Option A: run as a loop

```bash
bun yt_live_link_saver.js --env-file .env --loop --interval-seconds 3600 --quiet
```

`--interval-seconds` overrides `YOUTUBE_INTERVAL_SECONDS` if both are set.

### Option B: cron (Linux/macOS)

Example (runs at minute 0 every hour):

```cron
0 * * * * /root/.bun/bin/bun /path/to/youtube-stream-grabber/yt_live_link_saver.js --env-file /path/to/youtube-stream-grabber/.env --quiet
```

Cron usually has a minimal `PATH`, so use the full Bun path (get it with `command -v bun`).

## Backfill playlist

If you already have links saved in your output file and want to add them all to the playlist (usually not needed if output-file sync is enabled):

```bash
bun yt_live_link_saver.js --env-file .env --playlist-sync
```

## Notes

- If the stream starts and ends between checks, it can be missed. Use a smaller interval if you want.
- By default this avoids `search.list` (very expensive quota). Set `YOUTUBE_USE_SEARCH=true` or pass `--use-search` to use the legacy `search.list` lookup.
- Playlist saving uses a local queue file so temporary OAuth/API failures are retried on later runs. You can override the queue location with `YOUTUBE_PLAYLIST_QUEUE_FILE`.
- Output-file sync stores a small local state file (next to `YOUTUBE_OUTPUT` by default); override with `YOUTUBE_PLAYLIST_STATE_FILE`.
- Use `--debug` (or `YOUTUBE_DEBUG=true`) to print verbose OAuth/playlist diagnostics to stderr.

# YouTube Live Link Saver

This script checks if a YouTube channel is **currently live**. If it is, it saves the live stream URL to a text file so you can watch it later (even if the VOD becomes unlisted).

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
YOUTUBE_CHANNEL=@channelhandle_or_UCxxxxxxxxxxxxxxxxxxxxxx
YOUTUBE_OUTPUT=saved_live_links.txt
YOUTUBE_INTERVAL_SECONDS=3600
```

## Run once

```bash
bun yt_live_link_saver.js --env-file .env --with-timestamp
```

If the channel is live, the script appends the link(s) to `saved_live_links.txt`.

## Run every hour

### Option A: run as a loop

```bash
bun yt_live_link_saver.js --env-file .env --loop --interval-seconds 3600 --quiet
```

`--interval-seconds` overrides `YOUTUBE_INTERVAL_SECONDS` if both are set.

### Option B: cron (Linux/macOS)

Example (runs at minute 0 every hour):

```cron
0 * * * * /path/to/bun /path/to/youtube-stream-grabber/yt_live_link_saver.js --env-file /path/to/youtube-stream-grabber/.env --quiet
```

## Notes

- If the stream starts and ends between checks, it can be missed. Use a smaller interval if you want.
- `search.list` uses YouTube API quota; hourly checks are usually fine.

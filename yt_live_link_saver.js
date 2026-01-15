#!/usr/bin/env bun
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const readline = require("node:readline");

const GOOGLE_OAUTH_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const YOUTUBE_SEARCH_ENDPOINT = "https://www.googleapis.com/youtube/v3/search";
const YOUTUBE_CHANNELS_ENDPOINT = "https://www.googleapis.com/youtube/v3/channels";
const YOUTUBE_PLAYLISTS_ENDPOINT = "https://www.googleapis.com/youtube/v3/playlists";
const YOUTUBE_PLAYLIST_ITEMS_ENDPOINT = "https://www.googleapis.com/youtube/v3/playlistItems";
const YOUTUBE_VIDEOS_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";

const DEFAULT_OUTPUT_FILE = "saved_live_links.txt";
const DEFAULT_INTERVAL_SECONDS = 3600;
const DEFAULT_SCAN_LATEST = 50;
const DEFAULT_PLAYLIST_TITLE = "Saved Streams";
const DEFAULT_PLAYLIST_PRIVACY = "private";
const DEFAULT_OAUTH_TOKEN_FILE = ".youtube_oauth_tokens.json";

const SCRIPT_DIR = (() => {
  const candidate =
    (typeof process.argv[1] === "string" && process.argv[1]) ||
    (typeof __filename === "string" && __filename) ||
    "";
  if (!candidate) return process.cwd();
  return path.dirname(path.resolve(candidate));
})();

function isDebugEnabled(args) {
  return Boolean(args && args.debug);
}

function debugLog(args, ...parts) {
  if (!isDebugEnabled(args)) return;
  console.error("[debug]", ...parts);
}

function formatMaybeMasked(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length <= 10) return `${raw.slice(0, 2)}…${raw.slice(-2)}`;
  return `${raw.slice(0, 6)}…${raw.slice(-4)}`;
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const value = stripQuotes(line.slice(idx + 1));
    if (!key) continue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function getEnvInt(name) {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`${name} must be an integer (got ${JSON.stringify(raw)})`);
  }
  return Number.parseInt(trimmed, 10);
}

function getEnvBool(name) {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (["1", "true", "yes", "y", "on"].includes(trimmed)) return true;
  if (["0", "false", "no", "n", "off"].includes(trimmed)) return false;
  throw new Error(`${name} must be a boolean (got ${JSON.stringify(raw)})`);
}

function splitCommaWhitespaceList(value) {
  if (value === null || value === undefined) return [];
  return String(value)
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function uniqueExactStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function getChannelInputs(args) {
  const fromArgs = Array.isArray(args.channels) ? args.channels : [];
  if (fromArgs.length) {
    const flattened = [];
    for (const raw of fromArgs) flattened.push(...splitCommaWhitespaceList(raw));
    return uniqueStrings(flattened);
  }

  const rawFromEnv = process.env.YOUTUBE_CHANNELS;
  return uniqueStrings(splitCommaWhitespaceList(rawFromEnv));
}

function resolveOutputPath(outputPath) {
  const raw = String(outputPath || "").trim();
  if (!raw) return raw;
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(SCRIPT_DIR, raw);
}

function formatGoogleApiError(statusCode, bodyText) {
  let data;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    const snippet = (bodyText || "").trim().replace(/\s+/g, " ");
    return `HTTP ${statusCode}: ${snippet.slice(0, 300)}`.trim();
  }

  if (data && typeof data === "object" && typeof data.error === "string") {
    const description =
      typeof data.error_description === "string" ? data.error_description : null;
    const details = [data.error, description].filter(Boolean).join(" - ");
    return details ? `HTTP ${statusCode}: ${details}` : `HTTP ${statusCode}`;
  }

  const err = data && typeof data === "object" ? data.error : null;
  const message =
    err && typeof err === "object" && typeof err.message === "string"
      ? err.message
      : null;

  let reason = null;
  if (err && typeof err === "object" && Array.isArray(err.errors) && err.errors[0]) {
    const first = err.errors[0];
    if (first && typeof first === "object" && typeof first.reason === "string") {
      reason = first.reason;
    }
  }

  const details = [reason, message].filter(Boolean).join(" - ");
  return details ? `HTTP ${statusCode}: ${details}` : `HTTP ${statusCode}`;
}

function isPlaylistNotFoundError(err) {
  if (!(err instanceof Error)) return false;
  const msg = String(err.message || "");
  return msg.includes("playlistNotFound");
}

async function apiGetJson(endpoint, params, { timeoutSeconds, headers } = {}) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(1, Number(timeoutSeconds)) * 1000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "yt-live-link-saver/1.0",
        ...(headers || {}),
      },
      signal: controller.signal,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(formatGoogleApiError(response.status, bodyText));
    }
    return bodyText ? JSON.parse(bodyText) : {};
  } catch (err) {
    if (err && typeof err === "object" && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutSeconds} seconds`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function apiPostJson(endpoint, params, body, { timeoutSeconds, headers } = {}) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(1, Number(timeoutSeconds)) * 1000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "yt-live-link-saver/1.0",
        ...(headers || {}),
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(formatGoogleApiError(response.status, bodyText));
    }
    return bodyText ? JSON.parse(bodyText) : {};
  } catch (err) {
    if (err && typeof err === "object" && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutSeconds} seconds`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function apiPostForm(endpoint, form, { timeoutSeconds, headers } = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form || {})) {
    if (value === undefined || value === null) continue;
    body.set(key, String(value));
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(1, Number(timeoutSeconds)) * 1000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "yt-live-link-saver/1.0",
        ...(headers || {}),
      },
      body: body.toString(),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(formatGoogleApiError(response.status, bodyText));
    }
    return bodyText ? JSON.parse(bodyText) : {};
  } catch (err) {
    if (err && typeof err === "object" && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutSeconds} seconds`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitForPlaylistToBeReady(args, accessToken, playlistId, { timeoutSeconds } = {}) {
  const maxAttempts = 6;
  let delayMs = 500;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await apiGetJson(
        YOUTUBE_PLAYLIST_ITEMS_ENDPOINT,
        {
          part: "contentDetails",
          playlistId,
          maxResults: "1",
          fields: "items(contentDetails(videoId))",
        },
        { timeoutSeconds, headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (attempt > 1) debugLog(args, `Playlist: ready after ${attempt} attempts`);
      return;
    } catch (err) {
      if (!isPlaylistNotFoundError(err) || attempt === maxAttempts) throw err;
      debugLog(args, `Playlist: not ready yet (playlistNotFound); retrying in ${delayMs}ms...`);
      await sleep(delayMs);
      delayMs = Math.min(4_000, delayMs * 2);
    }
  }
}

function extractChannelIdOrHandle(value) {
  const raw = value.trim();
  if (!raw) throw new Error("Channel is empty");

  if (raw.startsWith("UC") && raw.length >= 16) return { kind: "channel_id", value: raw };
  if (raw.startsWith("@")) return { kind: "handle", value: raw.slice(1) };

  if (raw.includes("://")) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = null;
    }
    if (parsed) {
      const parts = (parsed.pathname || "")
        .split("/")
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length >= 2 && parts[0] === "channel") {
        return { kind: "channel_id", value: parts[1] };
      }
      if (parts[0] && parts[0].startsWith("@")) {
        return { kind: "handle", value: parts[0].slice(1) };
      }
    }
  }

  return { kind: "handle", value: raw };
}

async function resolveChannelId(apiKey, channelInput, { timeoutSeconds }) {
  const { kind, value } = extractChannelIdOrHandle(channelInput);
  if (kind === "channel_id") return value;

  try {
    const data = await apiGetJson(
      YOUTUBE_CHANNELS_ENDPOINT,
      {
        part: "snippet",
        forHandle: value,
        key: apiKey,
        fields: "items(id)",
      },
      { timeoutSeconds }
    );
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length || !items[0] || typeof items[0].id !== "string") {
      throw new Error(
        `No channel found for @${value}. Try passing the channel ID (looks like UCxxxx...).`
      );
    }
    return items[0].id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("forHandle")) {
      throw new Error(
        `Failed to resolve @${value} via the YouTube API. Pass the channel ID instead (looks like UCxxxx...). (${message})`
      );
    }
    throw err;
  }
}

async function fetchLiveVideoIdsViaSearch(apiKey, channelId, { maxResults, timeoutSeconds }) {
  const data = await apiGetJson(
    YOUTUBE_SEARCH_ENDPOINT,
    {
      part: "id",
      channelId,
      eventType: "live",
      type: "video",
      maxResults: String(maxResults),
      key: apiKey,
      fields: "items(id(videoId))",
    },
    { timeoutSeconds }
  );

  const items = Array.isArray(data.items) ? data.items : [];
  const ids = [];
  for (const item of items) {
    const videoId = item && item.id ? item.id.videoId : null;
    if (typeof videoId === "string" && videoId) ids.push(videoId);
  }
  return ids;
}

async function fetchUploadsPlaylistId(apiKey, channelId, { timeoutSeconds }) {
  const data = await apiGetJson(
    YOUTUBE_CHANNELS_ENDPOINT,
    {
      part: "contentDetails",
      id: channelId,
      key: apiKey,
      fields: "items(contentDetails(relatedPlaylists(uploads)))",
    },
    { timeoutSeconds }
  );

  const items = Array.isArray(data.items) ? data.items : [];
  const uploads =
    items[0] &&
    items[0].contentDetails &&
    items[0].contentDetails.relatedPlaylists &&
    items[0].contentDetails.relatedPlaylists.uploads;
  if (typeof uploads !== "string" || !uploads) {
    throw new Error(`Could not determine uploads playlist for channel ${channelId}`);
  }
  return uploads;
}

async function fetchRecentVideoIdsFromUploadsPlaylist(
  apiKey,
  uploadsPlaylistId,
  { scanLatest, timeoutSeconds }
) {
  const data = await apiGetJson(
    YOUTUBE_PLAYLIST_ITEMS_ENDPOINT,
    {
      part: "contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults: String(scanLatest),
      key: apiKey,
      fields: "items(contentDetails(videoId))",
    },
    { timeoutSeconds }
  );

  const items = Array.isArray(data.items) ? data.items : [];
  const ids = [];
  for (const item of items) {
    const videoId = item && item.contentDetails ? item.contentDetails.videoId : null;
    if (typeof videoId === "string" && videoId) ids.push(videoId);
  }
  return uniqueExactStrings(ids);
}

async function filterCurrentlyLiveVideoIds(apiKey, videoIds, { timeoutSeconds }) {
  const ids = uniqueExactStrings(videoIds).slice(0, 50);
  if (!ids.length) return [];

  const data = await apiGetJson(
    YOUTUBE_VIDEOS_ENDPOINT,
    {
      part: "snippet,liveStreamingDetails",
      id: ids.join(","),
      key: apiKey,
      fields:
        "items(id,snippet(liveBroadcastContent),liveStreamingDetails(actualStartTime,actualEndTime))",
    },
    { timeoutSeconds }
  );

  const items = Array.isArray(data.items) ? data.items : [];
  const liveIds = [];
  for (const item of items) {
    const videoId = item && typeof item.id === "string" ? item.id : null;
    if (!videoId) continue;

    const liveBroadcastContent =
      item &&
      item.snippet &&
      typeof item.snippet.liveBroadcastContent === "string"
        ? item.snippet.liveBroadcastContent
        : null;
    const details = item && item.liveStreamingDetails ? item.liveStreamingDetails : null;

    const isLiveBySnippet = liveBroadcastContent === "live";
    const isLiveByDetails =
      details &&
      typeof details.actualStartTime === "string" &&
      details.actualStartTime &&
      (details.actualEndTime === undefined || details.actualEndTime === null);

    if (isLiveBySnippet || isLiveByDetails) liveIds.push(videoId);
  }
  return uniqueExactStrings(liveIds);
}

async function fetchLiveVideoIdsViaUploads(
  apiKey,
  channelId,
  {
    scanLatest,
    maxResults,
    timeoutSeconds,
    uploadsPlaylistIdByChannelId,
    knownLiveVideoIdsByChannelId,
  }
) {
  const uploadsCache =
    uploadsPlaylistIdByChannelId instanceof Map ? uploadsPlaylistIdByChannelId : new Map();
  const knownLiveCache =
    knownLiveVideoIdsByChannelId instanceof Map ? knownLiveVideoIdsByChannelId : new Map();

  const knownIds = knownLiveCache.get(channelId);
  if (Array.isArray(knownIds) && knownIds.length) {
    const stillLive = await filterCurrentlyLiveVideoIds(apiKey, knownIds, { timeoutSeconds });
    if (stillLive.length) {
      knownLiveCache.set(channelId, stillLive);
      return stillLive.slice(0, maxResults);
    }
    knownLiveCache.set(channelId, []);
  }

  let uploadsPlaylistId = uploadsCache.get(channelId);
  if (!uploadsPlaylistId) {
    uploadsPlaylistId = await fetchUploadsPlaylistId(apiKey, channelId, { timeoutSeconds });
    uploadsCache.set(channelId, uploadsPlaylistId);
  }

  const recentVideoIds = await fetchRecentVideoIdsFromUploadsPlaylist(apiKey, uploadsPlaylistId, {
    scanLatest,
    timeoutSeconds,
  });
  const liveIds = await filterCurrentlyLiveVideoIds(apiKey, recentVideoIds, { timeoutSeconds });

  knownLiveCache.set(channelId, liveIds);
  return liveIds.slice(0, maxResults);
}

function extractVideoIdFromUrlOrId(text) {
  const raw = text.trim();
  if (!raw) return null;

  if (raw.length === 11 && /^[a-zA-Z0-9_-]+$/.test(raw)) return raw;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  const host = (parsed.hostname || "").toLowerCase();
  const pathname = parsed.pathname || "";

  if (host === "youtu.be") {
    const candidate = pathname.replace(/^\/+/, "").split("/", 1)[0];
    return candidate || null;
  }

  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (pathname === "/watch") {
      return parsed.searchParams.get("v");
    }
    if (pathname.startsWith("/live/")) {
      const candidate = pathname.slice("/live/".length).split("/", 1)[0];
      return candidate || null;
    }
  }

  return null;
}

function readExistingVideoIds(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") return new Set();
    throw err;
  }

  const ids = new Set();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) continue;
    const parts = stripped.split(/\s+/);
    const lastToken = parts[parts.length - 1];
    const id = extractVideoIdFromUrlOrId(lastToken);
    if (id) ids.add(id);
  }
  return ids;
}

function utcNowIsoSeconds() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function appendNewLiveLinks(outputPath, videoIds, { withTimestamp }) {
  if (!videoIds.length) return { savedVideoIds: [], savedUrls: [] };

  const existing = readExistingVideoIds(outputPath);
  const parent = path.dirname(outputPath);
  if (parent && parent !== ".") fs.mkdirSync(parent, { recursive: true });

  const timestamp = utcNowIsoSeconds();
  const savedVideoIds = [];
  const savedUrls = [];
  let buffer = "";

  for (const videoId of videoIds) {
    if (existing.has(videoId)) continue;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    buffer += withTimestamp ? `${timestamp}\t${url}\n` : `${url}\n`;
    existing.add(videoId);
    savedVideoIds.push(videoId);
    savedUrls.push(url);
  }

  if (buffer) fs.appendFileSync(outputPath, buffer, "utf8");
  return { savedVideoIds, savedUrls };
}

function printHelp() {
  const lines = [
    "Usage:",
    "  bun yt_live_link_saver.js [options]",
    "",
    "Options:",
    "  --api-key <key>            YouTube Data API v3 key (or set YOUTUBE_API_KEY)",
    "  --channels <list>          Channels to check (repeatable; comma-separated): @handle, UC..., or channel URL (or set YOUTUBE_CHANNELS)",
    `  --output <path>            Output file path (or set YOUTUBE_OUTPUT, default: ${DEFAULT_OUTPUT_FILE}; relative paths save next to this script)`,
    "  --env-file <path>          Optional .env file with YOUTUBE_API_KEY, YOUTUBE_CHANNELS, YOUTUBE_OUTPUT, YOUTUBE_INTERVAL_SECONDS",
    "  --max-results <n>          Max number of simultaneous live videos to save (default: 5)",
    `  --scan-latest <n>          When not using --use-search, scan the latest N uploads (1-50, default: ${DEFAULT_SCAN_LATEST})`,
    "  --use-search               Use search.list for discovery (very expensive in YouTube API quota)",
    "  --timeout-seconds <n>      HTTP timeout in seconds (default: 10)",
    "  --with-timestamp           Prefix saved lines with an ISO timestamp and a tab",
    "  --save-to-playlist         Also add newly saved videos to a playlist on your account (requires OAuth)",
    `  --playlist-title <title>   Playlist title to use/create (or set YOUTUBE_PLAYLIST_TITLE, default: ${DEFAULT_PLAYLIST_TITLE})`,
    "  --playlist-id <id>         Playlist ID to use (or set YOUTUBE_PLAYLIST_ID; skips title lookup/create)",
    `  --playlist-privacy <mode>  Playlist privacy: private|unlisted|public (or set YOUTUBE_PLAYLIST_PRIVACY, default: ${DEFAULT_PLAYLIST_PRIVACY})`,
    "  --playlist-sync            Add all videos from the output file to the playlist (OAuth; no channel scan)",
    "  --playlist-sync-output     When saving to a playlist, also keep the playlist in sync with the output file (or set YOUTUBE_PLAYLIST_SYNC_OUTPUT)",
    "  --no-playlist-sync-output  Disable output-file sync; only add newly discovered lives + retry queue",
    "  --oauth-setup              Interactive OAuth helper to generate/store a refresh token",
    "  --oauth-client-id <id>     OAuth client ID (or set YOUTUBE_OAUTH_CLIENT_ID)",
    "  --oauth-client-secret <s>  OAuth client secret (or set YOUTUBE_OAUTH_CLIENT_SECRET)",
    "  --oauth-refresh-token <t>  OAuth refresh token (or set YOUTUBE_OAUTH_REFRESH_TOKEN)",
    "  --oauth-access-token <t>   OAuth access token (or set YOUTUBE_OAUTH_ACCESS_TOKEN; short-lived)",
    `  --oauth-token-file <path>  OAuth token cache file (or set YOUTUBE_OAUTH_TOKEN_FILE, default: ${DEFAULT_OAUTH_TOKEN_FILE})`,
    "  --debug                    Print verbose diagnostics to stderr (never prints tokens)",
    "  --quiet                    Only print errors (useful for cron)",
    "  --loop                     Run forever instead of once",
    `  --interval-seconds <n>      Sleep time between checks when using --loop (or set YOUTUBE_INTERVAL_SECONDS, default: ${DEFAULT_INTERVAL_SECONDS})`,
    "  -h, --help                 Show this help",
  ];
  console.log(lines.join("\n"));
}

function parseArgs(argv) {
  const args = {
    apiKey: null,
    channels: [],
    output: null,
    envFile: null,
    maxResults: 5,
    scanLatest: null,
    useSearch: null,
    timeoutSeconds: 10,
    withTimestamp: false,
    saveToPlaylist: null,
    playlistTitle: null,
    playlistId: null,
    playlistPrivacy: null,
    playlistSync: false,
    playlistSyncOutput: null,
    oauthSetup: false,
    oauthClientId: null,
    oauthClientSecret: null,
    oauthRefreshToken: null,
    oauthAccessToken: null,
    oauthTokenFile: null,
    debug: null,
    quiet: false,
    loop: false,
    intervalSeconds: null,
    help: false,
  };

  const takeValue = (arg, i) => {
    const eq = arg.indexOf("=");
    if (eq !== -1) return { value: arg.slice(eq + 1), nextIndex: i };
    if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
    return { value: argv[i + 1], nextIndex: i + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--with-timestamp") {
      args.withTimestamp = true;
      continue;
    }
    if (arg === "--quiet") {
      args.quiet = true;
      continue;
    }
    if (arg === "--loop") {
      args.loop = true;
      continue;
    }
    if (arg === "--use-search") {
      args.useSearch = true;
      continue;
    }
    if (arg === "--save-to-playlist") {
      args.saveToPlaylist = true;
      continue;
    }
    if (arg === "--playlist-sync") {
      args.playlistSync = true;
      continue;
    }
    if (arg === "--playlist-sync-output") {
      args.playlistSyncOutput = true;
      continue;
    }
    if (arg === "--no-playlist-sync-output") {
      args.playlistSyncOutput = false;
      continue;
    }
    if (arg === "--oauth-setup") {
      args.oauthSetup = true;
      continue;
    }
    if (arg === "--debug") {
      args.debug = true;
      continue;
    }

    if (arg === "--api-key" || arg.startsWith("--api-key=")) {
      const out = takeValue(arg, i);
      args.apiKey = out.value;
      i = out.nextIndex;
      continue;
    }
    if (arg === "--channels" || arg.startsWith("--channels=")) {
      const out = takeValue(arg, i);
      args.channels.push(out.value);
      i = out.nextIndex;
      continue;
    }
    if (arg === "--output" || arg.startsWith("--output=")) {
      const out = takeValue(arg, i);
      args.output = out.value;
      i = out.nextIndex;
      continue;
    }
    if (arg === "--env-file" || arg.startsWith("--env-file=")) {
      const out = takeValue(arg, i);
      args.envFile = out.value;
      i = out.nextIndex;
      continue;
    }
    if (arg === "--max-results" || arg.startsWith("--max-results=")) {
      const out = takeValue(arg, i);
      const n = Number.parseInt(out.value, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error("--max-results must be a positive integer");
      args.maxResults = n;
      i = out.nextIndex;
      continue;
    }
    if (arg === "--scan-latest" || arg.startsWith("--scan-latest=")) {
      const out = takeValue(arg, i);
      const n = Number.parseInt(out.value, 10);
      if (!Number.isFinite(n) || n <= 0 || n > 50) {
        throw new Error("--scan-latest must be an integer between 1 and 50");
      }
      args.scanLatest = n;
      i = out.nextIndex;
      continue;
    }
    if (arg === "--timeout-seconds" || arg.startsWith("--timeout-seconds=")) {
      const out = takeValue(arg, i);
      const n = Number.parseFloat(out.value);
      if (!Number.isFinite(n) || n <= 0) throw new Error("--timeout-seconds must be a positive number");
      args.timeoutSeconds = n;
      i = out.nextIndex;
      continue;
    }
    if (arg === "--interval-seconds" || arg.startsWith("--interval-seconds=")) {
      const out = takeValue(arg, i);
      const n = Number.parseInt(out.value, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error("--interval-seconds must be a positive integer");
      args.intervalSeconds = n;
      i = out.nextIndex;
      continue;
    }
    if (arg === "--playlist-title" || arg.startsWith("--playlist-title=")) {
      const out = takeValue(arg, i);
      args.playlistTitle = out.value;
      i = out.nextIndex;
      continue;
    }
    if (arg === "--playlist-id" || arg.startsWith("--playlist-id=")) {
      const out = takeValue(arg, i);
      args.playlistId = out.value;
      i = out.nextIndex;
      continue;
    }
    if (arg === "--playlist-privacy" || arg.startsWith("--playlist-privacy=")) {
      const out = takeValue(arg, i);
      args.playlistPrivacy = out.value;
      i = out.nextIndex;
      continue;
    }
    if (arg === "--oauth-client-id" || arg.startsWith("--oauth-client-id=")) {
      const out = takeValue(arg, i);
      args.oauthClientId = out.value;
      i = out.nextIndex;
      continue;
    }
    if (arg === "--oauth-client-secret" || arg.startsWith("--oauth-client-secret=")) {
      const out = takeValue(arg, i);
      args.oauthClientSecret = out.value;
      i = out.nextIndex;
      continue;
    }
    if (arg === "--oauth-refresh-token" || arg.startsWith("--oauth-refresh-token=")) {
      const out = takeValue(arg, i);
      args.oauthRefreshToken = out.value;
      i = out.nextIndex;
      continue;
    }
    if (arg === "--oauth-access-token" || arg.startsWith("--oauth-access-token=")) {
      const out = takeValue(arg, i);
      args.oauthAccessToken = out.value;
      i = out.nextIndex;
      continue;
    }
    if (arg === "--oauth-token-file" || arg.startsWith("--oauth-token-file=")) {
      const out = takeValue(arg, i);
      args.oauthTokenFile = out.value;
      i = out.nextIndex;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function resolveOauthTokenFilePath(args) {
  const raw = stripQuotes(args.oauthTokenFile || process.env.YOUTUBE_OAUTH_TOKEN_FILE || "").trim();
  if (raw) return resolveOutputPath(raw);
  return path.resolve(SCRIPT_DIR, DEFAULT_OAUTH_TOKEN_FILE);
}

function readOauthRefreshTokenFromFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") return null;
    throw err;
  }

  const trimmed = String(content || "").trim();
  if (!trimmed) return null;

  try {
    const data = JSON.parse(trimmed);
    if (!data || typeof data !== "object") return null;
    const token =
      typeof data.refresh_token === "string"
        ? data.refresh_token
        : typeof data.refreshToken === "string"
          ? data.refreshToken
          : null;
    return token ? token.trim() : null;
  } catch {
    return trimmed;
  }
}

function writeOauthRefreshTokenToFile(filePath, refreshToken) {
  const token = String(refreshToken || "").trim();
  if (!token) throw new Error("Refusing to write empty OAuth refresh token.");

  const parent = path.dirname(filePath);
  if (parent && parent !== ".") fs.mkdirSync(parent, { recursive: true });

  const data = {
    refresh_token: token,
    updated_at: utcNowIsoSeconds(),
  };

  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
}

function resolveOauthConfig(args) {
  const clientId = stripQuotes(args.oauthClientId || process.env.YOUTUBE_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = stripQuotes(
    args.oauthClientSecret || process.env.YOUTUBE_OAUTH_CLIENT_SECRET || ""
  ).trim();
  let refreshToken = stripQuotes(
    args.oauthRefreshToken || process.env.YOUTUBE_OAUTH_REFRESH_TOKEN || ""
  ).trim();
  const accessToken = stripQuotes(
    args.oauthAccessToken || process.env.YOUTUBE_OAUTH_ACCESS_TOKEN || ""
  ).trim();
  const tokenFilePath = resolveOauthTokenFilePath(args);

  if (!refreshToken && tokenFilePath) {
    const fromFile = readOauthRefreshTokenFromFile(tokenFilePath);
    if (fromFile) {
      refreshToken = fromFile;
      debugLog(args, `OAuth: loaded refresh token from ${tokenFilePath}`);
    } else {
      debugLog(args, `OAuth: no refresh token found in ${tokenFilePath}`);
    }
  }
  if (clientId) debugLog(args, `OAuth: client_id=${formatMaybeMasked(clientId)}`);

  return {
    clientId: clientId || null,
    clientSecret: clientSecret || null,
    refreshToken: refreshToken || null,
    accessToken: accessToken || null,
    tokenFilePath,
  };
}

function normalizePlaylistPrivacy(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "private" || raw === "unlisted" || raw === "public") return raw;
  throw new Error("Playlist privacy must be one of: private, unlisted, public");
}

function derivePlaylistQueuePath(outputPath) {
  const ext = path.extname(outputPath);
  if (ext) return outputPath.slice(0, -ext.length) + ".playlist_queue" + ext;
  return outputPath + ".playlist_queue.txt";
}

function resolvePlaylistQueuePath(outputPath) {
  const raw = String(process.env.YOUTUBE_PLAYLIST_QUEUE_FILE || "").trim();
  if (raw) return resolveOutputPath(raw);
  return derivePlaylistQueuePath(outputPath);
}

function derivePlaylistStatePath(outputPath) {
  const ext = path.extname(outputPath);
  if (ext) return outputPath.slice(0, -ext.length) + ".playlist_state.json";
  return outputPath + ".playlist_state.json";
}

function resolvePlaylistStatePath(outputPath) {
  const raw = String(process.env.YOUTUBE_PLAYLIST_STATE_FILE || "").trim();
  if (raw) return resolveOutputPath(raw);
  return derivePlaylistStatePath(outputPath);
}

function readPlaylistStateFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") return null;
    throw err;
  }

  const trimmed = String(content || "").trim();
  if (!trimmed) return null;

  try {
    const data = JSON.parse(trimmed);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

function writePlaylistStateFile(filePath, data) {
  const parent = path.dirname(filePath);
  if (parent && parent !== ".") fs.mkdirSync(parent, { recursive: true });

  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
}

function fileFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      size: Number(stat.size) || 0,
      mtimeMs: Number(stat.mtimeMs) || 0,
    };
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") return null;
    throw err;
  }
}

function sameFingerprint(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return Number(a.size) === Number(b.size) && Number(a.mtimeMs) === Number(b.mtimeMs);
}

function shouldSyncOutputToPlaylist(stateData, playlistKey, outputFingerprint) {
  if (!outputFingerprint || Number(outputFingerprint.size) <= 0) return false;
  if (!stateData || typeof stateData !== "object") return true;
  const statePlaylistKey = typeof stateData.playlistKey === "string" ? stateData.playlistKey : null;
  if (!statePlaylistKey || statePlaylistKey !== playlistKey) return true;
  const stateFingerprint =
    stateData.outputFingerprint && typeof stateData.outputFingerprint === "object"
      ? stateData.outputFingerprint
      : null;
  return !sameFingerprint(stateFingerprint, outputFingerprint);
}

function writePlaylistSyncState(playlistStatePath, { playlistKey, playlistId, outputPath }) {
  const outputFingerprint = fileFingerprint(outputPath);
  const data = {
    version: 1,
    playlistKey,
    playlistId: playlistId || null,
    outputPath,
    outputFingerprint,
    updatedAt: utcNowIsoSeconds(),
  };
  writePlaylistStateFile(playlistStatePath, data);
}

function readVideoIdQueue(queuePath) {
  let content;
  try {
    content = fs.readFileSync(queuePath, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") return [];
    throw err;
  }

  const ids = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) continue;
    const parts = stripped.split(/\s+/);
    const lastToken = parts[parts.length - 1];
    const id = extractVideoIdFromUrlOrId(lastToken);
    if (id) ids.push(id);
  }
  return uniqueExactStrings(ids);
}

function writeVideoIdQueue(queuePath, videoIds) {
  const ids = uniqueExactStrings(videoIds);
  const parent = path.dirname(queuePath);
  if (parent && parent !== ".") fs.mkdirSync(parent, { recursive: true });

  if (!ids.length) {
    try {
      fs.unlinkSync(queuePath);
    } catch {
      // ignore
    }
    return;
  }

  fs.writeFileSync(queuePath, `${ids.join("\n")}\n`, "utf8");
}

async function flushPlaylistQueue(args, state, outputPath, newVideoIds, { timeoutSeconds, ensurePlaylist } = {}) {
  const queuePath = resolvePlaylistQueuePath(outputPath);
  const existingQueue = readVideoIdQueue(queuePath);
  const newIds = Array.isArray(newVideoIds) ? newVideoIds : [];

  if (!existingQueue.length && !newIds.length) {
    if (!ensurePlaylist) {
      debugLog(args, `Playlist queue: path=${queuePath} empty (nothing to flush)`);
      return { queuePath, playlistId: null, addedCount: 0, failures: [], remainingCount: 0 };
    }

    debugLog(args, `Playlist queue: path=${queuePath} empty (ensuring playlist exists)`);
    try {
      const accessToken = await getYouTubeAccessTokenAuto(args, state, { timeoutSeconds });
      const playlistId = await resolveTargetPlaylistId(args, accessToken, state, { timeoutSeconds });
      debugLog(args, `Playlist: ensured ${playlistId}`);
      return { queuePath, playlistId, addedCount: 0, failures: [], remainingCount: 0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog(args, `Playlist queue: ensure error: ${message}`);
      return {
        queuePath,
        playlistId: null,
        addedCount: 0,
        failures: [{ videoId: "playlist", message }],
        remainingCount: 0,
      };
    }
  }

  const mergedQueue = uniqueExactStrings([...existingQueue, ...newIds]);
  writeVideoIdQueue(queuePath, mergedQueue);
  debugLog(
    args,
    `Playlist queue: path=${queuePath} existing=${existingQueue.length} new=${newIds.length} merged=${mergedQueue.length}`
  );

  if (!mergedQueue.length) {
    debugLog(args, "Playlist queue: empty after merge; skipping API call.");
    return { queuePath, playlistId: null, addedCount: 0, failures: [], remainingCount: 0 };
  }

  try {
    const accessToken = await getYouTubeAccessTokenAuto(args, state, { timeoutSeconds });
    const playlistId = await resolveTargetPlaylistId(args, accessToken, state, { timeoutSeconds });
    const result = await addVideoIdsToPlaylist(accessToken, playlistId, mergedQueue, {
      timeoutSeconds,
      debug: isDebugEnabled(args),
    });

    const failedIds = new Set(result.failures.map((f) => f.videoId));
    const remaining = mergedQueue.filter((id) => failedIds.has(id));
    writeVideoIdQueue(queuePath, remaining);
    debugLog(args, `Playlist queue: remaining=${remaining.length}`);

    return {
      queuePath,
      playlistId,
      addedCount: result.addedCount,
      failures: result.failures,
      remainingCount: remaining.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog(args, `Playlist queue: flush error: ${message}`);
    return {
      queuePath,
      playlistId: null,
      addedCount: 0,
      failures: [{ videoId: "playlist", message }],
      remainingCount: mergedQueue.length,
    };
  }
}

async function syncOutputFileToPlaylist(args, state, outputPath, { timeoutSeconds } = {}) {
  const queuePath = resolvePlaylistQueuePath(outputPath);
  const existingQueue = readVideoIdQueue(queuePath);
  const outputIds = Array.from(readExistingVideoIds(outputPath));
  const desiredIds = uniqueExactStrings([...existingQueue, ...outputIds]);

  if (!desiredIds.length) {
    debugLog(args, `Playlist sync-output: output+queue empty; skipping (queuePath=${queuePath})`);
    return { queuePath, playlistId: null, addedCount: 0, failures: [], remainingCount: existingQueue.length, synced: true };
  }

  try {
    const accessToken = await getYouTubeAccessTokenAuto(args, state, { timeoutSeconds });
    const playlistId = await resolveTargetPlaylistId(args, accessToken, state, { timeoutSeconds });
    const alreadyInPlaylist = await fetchPlaylistVideoIdSet(accessToken, playlistId, { timeoutSeconds });

    const pending = desiredIds.filter((id) => !alreadyInPlaylist.has(id));
    debugLog(
      args,
      `Playlist sync-output: playlistId=${playlistId} output=${outputIds.length} queue=${existingQueue.length} missing=${pending.length}`
    );

    if (!pending.length) {
      if (existingQueue.length) writeVideoIdQueue(queuePath, []);
      return { queuePath, playlistId, addedCount: 0, failures: [], remainingCount: 0, synced: true };
    }

    const result = await addVideoIdsToPlaylist(accessToken, playlistId, pending, {
      timeoutSeconds,
      debug: isDebugEnabled(args),
    });

    const failedIds = new Set(result.failures.map((f) => f.videoId));
    const remaining = pending.filter((id) => failedIds.has(id));
    writeVideoIdQueue(queuePath, remaining);
    debugLog(args, `Playlist sync-output: remaining=${remaining.length}`);

    return {
      queuePath,
      playlistId,
      addedCount: result.addedCount,
      failures: result.failures,
      remainingCount: remaining.length,
      synced: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog(args, `Playlist sync-output: error=${message}`);
    return {
      queuePath,
      playlistId: null,
      addedCount: 0,
      failures: [{ videoId: "playlist", message }],
      remainingCount: desiredIds.length,
      synced: false,
    };
  }
}

async function refreshAccessToken(oauth, { timeoutSeconds }) {
  const clientId = oauth && typeof oauth.clientId === "string" ? oauth.clientId : null;
  const clientSecret = oauth && typeof oauth.clientSecret === "string" ? oauth.clientSecret : null;
  const refreshToken = oauth && typeof oauth.refreshToken === "string" ? oauth.refreshToken : null;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing OAuth credentials. Set YOUTUBE_OAUTH_CLIENT_ID, YOUTUBE_OAUTH_CLIENT_SECRET, and YOUTUBE_OAUTH_REFRESH_TOKEN (or pass --oauth-... flags)."
    );
  }

  const data = await apiPostForm(
    GOOGLE_OAUTH_TOKEN_ENDPOINT,
    {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
    { timeoutSeconds }
  );

  const token = data && typeof data.access_token === "string" ? data.access_token : null;
  const expiresIn = data && Number.isFinite(data.expires_in) ? Number(data.expires_in) : null;
  if (!token) throw new Error("OAuth token refresh succeeded but no access_token was returned.");

  return { accessToken: token, expiresInSeconds: expiresIn };
}

async function getYouTubeAccessToken(oauth, state, { timeoutSeconds }) {
  const accessTokenFromEnv = oauth && typeof oauth.accessToken === "string" ? oauth.accessToken : null;
  if (accessTokenFromEnv) return accessTokenFromEnv;

  const oauthState = state && state.oauth && typeof state.oauth === "object" ? state.oauth : null;
  const now = Date.now();
  if (
    oauthState &&
    typeof oauthState.accessToken === "string" &&
    oauthState.accessToken &&
    Number.isFinite(oauthState.expiresAtMs) &&
    oauthState.expiresAtMs - now > 60_000
  ) {
    return oauthState.accessToken;
  }

  const refreshed = await refreshAccessToken(oauth, { timeoutSeconds });
  if (oauthState) {
    oauthState.accessToken = refreshed.accessToken;
    const ttlMs = Math.max(60_000, Number(refreshed.expiresInSeconds || 0) * 1000);
    oauthState.expiresAtMs = now + ttlMs;
  }
  return refreshed.accessToken;
}

function shouldAutoSetupOauth(args) {
  const env = getEnvBool("YOUTUBE_OAUTH_AUTO_SETUP");
  if (env !== null) return env;
  if (args && args.quiet) return false;
  return Boolean(process.stdin && process.stdin.isTTY && process.stdout && process.stdout.isTTY);
}

async function listMyPlaylistsPage(accessToken, { pageToken, timeoutSeconds }) {
  const data = await apiGetJson(
    YOUTUBE_PLAYLISTS_ENDPOINT,
    {
      part: "snippet",
      mine: "true",
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
      fields: "items(id,snippet(title)),nextPageToken",
    },
    { timeoutSeconds, headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const items = Array.isArray(data.items) ? data.items : [];
  const nextPageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : null;
  return { items, nextPageToken };
}

async function findPlaylistIdByTitle(accessToken, title, { timeoutSeconds }) {
  const target = String(title || "").trim();
  if (!target) throw new Error("Playlist title is empty.");
  const targetLower = target.toLowerCase();

  let pageToken = null;
  while (true) {
    const page = await listMyPlaylistsPage(accessToken, { pageToken, timeoutSeconds });
    for (const item of page.items) {
      const id = item && typeof item.id === "string" ? item.id : null;
      const itemTitle =
        item && item.snippet && typeof item.snippet.title === "string" ? item.snippet.title : null;
      if (!id || !itemTitle) continue;
      if (itemTitle.trim().toLowerCase() === targetLower) return id;
    }
    if (!page.nextPageToken) return null;
    pageToken = page.nextPageToken;
  }
}

async function createPlaylist(accessToken, title, privacyStatus, { timeoutSeconds }) {
  const data = await apiPostJson(
    YOUTUBE_PLAYLISTS_ENDPOINT,
    { part: "snippet,status", fields: "id" },
    {
      snippet: {
        title: String(title || "").trim(),
      },
      status: {
        privacyStatus,
      },
    },
    { timeoutSeconds, headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const id = data && typeof data.id === "string" ? data.id : null;
  if (!id) throw new Error("Playlist creation succeeded but no playlist id was returned.");
  return id;
}

function resolvePlaylistTargetKey(args) {
  const fromArgs = String(args.playlistId || "").trim();
  const fromEnv = String(process.env.YOUTUBE_PLAYLIST_ID || "").trim();
  const explicit = fromArgs || fromEnv || null;
  if (explicit) return `id:${explicit}`;

  const title = String(args.playlistTitle || process.env.YOUTUBE_PLAYLIST_TITLE || DEFAULT_PLAYLIST_TITLE).trim();
  let privacy = args.playlistPrivacy;
  if (!privacy) privacy = process.env.YOUTUBE_PLAYLIST_PRIVACY;
  privacy = normalizePlaylistPrivacy(privacy) || DEFAULT_PLAYLIST_PRIVACY;
  return `title:${title}|privacy:${privacy}`;
}

async function resolveTargetPlaylistId(args, oauthAccessToken, state, { timeoutSeconds }) {
  const fromArgs = String(args.playlistId || "").trim();
  const fromEnv = String(process.env.YOUTUBE_PLAYLIST_ID || "").trim();
  const explicit = fromArgs || fromEnv || null;
  if (explicit) {
    debugLog(args, `Playlist: using explicit playlist id ${explicit}`);
    return explicit;
  }

  if (state && typeof state.playlistId === "string" && state.playlistId) return state.playlistId;

  const title = String(args.playlistTitle || process.env.YOUTUBE_PLAYLIST_TITLE || DEFAULT_PLAYLIST_TITLE).trim();
  if (!title) throw new Error("Playlist title is empty. Set YOUTUBE_PLAYLIST_TITLE or pass --playlist-title.");

  let privacy = args.playlistPrivacy;
  if (!privacy) privacy = process.env.YOUTUBE_PLAYLIST_PRIVACY;
  privacy = normalizePlaylistPrivacy(privacy) || DEFAULT_PLAYLIST_PRIVACY;

  debugLog(args, `Playlist: looking up "${title}" (${privacy})`);
  let playlistId = await findPlaylistIdByTitle(oauthAccessToken, title, { timeoutSeconds });
  if (!playlistId) {
    debugLog(args, `Playlist: not found; creating "${title}" (${privacy})`);
    playlistId = await createPlaylist(oauthAccessToken, title, privacy, { timeoutSeconds });
    debugLog(args, `Playlist: created ${playlistId}`);
    await waitForPlaylistToBeReady(args, oauthAccessToken, playlistId, { timeoutSeconds });
  } else {
    debugLog(args, `Playlist: found ${playlistId}`);
  }

  if (state) state.playlistId = playlistId;
  return playlistId;
}

async function insertVideoIntoPlaylist(accessToken, playlistId, videoId, { timeoutSeconds }) {
  await apiPostJson(
    YOUTUBE_PLAYLIST_ITEMS_ENDPOINT,
    { part: "snippet" },
    {
      snippet: {
        playlistId,
        resourceId: {
          kind: "youtube#video",
          videoId,
        },
      },
    },
    { timeoutSeconds, headers: { Authorization: `Bearer ${accessToken}` } }
  );
}

async function fetchPlaylistVideoIdSet(accessToken, playlistId, { timeoutSeconds }) {
  const ids = new Set();
  let pageToken = null;

  while (true) {
    const data = await apiGetJson(
      YOUTUBE_PLAYLIST_ITEMS_ENDPOINT,
      {
        part: "contentDetails",
        playlistId,
        maxResults: "50",
        ...(pageToken ? { pageToken } : {}),
        fields: "items(contentDetails(videoId)),nextPageToken",
      },
      { timeoutSeconds, headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const videoId =
        item &&
        item.contentDetails &&
        typeof item.contentDetails.videoId === "string" &&
        item.contentDetails.videoId
          ? item.contentDetails.videoId
          : null;
      if (videoId) ids.add(videoId);
    }

    const nextToken = typeof data.nextPageToken === "string" ? data.nextPageToken : null;
    if (!nextToken) break;
    pageToken = nextToken;
  }

  return ids;
}

async function addVideoIdsToPlaylist(accessToken, playlistId, videoIds, { timeoutSeconds, debug }) {
  const ids = uniqueExactStrings(videoIds);
  const failures = [];
  let addedCount = 0;

  if (debug) console.error("[debug]", `Playlist: inserting ${ids.length} items into ${playlistId}`);

  for (const videoId of ids) {
    try {
      await insertVideoIntoPlaylist(accessToken, playlistId, videoId, { timeoutSeconds });
      addedCount += 1;
      if (debug) console.error("[debug]", `Playlist: added ${videoId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (debug) console.error("[debug]", `Playlist: failed ${videoId}: ${message}`);
      failures.push({
        videoId,
        message,
      });
    }
  }

  if (debug) console.error("[debug]", `Playlist: done (added=${addedCount}, failed=${failures.length})`);
  return { addedCount, failures };
}

async function obtainOauthTokensInteractive(oauth, { timeoutSeconds }) {
  if (!oauth || !oauth.clientId || !oauth.clientSecret) {
    throw new Error("Missing OAuth client. Set YOUTUBE_OAUTH_CLIENT_ID and YOUTUBE_OAUTH_CLIENT_SECRET.");
  }

  const stateToken = crypto.randomBytes(16).toString("hex");
  let redirectUri = null;
  let rl = null;

  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const parseOauthUserInput = (input) => {
    const raw = String(input || "").trim();
    if (!raw) return null;

    if (raw.includes("://")) {
      try {
        const parsedUrl = new URL(raw);
        const code = parsedUrl.searchParams.get("code");
        const state = parsedUrl.searchParams.get("state");
        if (code) return { code, state };
      } catch {
        // ignore
      }
    }

    if (raw.includes("code=")) {
      const qs = raw.startsWith("?") ? raw.slice(1) : raw;
      try {
        const params = new URLSearchParams(qs);
        const code = params.get("code");
        const state = params.get("state");
        if (code) return { code, state };
      } catch {
        // ignore
      }
    }

    return { code: raw, state: null };
  };

  let finished = false;

  function cleanup() {
    if (rl) {
      try {
        rl.close();
      } catch {
        // ignore
      }
      rl = null;
    }
  }

  function succeed(code) {
    if (finished) return;
    finished = true;
    cleanup();
    resolveCode({ code });
  }

  function fail(err) {
    if (finished) return;
    finished = true;
    cleanup();
    rejectCode(err);
  }

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end("Missing URL");
      return;
    }

    let parsed;
    try {
      parsed = new URL(req.url, "http://127.0.0.1");
    } catch {
      res.statusCode = 400;
      res.end("Bad request");
      return;
    }

    if (parsed.pathname !== "/oauth2callback") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const returnedState = parsed.searchParams.get("state");
    const error = parsed.searchParams.get("error");
    const code = parsed.searchParams.get("code");

    if (returnedState !== stateToken) {
      res.statusCode = 400;
      res.end("State mismatch. You can close this tab.");
      console.error("OAuth state mismatch; ignoring callback.");
      return;
    }

    if (error) {
      res.statusCode = 400;
      res.end("OAuth error. You can close this tab.");
      console.error(`OAuth error: ${error}`);
      return;
    }

    if (!code) {
      res.statusCode = 400;
      res.end("Missing code. You can close this tab.");
      console.error("OAuth callback missing code.");
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Auth complete. You can close this tab and return to the terminal.");
    try {
      server.close();
    } catch {
      // ignore
    }
    succeed(code);
  });

  server.on("error", (err) => fail(err));

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : null;
    if (!port) {
      try {
        server.close();
      } catch {
        // ignore
      }
      fail(new Error("Failed to start local OAuth callback server."));
      return;
    }

    redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
    const url = new URL(GOOGLE_OAUTH_AUTH_ENDPOINT);
    url.searchParams.set("client_id", oauth.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("scope", "https://www.googleapis.com/auth/youtube");
    url.searchParams.set("state", stateToken);

    console.log("Open this URL in your browser to authorize YouTube access:");
    console.log(url.toString());
    console.log("");
    console.log("Waiting for authorization...");

    if (process.stdin && process.stdin.isTTY && process.stdout && process.stdout.isTTY) {
      console.log("");
      console.log("If your browser is on a different machine:");
      console.log("1) Approve access in the browser.");
      console.log("2) It will redirect to a localhost URL and may fail to load.");
      console.log("3) Copy the full redirect URL (or just the code=... value) and paste it below.");

      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.setPrompt("> ");
      rl.prompt();
      rl.on("line", (line) => {
        const parsedInput = parseOauthUserInput(line);
        const code = parsedInput && typeof parsedInput.code === "string" ? parsedInput.code.trim() : null;
        const returnedState =
          parsedInput && typeof parsedInput.state === "string" ? parsedInput.state.trim() : null;

        if (!code) {
          console.error("Could not parse a code. Paste the full redirect URL or the code value.");
          rl.prompt();
          return;
        }
        if (returnedState && returnedState !== stateToken) {
          console.error("State mismatch. Paste the redirect URL from the same authorization attempt.");
          rl.prompt();
          return;
        }

        try {
          server.close();
        } catch {
          // ignore
        }
        succeed(code);
      });
      rl.on("SIGINT", () => {
        try {
          server.close();
        } catch {
          // ignore
        }
        fail(new Error("Cancelled."));
      });
    }
  });

  const { code } = await codePromise;
  if (!redirectUri) throw new Error("OAuth setup failed: redirect URI was not initialized.");
  const data = await apiPostForm(
    GOOGLE_OAUTH_TOKEN_ENDPOINT,
    {
      code,
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    },
    { timeoutSeconds }
  );

  const refreshToken =
    data && typeof data.refresh_token === "string" ? data.refresh_token.trim() : null;
  if (!refreshToken) {
    throw new Error(
      "No refresh_token returned. If you already authorized this app before, revoke access in your Google Account and try again."
    );
  }

  const accessToken = data && typeof data.access_token === "string" ? data.access_token.trim() : null;
  const expiresIn = data && Number.isFinite(data.expires_in) ? Number(data.expires_in) : null;
  if (!accessToken) throw new Error("OAuth exchange succeeded but no access_token was returned.");

  return { refreshToken, accessToken, expiresInSeconds: expiresIn };
}

async function getYouTubeAccessTokenAuto(args, state, { timeoutSeconds }) {
  const oauth = resolveOauthConfig(args);

  const accessTokenFromEnv = oauth && typeof oauth.accessToken === "string" ? oauth.accessToken : null;
  if (accessTokenFromEnv) {
    debugLog(args, "OAuth: using access token from env/flag");
    return accessTokenFromEnv;
  }

  const oauthState = state && state.oauth && typeof state.oauth === "object" ? state.oauth : null;
  const now = Date.now();
  if (
    oauthState &&
    typeof oauthState.accessToken === "string" &&
    oauthState.accessToken &&
    Number.isFinite(oauthState.expiresAtMs) &&
    oauthState.expiresAtMs - now > 60_000
  ) {
    debugLog(args, "OAuth: using cached access token");
    return oauthState.accessToken;
  }

  const refreshToken = oauth && typeof oauth.refreshToken === "string" ? oauth.refreshToken : null;
  if (!refreshToken) {
    if (!oauth.clientId || !oauth.clientSecret) {
      throw new Error(
        "Missing OAuth client. Set YOUTUBE_OAUTH_CLIENT_ID and YOUTUBE_OAUTH_CLIENT_SECRET, then run --oauth-setup (or run once interactively with playlist saving enabled)."
      );
    }
    if (!shouldAutoSetupOauth(args)) {
      throw new Error(
        "Missing OAuth refresh token. Run --oauth-setup once (interactive), or set YOUTUBE_OAUTH_REFRESH_TOKEN."
      );
    }

    console.log("OAuth refresh token not found; starting one-time OAuth setup...");
    const obtained = await obtainOauthTokensInteractive(oauth, { timeoutSeconds });
    oauth.refreshToken = obtained.refreshToken;
    if (oauth.tokenFilePath) writeOauthRefreshTokenToFile(oauth.tokenFilePath, obtained.refreshToken);
    if (oauth.tokenFilePath) debugLog(args, `OAuth: wrote refresh token to ${oauth.tokenFilePath}`);

    if (oauthState) {
      oauthState.accessToken = obtained.accessToken;
      const ttlMs = Math.max(60_000, Number(obtained.expiresInSeconds || 0) * 1000);
      oauthState.expiresAtMs = now + ttlMs;
    }

    return obtained.accessToken;
  }

  debugLog(args, "OAuth: refreshing access token");
  return getYouTubeAccessToken(oauth, state, { timeoutSeconds });
}

async function runOauthSetup(args) {
  const oauth = resolveOauthConfig(args);
  if (!oauth.clientId || !oauth.clientSecret) {
    console.error("Missing OAuth client. Set YOUTUBE_OAUTH_CLIENT_ID and YOUTUBE_OAUTH_CLIENT_SECRET.");
    return 2;
  }

  let refreshToken;
  try {
    const obtained = await obtainOauthTokensInteractive(oauth, { timeoutSeconds: args.timeoutSeconds });
    refreshToken = obtained.refreshToken;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (oauth.tokenFilePath) {
    try {
      writeOauthRefreshTokenToFile(oauth.tokenFilePath, refreshToken);
      console.log("");
      console.log(`Saved refresh token to: ${oauth.tokenFilePath}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  console.log("");
  console.log("Add these to your .env:");
  console.log(`YOUTUBE_OAUTH_CLIENT_ID=${oauth.clientId}`);
  console.log(`YOUTUBE_OAUTH_CLIENT_SECRET=${oauth.clientSecret}`);
  console.log(`YOUTUBE_OAUTH_REFRESH_TOKEN=${refreshToken}`);
  return 0;
}

async function runPlaylistSync(args, state) {
  const rawOutputPath = args.output || process.env.YOUTUBE_OUTPUT || DEFAULT_OUTPUT_FILE;
  const outputPath = resolveOutputPath(rawOutputPath);

  debugLog(args, `Playlist sync: output=${outputPath}`);

  const accessToken = await getYouTubeAccessTokenAuto(args, state, { timeoutSeconds: args.timeoutSeconds });
  const playlistId = await resolveTargetPlaylistId(args, accessToken, state, {
    timeoutSeconds: args.timeoutSeconds,
  });
  const playlistKey = resolvePlaylistTargetKey(args);
  const playlistStatePath = resolvePlaylistStatePath(outputPath);

  const notePlaylistSynced = () => {
    try {
      writePlaylistSyncState(playlistStatePath, { playlistKey, playlistId, outputPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog(args, `Playlist state: write error=${message}`);
    }
  };

  const existing = readExistingVideoIds(outputPath);
  const savedIds = Array.from(existing);
  if (!savedIds.length) {
    if (!args.quiet) console.log("No saved video IDs found to sync.");
    notePlaylistSynced();
    return 0;
  }

  const alreadyInPlaylist = await fetchPlaylistVideoIdSet(accessToken, playlistId, {
    timeoutSeconds: args.timeoutSeconds,
  });
  debugLog(args, `Playlist sync: playlist contains ${alreadyInPlaylist.size} items`);
  const videoIds = savedIds.filter((id) => !alreadyInPlaylist.has(id));
  if (!videoIds.length) {
    if (!args.quiet) console.log("Playlist already contains all saved videos.");
    notePlaylistSynced();
    return 0;
  }

  const result = await addVideoIdsToPlaylist(accessToken, playlistId, videoIds, {
    timeoutSeconds: args.timeoutSeconds,
    debug: isDebugEnabled(args),
  });

  if (!args.quiet) console.log(`Added ${result.addedCount}/${videoIds.length} to playlist.`);
  if (result.failures.length) {
    console.error(
      result.failures.map((f) => `[${f.videoId}] ${f.message}`).slice(0, 20).join("\n")
    );
    if (result.failures.length > 20) {
      console.error(`...and ${result.failures.length - 20} more`);
    }
    return 1;
  }

  notePlaylistSynced();
  return 0;
}

async function runOnce(args, state) {
  const apiKey = args.apiKey || process.env.YOUTUBE_API_KEY;
  const channelInputs = getChannelInputs(args);
  const rawOutputPath = args.output || process.env.YOUTUBE_OUTPUT || DEFAULT_OUTPUT_FILE;
  const outputPath = resolveOutputPath(rawOutputPath);
  const channelIdByInput = state && state.channelIdByInput instanceof Map ? state.channelIdByInput : new Map();
  const uploadsPlaylistIdByChannelId =
    state && state.uploadsPlaylistIdByChannelId instanceof Map
      ? state.uploadsPlaylistIdByChannelId
      : new Map();
  const knownLiveVideoIdsByChannelId =
    state && state.knownLiveVideoIdsByChannelId instanceof Map
      ? state.knownLiveVideoIdsByChannelId
      : new Map();

  if (!apiKey) {
    console.error("Missing API key. Pass --api-key or set YOUTUBE_API_KEY.");
    return 2;
  }
  if (!channelInputs.length) {
    console.error("Missing channels. Pass --channels or set YOUTUBE_CHANNELS.");
    return 2;
  }

  let scanLatest = args.scanLatest;
  if (scanLatest === null) scanLatest = getEnvInt("YOUTUBE_SCAN_LATEST");
  if (scanLatest === null) scanLatest = DEFAULT_SCAN_LATEST;
  if (!Number.isFinite(scanLatest) || scanLatest <= 0 || scanLatest > 50) {
    console.error("YOUTUBE_SCAN_LATEST must be an integer between 1 and 50.");
    return 2;
  }

  let useSearch = args.useSearch;
  if (useSearch === null) {
    const envUseSearch = getEnvBool("YOUTUBE_USE_SEARCH");
    useSearch = envUseSearch === null ? false : envUseSearch;
  }

  let saveToPlaylist = args.saveToPlaylist;
  if (saveToPlaylist === null) {
    const envSaveToPlaylist = getEnvBool("YOUTUBE_SAVE_TO_PLAYLIST");
    saveToPlaylist = envSaveToPlaylist === null ? false : envSaveToPlaylist;
  }

  let playlistSyncOutputEnabled = false;
  let playlistTargetKey = null;
  let playlistStatePath = null;
  let outputFingerprintAtStart = null;
  let needsPlaylistBackfill = false;

  if (saveToPlaylist) {
    let playlistSyncOutput = args.playlistSyncOutput;
    if (playlistSyncOutput === null) {
      const envSyncOutput = getEnvBool("YOUTUBE_PLAYLIST_SYNC_OUTPUT");
      playlistSyncOutput = envSyncOutput === null ? true : envSyncOutput;
    }

    playlistSyncOutputEnabled = Boolean(playlistSyncOutput);
    playlistTargetKey = resolvePlaylistTargetKey(args);
    playlistStatePath = resolvePlaylistStatePath(outputPath);
    outputFingerprintAtStart = fileFingerprint(outputPath);
    const playlistState = readPlaylistStateFile(playlistStatePath);
    needsPlaylistBackfill =
      playlistSyncOutputEnabled && shouldSyncOutputToPlaylist(playlistState, playlistTargetKey, outputFingerprintAtStart);
  }

  debugLog(
    args,
    `Run: channels=${channelInputs.length} output=${outputPath} useSearch=${useSearch} scanLatest=${scanLatest} maxResults=${args.maxResults} saveToPlaylist=${saveToPlaylist}`
  );
  if (isDebugEnabled(args) && channelInputs.length <= 10) {
    debugLog(args, `Run: channelInputs=${channelInputs.join(", ")}`);
  }
  if (saveToPlaylist) {
    const playlistTitle = String(
      args.playlistTitle || process.env.YOUTUBE_PLAYLIST_TITLE || DEFAULT_PLAYLIST_TITLE
    ).trim();
    const playlistId = String(args.playlistId || process.env.YOUTUBE_PLAYLIST_ID || "").trim();
    const playlistPrivacy = String(args.playlistPrivacy || process.env.YOUTUBE_PLAYLIST_PRIVACY || "").trim();
    const queuePath = resolvePlaylistQueuePath(outputPath);

    debugLog(args, `Playlist: title="${playlistTitle || DEFAULT_PLAYLIST_TITLE}"`);
    if (playlistId) debugLog(args, `Playlist: explicitId=${playlistId}`);
    if (playlistPrivacy) debugLog(args, `Playlist: privacy=${playlistPrivacy}`);
    debugLog(args, `Playlist: queuePath=${queuePath}`);
    if (playlistSyncOutputEnabled) {
      debugLog(args, `Playlist: syncOutput=enabled statePath=${playlistStatePath}`);
      debugLog(args, `Playlist: syncOutput needsSync=${needsPlaylistBackfill}`);
    } else {
      debugLog(args, "Playlist: syncOutput=disabled");
    }

    const oauth = resolveOauthConfig(args);
    debugLog(
      args,
      `OAuth: clientId=${oauth.clientId ? "set" : "missing"} clientSecret=${
        oauth.clientSecret ? "set" : "missing"
      } refreshToken=${oauth.refreshToken ? "set" : "missing"} tokenFile=${oauth.tokenFilePath || "none"}`
    );
  }

  const allLiveVideoIds = new Set();
  const errors = [];
  for (const channelInput of channelInputs) {
    try {
      let channelId = channelIdByInput.get(channelInput);
      if (!channelId) {
        channelId = await resolveChannelId(apiKey, channelInput, {
          timeoutSeconds: args.timeoutSeconds,
        });
        channelIdByInput.set(channelInput, channelId);
      }
      debugLog(args, `Channel: ${channelInput} -> ${channelId}`);

      const liveVideoIds = useSearch
        ? await fetchLiveVideoIdsViaSearch(apiKey, channelId, {
            maxResults: args.maxResults,
            timeoutSeconds: args.timeoutSeconds,
          })
        : await fetchLiveVideoIdsViaUploads(apiKey, channelId, {
            scanLatest,
            maxResults: args.maxResults,
            timeoutSeconds: args.timeoutSeconds,
            uploadsPlaylistIdByChannelId,
            knownLiveVideoIdsByChannelId,
          });
      debugLog(args, `Channel: ${channelId} liveCount=${liveVideoIds.length}`);
      for (const id of liveVideoIds) allLiveVideoIds.add(id);
    } catch (err) {
      if (channelInputs.length === 1) throw err;
      const message = err instanceof Error ? err.message : String(err);
      debugLog(args, `Channel: ${channelInput} error=${message}`);
      errors.push(`[${channelInput}] ${message}`);
    }
  }

  if (errors.length) console.error(errors.join("\n"));

  const liveVideoIds = Array.from(allLiveVideoIds);
  const playlistFailures = [];
  if (!liveVideoIds.length) {
    debugLog(args, "Run: no live videos found.");
    if (saveToPlaylist) {
      let outputSyncOk = true;
      const ensurePlaylist = isDebugEnabled(args);
      const result = needsPlaylistBackfill
        ? await syncOutputFileToPlaylist(args, state, outputPath, { timeoutSeconds: args.timeoutSeconds })
        : await flushPlaylistQueue(args, state, outputPath, [], {
            timeoutSeconds: args.timeoutSeconds,
            ensurePlaylist,
          });

      if (needsPlaylistBackfill) outputSyncOk = Boolean(result.synced);
      if (!args.quiet && result.addedCount) console.log(`Added ${result.addedCount} to playlist.`);
      playlistFailures.push(...result.failures);

      if (playlistSyncOutputEnabled && (!needsPlaylistBackfill || outputSyncOk)) {
        try {
          writePlaylistSyncState(playlistStatePath, {
            playlistKey: playlistTargetKey,
            playlistId: result.playlistId || (state && state.playlistId) || null,
            outputPath,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          debugLog(args, `Playlist state: write error=${message}`);
        }
      }
    }

    if (playlistFailures.length) {
      console.error(
        playlistFailures.map((f) => `[${f.videoId}] ${f.message}`).slice(0, 20).join("\n")
      );
      if (playlistFailures.length > 20) console.error(`...and ${playlistFailures.length - 20} more`);
    }

    if (!args.quiet) console.log("Not live.");
    return errors.length || playlistFailures.length ? 1 : 0;
  }
  debugLog(args, `Run: totalLive=${liveVideoIds.length}`);

  const savedResult = appendNewLiveLinks(outputPath, liveVideoIds, {
    withTimestamp: args.withTimestamp,
  });
  debugLog(
    args,
    `Save: newLinks=${savedResult.savedVideoIds.length} existingOrSkipped=${liveVideoIds.length - savedResult.savedVideoIds.length}`
  );

  if (saveToPlaylist) {
    let outputSyncOk = true;
    const result = needsPlaylistBackfill
      ? await syncOutputFileToPlaylist(args, state, outputPath, { timeoutSeconds: args.timeoutSeconds })
      : await flushPlaylistQueue(args, state, outputPath, savedResult.savedVideoIds, {
          timeoutSeconds: args.timeoutSeconds,
          ensurePlaylist: false,
        });

    if (needsPlaylistBackfill) outputSyncOk = Boolean(result.synced);
    playlistFailures.push(...result.failures);
    if (!args.quiet && result.addedCount) console.log(`Added ${result.addedCount} to playlist.`);

    if (playlistSyncOutputEnabled && (!needsPlaylistBackfill || outputSyncOk)) {
      try {
        writePlaylistSyncState(playlistStatePath, {
          playlistKey: playlistTargetKey,
          playlistId: result.playlistId || (state && state.playlistId) || null,
          outputPath,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugLog(args, `Playlist state: write error=${message}`);
      }
    }
  }

  if (playlistFailures.length) {
    console.error(playlistFailures.map((f) => `[${f.videoId}] ${f.message}`).slice(0, 20).join("\n"));
    if (playlistFailures.length > 20) console.error(`...and ${playlistFailures.length - 20} more`);
  }

  if (!args.quiet) {
    if (savedResult.savedUrls.length) console.log(savedResult.savedUrls.join("\n"));
    else console.log("Live, but link(s) already saved.");
  }

  return errors.length || playlistFailures.length ? 1 : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error("Run with --help to see available options.");
    return 2;
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.envFile) {
    try {
      loadEnvFile(args.envFile);
    } catch {
      console.error(`Env file not found: ${args.envFile}`);
      return 2;
    }
  }

  if (args.debug === null) {
    const envDebug = getEnvBool("YOUTUBE_DEBUG");
    args.debug = envDebug === null ? false : envDebug;
  }

  debugLog(args, `Debug: enabled envFile=${args.envFile || "(none)"}`);

  const state = {
    channelIdByInput: new Map(),
    uploadsPlaylistIdByChannelId: new Map(),
    knownLiveVideoIdsByChannelId: new Map(),
    oauth: {
      accessToken: null,
      expiresAtMs: 0,
    },
    playlistId: null,
  };

  if (args.oauthSetup) {
    try {
      return await runOauthSetup(args);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  if (args.playlistSync) {
    try {
      return await runPlaylistSync(args, state);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  if (!args.loop) {
    try {
      return await runOnce(args, state);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  let intervalSeconds = args.intervalSeconds;
  if (intervalSeconds === null) intervalSeconds = getEnvInt("YOUTUBE_INTERVAL_SECONDS");
  if (intervalSeconds === null) intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  intervalSeconds = Math.max(1, Number(intervalSeconds));

  if (!args.quiet) console.log(`Polling every ${intervalSeconds} seconds...`);
  while (true) {
    try {
      await runOnce(args, state);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
    }
    await sleep(intervalSeconds * 1000);
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });

#!/usr/bin/env bun
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const YOUTUBE_SEARCH_ENDPOINT = "https://www.googleapis.com/youtube/v3/search";
const YOUTUBE_CHANNELS_ENDPOINT = "https://www.googleapis.com/youtube/v3/channels";

const DEFAULT_OUTPUT_FILE = "saved_live_links.txt";
const DEFAULT_INTERVAL_SECONDS = 3600;

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

function formatYouTubeError(statusCode, bodyText) {
  let data;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    const snippet = (bodyText || "").trim().replace(/\s+/g, " ");
    return `HTTP ${statusCode}: ${snippet.slice(0, 300)}`.trim();
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

async function apiGetJson(endpoint, params, { timeoutSeconds }) {
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
      },
      signal: controller.signal,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(formatYouTubeError(response.status, bodyText));
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
        part: "id",
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

async function fetchLiveVideoIds(apiKey, channelId, { maxResults, timeoutSeconds }) {
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
  if (!videoIds.length) return [];

  const existing = readExistingVideoIds(outputPath);
  const parent = path.dirname(outputPath);
  if (parent && parent !== ".") fs.mkdirSync(parent, { recursive: true });

  const timestamp = utcNowIsoSeconds();
  const saved = [];
  let buffer = "";

  for (const videoId of videoIds) {
    if (existing.has(videoId)) continue;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    buffer += withTimestamp ? `${timestamp}\t${url}\n` : `${url}\n`;
    existing.add(videoId);
    saved.push(url);
  }

  if (buffer) fs.appendFileSync(outputPath, buffer, "utf8");
  return saved;
}

function printHelp() {
  const lines = [
    "Usage:",
    "  bun yt_live_link_saver.js [options]",
    "",
    "Options:",
    "  --api-key <key>            YouTube Data API v3 key (or set YOUTUBE_API_KEY)",
    "  --channels <list>          Channels to check (repeatable; comma-separated): @handle, UC..., or channel URL (or set YOUTUBE_CHANNELS)",
    `  --output <path>            Output file path (or set YOUTUBE_OUTPUT, default: ${DEFAULT_OUTPUT_FILE})`,
    "  --env-file <path>          Optional .env file with YOUTUBE_API_KEY, YOUTUBE_CHANNELS, YOUTUBE_OUTPUT, YOUTUBE_INTERVAL_SECONDS",
    "  --max-results <n>          Max number of simultaneous live videos to save (default: 5)",
    "  --timeout-seconds <n>      HTTP timeout in seconds (default: 10)",
    "  --with-timestamp           Prefix saved lines with an ISO timestamp and a tab",
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
    timeoutSeconds: 10,
    withTimestamp: false,
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

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

async function runOnce(args) {
  const apiKey = args.apiKey || process.env.YOUTUBE_API_KEY;
  const channelInputs = getChannelInputs(args);
  const outputPath = args.output || process.env.YOUTUBE_OUTPUT || DEFAULT_OUTPUT_FILE;

  if (!apiKey) {
    console.error("Missing API key. Pass --api-key or set YOUTUBE_API_KEY.");
    return 2;
  }
  if (!channelInputs.length) {
    console.error("Missing channels. Pass --channels or set YOUTUBE_CHANNELS.");
    return 2;
  }

  const allLiveVideoIds = new Set();
  const errors = [];
  for (const channelInput of channelInputs) {
    try {
      const channelId = await resolveChannelId(apiKey, channelInput, {
        timeoutSeconds: args.timeoutSeconds,
      });
      const liveVideoIds = await fetchLiveVideoIds(apiKey, channelId, {
        maxResults: args.maxResults,
        timeoutSeconds: args.timeoutSeconds,
      });
      for (const id of liveVideoIds) allLiveVideoIds.add(id);
    } catch (err) {
      if (channelInputs.length === 1) throw err;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`[${channelInput}] ${message}`);
    }
  }

  if (errors.length) console.error(errors.join("\n"));

  const liveVideoIds = Array.from(allLiveVideoIds);
  if (!liveVideoIds.length) {
    if (!args.quiet) console.log("Not live.");
    return errors.length ? 1 : 0;
  }

  const saved = appendNewLiveLinks(outputPath, liveVideoIds, {
    withTimestamp: args.withTimestamp,
  });

  if (!args.quiet) {
    if (saved.length) console.log(saved.join("\n"));
    else console.log("Live, but link(s) already saved.");
  }
  return errors.length ? 1 : 0;
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

  if (!args.loop) {
    try {
      return await runOnce(args);
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
      await runOnce(args);
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

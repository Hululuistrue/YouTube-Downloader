const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toTrimmedString = (value) => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
};

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
};

const defaultJsRuntime = (() => {
  const exec = process.execPath || "";
  const base = path.basename(exec).toLowerCase();
  if (!exec || (base !== "node" && base !== "node.exe")) {
    return "";
  }
  return `node:${exec}`;
})();

const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: toInt(process.env.PORT, 3000),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/video_downloader",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  jwtSecret: process.env.JWT_SECRET || "dev_jwt_secret",
  downloadTokenSecret: process.env.DOWNLOAD_TOKEN_SECRET || "dev_download_secret",
  queueName: process.env.QUEUE_NAME || "download_tasks",
  ytDlpBin: toTrimmedString(process.env.YT_DLP_BIN) || "yt-dlp",
  ffmpegBin: toTrimmedString(process.env.FFMPEG_BIN) || "ffmpeg",
  ytDlpCookiesFile: toTrimmedString(process.env.YT_DLP_COOKIES_FILE),
  ytDlpCookiesFromBrowser: toTrimmedString(process.env.YT_DLP_COOKIES_FROM_BROWSER),
  ytDlpAllowBrowserCookies: toBool(process.env.YT_DLP_ALLOW_BROWSER_COOKIES, false),
  ytDlpJsRuntimes: toTrimmedString(process.env.YT_DLP_JS_RUNTIMES) || defaultJsRuntime,
  cookieUploadMaxBytes: toInt(process.env.COOKIE_UPLOAD_MAX_BYTES, 10 * 1024 * 1024),
  maxFileSizeMb: toInt(process.env.MAX_FILE_SIZE_MB, 2048),
  anonDailyQuota: toInt(process.env.ANON_DAILY_QUOTA, 5),
  registeredDailyQuota: toInt(process.env.REGISTERED_DAILY_QUOTA, 30),
  anonConcurrencyLimit: toInt(process.env.ANON_CONCURRENCY_LIMIT, 1),
  registeredConcurrencyLimit: toInt(process.env.REGISTERED_CONCURRENCY_LIMIT, 3),
  runningTaskStaleMinutes: toInt(process.env.RUNNING_TASK_STALE_MINUTES, 10),
  downloadLinkTtlHours: toInt(process.env.DOWNLOAD_LINK_TTL_HOURS, 24),
  anonNamespaceUuid:
    process.env.ANON_NAMESPACE_UUID || "3a73de0a-e2d2-4b8d-b01f-ae03ed761ef3",
  outputDir: path.join(process.cwd(), "storage", "output"),
  workTmpDir: path.join(process.cwd(), "storage", "work"),
  cookieDir: path.join(process.cwd(), "storage", "cookies"),
};

module.exports = config;

const { spawn } = require("child_process");
const { z } = require("zod");
const config = require("../config");

const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);

const parseRequestSchema = z.object({
  url: z.string().url(),
  cookieFileId: z.string().uuid().optional(),
});

function normalizeYoutubeUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return null;
  }

  if (host === "youtu.be") {
    const videoId = parsed.pathname.replace("/", "").trim();
    if (!videoId) {
      return null;
    }
    return {
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
    };
  }

  const v = parsed.searchParams.get("v");
  if (!v) {
    return null;
  }

  return {
    canonicalUrl: `https://www.youtube.com/watch?v=${v}`,
    videoId: v,
  };
}

function parseSource(rawBody) {
  const body = parseRequestSchema.parse(rawBody);
  const normalized = normalizeYoutubeUrl(body.url);
  if (!normalized) {
    return {
      ok: false,
      errorCode: "UNSUPPORTED_URL",
      message: "Only youtube.com and youtu.be links are supported.",
    };
  }

  const { videoId, canonicalUrl } = normalized;
  return {
    ok: true,
    data: {
      videoId,
      sourceUrl: canonicalUrl,
    },
  };
}

function mapParseErrorCode(message) {
  const text = String(message || "").toLowerCase();
  const normalized = text.replace(/[’']/g, "").replace(/\s+/g, " ");
  const isBotChallenge =
    (normalized.includes("sign in to confirm") && normalized.includes("bot")) ||
    normalized.includes("use --cookies-from-browser or --cookies");

  if (
    isBotChallenge ||
    normalized.includes("cookies are no longer valid") ||
    normalized.includes("provided youtube account cookies are no longer valid") ||
    normalized.includes("video unavailable") ||
    normalized.includes("private video")
  ) {
    return "VIDEO_UNAVAILABLE";
  }
  if (normalized.includes("requested format is not available")) {
    return "FORMAT_NOT_AVAILABLE";
  }
  return "INTERNAL_ERROR";
}

function mapParseErrorMessage(message) {
  const raw = String(message || "").replace(/\s+/g, " ").trim();
  const text = raw.toLowerCase();
  const normalized = text.replace(/[’']/g, "");
  const isBotChallenge =
    (normalized.includes("sign in to confirm") && normalized.includes("bot")) ||
    normalized.includes("use --cookies-from-browser or --cookies");

  if (
    normalized.includes("cookies are no longer valid") ||
    normalized.includes("provided youtube account cookies are no longer valid")
  ) {
    return "COOKIES_INVALID: Uploaded cookies are invalid or expired. Please export fresh YouTube cookies and upload again.";
  }
  if (isBotChallenge) {
    return "AUTH_REQUIRED: YouTube requires authenticated cookies for this video. Upload and use a fresh cookie file, then parse again.";
  }
  if (raw.length > 1000) {
    return `${raw.slice(0, 1000)}...`;
  }
  return raw || "yt-dlp parse failed";
}

function runCommand(command, args, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const usePowerShell = process.platform === "win32";
    const execCommand = usePowerShell ? "powershell.exe" : command;
    const execArgs = usePowerShell
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `& ${[command, ...args].map(psQuote).join(" ")}`,
        ]
      : args;

    let child;
    try {
      child = spawn(execCommand, execArgs, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timer = null;

    const finish = (err, result) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    };

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`Command timeout: ${command}`));
    }, timeoutMs);

    child.on("error", (err) => finish(err));

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 5_000_000) {
        stdout = stdout.slice(-5_000_000);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 500_000) {
        stderr = stderr.slice(-500_000);
      }
    });

    child.on("close", (code) => {
      finish(null, { code: code ?? -1, stdout, stderr });
    });
  });
}

function isDownloadableFormat(format) {
  if (!format || !format.format_id) {
    return false;
  }
  if (format.ext === "mhtml") {
    return false;
  }
  if (String(format.format_id).startsWith("sb")) {
    return false;
  }
  const vcodec = String(format.vcodec || "");
  const acodec = String(format.acodec || "");
  if (vcodec === "none" && acodec === "none") {
    return false;
  }
  return true;
}

function calcFormatScore(format) {
  const hasVideo = format.vcodec && format.vcodec !== "none";
  const hasAudio = format.acodec && format.acodec !== "none";
  let score = 0;
  if (hasVideo && hasAudio) {
    score += 30_000;
  } else if (hasVideo) {
    score += 20_000;
  } else if (hasAudio) {
    score += 10_000;
  }
  score += Number.isFinite(format.height) ? format.height * 10 : 0;
  score += Number.isFinite(format.abr) ? format.abr : 0;
  score += Number.isFinite(format.tbr) ? format.tbr / 10 : 0;
  return score;
}

function mapFormat(format) {
  const hasVideo = Boolean(format.vcodec && format.vcodec !== "none");
  const hasAudio = Boolean(format.acodec && format.acodec !== "none");
  const qualityFromNoteMatch =
    typeof format.format_note === "string"
      ? format.format_note.match(/(\d{3,4}p)/i)
      : null;
  const quality =
    Number.isFinite(format.height) && format.height > 0
      ? `${format.height}p`
      : qualityFromNoteMatch
        ? qualityFromNoteMatch[1]
      : null;
  const fps =
    Number.isFinite(format.fps) && format.fps > 0 ? Math.round(format.fps) : null;
  const audioBitrate =
    Number.isFinite(format.abr) && format.abr > 0
      ? `${Math.round(format.abr)}k`
      : null;
  const estimatedFileSize =
    Number.isFinite(format.filesize) && format.filesize > 0
      ? Math.round(format.filesize)
      : Number.isFinite(format.filesize_approx) && format.filesize_approx > 0
        ? Math.round(format.filesize_approx)
        : null;

  return {
    id: String(format.format_id),
    container: format.ext || "unknown",
    quality,
    fps,
    videoCodec: hasVideo ? format.vcodec : null,
    audioCodec: hasAudio ? format.acodec : null,
    hasVideo,
    hasAudio,
    audioBitrate,
    estimatedFileSize,
  };
}

function selectFormats(formats) {
  const keyed = new Map();
  for (const format of formats) {
    if (!isDownloadableFormat(format)) {
      continue;
    }
    const key = [
      format.format_id,
      format.ext || "",
      format.vcodec || "",
      format.acodec || "",
      format.protocol || "",
    ].join("|");
    if (!keyed.has(key)) {
      keyed.set(key, format);
    }
  }

  const selected = Array.from(keyed.values())
    .sort((a, b) => calcFormatScore(b) - calcFormatScore(a))
    .slice(0, 120)
    .map(mapFormat);

  return selected;
}

async function parseSourceWithYtDlp(rawBody, options = {}) {
  const basic = parseSource(rawBody);
  if (!basic.ok) {
    return basic;
  }

  const sourceUrl = basic.data.sourceUrl;
  const args = ["--dump-single-json", "--skip-download", "--no-playlist"];
  if (options.cookieFilePath) {
    args.push("--cookies", options.cookieFilePath);
  }
  if (config.ytDlpJsRuntimes) {
    args.push("--js-runtimes", config.ytDlpJsRuntimes);
  }
  args.push(sourceUrl);

  let result;
  try {
    result = await runCommand(config.ytDlpBin, args);
  } catch (err) {
    return {
      ok: false,
      errorCode: "INTERNAL_ERROR",
      message: `Failed to run yt-dlp: ${err.message}`,
    };
  }

  if (result.code !== 0) {
    const detailsRaw = (result.stderr || result.stdout || "yt-dlp parse failed")
      .replace(/\s+/g, " ")
      .trim();
    return {
      ok: false,
      errorCode: mapParseErrorCode(detailsRaw),
      message: mapParseErrorMessage(detailsRaw),
    };
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch (err) {
    return {
      ok: false,
      errorCode: "INTERNAL_ERROR",
      message: `Failed to parse yt-dlp JSON: ${err.message}`,
    };
  }

  const selectedFormats = selectFormats(Array.isArray(payload.formats) ? payload.formats : []);
  if (!selectedFormats.length) {
    return {
      ok: false,
      errorCode: "VIDEO_UNAVAILABLE",
      message: "No downloadable formats found for this video",
    };
  }

  return {
    ok: true,
    data: {
      videoId: payload.id || basic.data.videoId,
      title: payload.title || `YouTube Video ${basic.data.videoId}`,
      durationSeconds: Number.isFinite(payload.duration) ? Math.round(payload.duration) : 0,
      thumbnail:
        payload.thumbnail ||
        `https://i.ytimg.com/vi/${basic.data.videoId}/hqdefault.jpg`,
      sourceUrl,
      formats: selectedFormats,
    },
  };
}

module.exports = {
  parseSource,
  parseSourceWithYtDlp,
  normalizeYoutubeUrl,
};

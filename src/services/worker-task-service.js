const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const db = require("../db");
const config = require("../config");

class WorkerTaskError extends Error {
  constructor(errorCode, message) {
    super(message);
    this.errorCode = errorCode;
  }
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeRemoveDir(dirPath) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = err && err.code ? String(err.code) : "";
      const retryable = code === "EBUSY" || code === "EPERM";
      if (!retryable || attempt === maxAttempts) {
        console.warn(
          `[worker] cleanup failed for ${dirPath}: ${err && err.message ? err.message : err}`
        );
        return;
      }
      await sleep(200 * attempt);
    }
  }
}

async function getTaskById(taskId) {
  const { rows } = await db.query(
    `SELECT t.id, t.source_url, t.output_type, t.format_id, t.quality, t.audio_bitrate, t.status, t.progress, t.retry_count,
            t.cookie_file_id, c.file_path AS cookie_file_path
     FROM download_tasks t
     LEFT JOIN user_cookie_files c ON c.id = t.cookie_file_id
     WHERE t.id = $1`,
    [taskId]
  );
  return rows[0] || null;
}

async function getTaskStatus(taskId) {
  const { rows } = await db.query(
    `SELECT status
     FROM download_tasks
     WHERE id = $1`,
    [taskId]
  );
  return rows[0] ? rows[0].status : null;
}

async function updateStatus(taskId, toStatus, patch = {}, message = null) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query(
      `SELECT status
       FROM download_tasks
       WHERE id = $1
       FOR UPDATE`,
      [taskId]
    );
    if (currentResult.rows.length === 0) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const fromStatus = currentResult.rows[0].status;

    const values = [toStatus];
    const setClauses = ["status = $1"];
    let idx = 2;

    for (const [key, value] of Object.entries(patch)) {
      values.push(value);
      setClauses.push(`${key} = $${idx}`);
      idx += 1;
    }
    values.push(taskId);

    await client.query(
      `UPDATE download_tasks
       SET ${setClauses.join(", ")}
       WHERE id = $${idx}`,
      values
    );

    await client.query(
      `INSERT INTO task_events (task_id, from_status, to_status, message)
       VALUES ($1, $2, $3, $4)`,
      [taskId, fromStatus, toStatus, message]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function markTaskFailed(taskId, errorCode, errorMessage) {
  await updateStatus(
    taskId,
    "failed",
    {
      error_code: errorCode,
      error_message: errorMessage,
      finished_at: new Date(),
    },
    errorMessage
  );
}

async function updateTaskProgress(taskId, progress) {
  const safeProgress = clampNumber(Math.round(progress), 0, 100);
  await db.query(
    `UPDATE download_tasks
     SET progress = CASE WHEN progress < $2 THEN $2 ELSE progress END
     WHERE id = $1
       AND status = 'downloading'`,
    [taskId, safeProgress]
  );
}

async function touchTaskHeartbeat(taskId) {
  await db.query(
    `UPDATE download_tasks
     SET progress = progress
     WHERE id = $1
       AND status = 'downloading'`,
    [taskId]
  );
}

function extractYtDlpProgressPercent(line) {
  if (!line) {
    return null;
  }
  const lowered = line.toLowerCase();
  if (!lowered.includes("[download]")) {
    return null;
  }
  const matched = line.match(/(\d{1,3}(?:\.\d+)?)%/);
  if (!matched) {
    return null;
  }
  const percent = Number.parseFloat(matched[1]);
  if (!Number.isFinite(percent)) {
    return null;
  }
  return clampNumber(percent, 0, 100);
}

function extractYtDlpFragmentPercent(line) {
  if (!line) {
    return null;
  }
  const matched = String(line).match(/fragment\s+(\d+)\s+of\s+(\d+)/i);
  if (!matched) {
    return null;
  }
  const index = Number.parseInt(matched[1], 10);
  const total = Number.parseInt(matched[2], 10);
  if (!Number.isFinite(index) || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  return clampNumber((index / total) * 100, 0, 100);
}

function mapDownloadPercentToOverallProgress(percent) {
  // downloading phase occupies 15 -> 90 progress range
  const normalized = clampNumber(percent, 0, 100);
  return Math.round(15 + normalized * 0.75);
}

function createDownloadProgressTracker(taskId) {
  let latestProgress = 15;
  let persistedProgress = 15;
  let inFlight = false;
  let persistError = null;
  let lastHeartbeatAt = 0;
  const heartbeatIntervalMs = 30_000;

  const persist = async (forceHeartbeat = false) => {
    if (persistError || inFlight) {
      return;
    }
    const shouldAdvanceProgress = latestProgress > persistedProgress;
    const now = Date.now();
    const shouldHeartbeat =
      forceHeartbeat || now - lastHeartbeatAt >= heartbeatIntervalMs;
    if (!shouldAdvanceProgress && !shouldHeartbeat) {
      return;
    }
    inFlight = true;
    try {
      if (shouldAdvanceProgress) {
        await updateTaskProgress(taskId, latestProgress);
        persistedProgress = latestProgress;
      } else {
        await touchTaskHeartbeat(taskId);
      }
      lastHeartbeatAt = now;
    } catch (err) {
      persistError = err;
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void persist();
  }, 1000);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  const onLine = (line) => {
    const percent =
      extractYtDlpProgressPercent(line) ?? extractYtDlpFragmentPercent(line);
    if (percent === null) {
      return;
    }
    const mapped = mapDownloadPercentToOverallProgress(percent);
    if (mapped > latestProgress) {
      latestProgress = mapped;
    }
  };

  const stop = async () => {
    clearInterval(timer);
    await persist(true);
    if (persistError) {
      throw persistError;
    }
  };

  return {
    onLine,
    stop,
  };
}

function sanitizeOutputType(outputType) {
  if (outputType === "mp3" || outputType === "mp4") {
    return outputType;
  }
  throw new WorkerTaskError("INTERNAL_ERROR", `Unsupported outputType: ${outputType}`);
}

function normalizeAudioBitrate(rawBitrate) {
  if (!rawBitrate) {
    return "192K";
  }
  const matched = String(rawBitrate).match(/(\d{2,3})/);
  if (!matched) {
    return "192K";
  }
  return `${matched[1]}K`;
}

function parseQualityHeight(quality) {
  if (!quality) {
    return null;
  }
  const matched = String(quality).match(/(\d{3,4})p/i);
  if (!matched) {
    return null;
  }
  const height = Number.parseInt(matched[1], 10);
  return Number.isFinite(height) ? height : null;
}

function buildYtDlpBaseArgs(task, outputTemplate, options = {}) {
  const useCookies = options.useCookies !== false;
  const args = [
    "--no-playlist",
    "--newline",
    "--restrict-filenames",
    "--max-filesize",
    `${config.maxFileSizeMb}M`,
    "-o",
    outputTemplate,
  ];

  if (useCookies) {
    if (task.cookie_file_path) {
      args.push("--cookies", task.cookie_file_path);
    } else if (config.ytDlpCookiesFile) {
      args.push("--cookies", config.ytDlpCookiesFile);
    } else if (config.ytDlpAllowBrowserCookies && config.ytDlpCookiesFromBrowser) {
      args.push("--cookies-from-browser", config.ytDlpCookiesFromBrowser);
    }
  }

  if (config.ffmpegBin && config.ffmpegBin !== "ffmpeg") {
    args.push("--ffmpeg-location", config.ffmpegBin);
  }
  if (config.ytDlpJsRuntimes) {
    args.push("--js-runtimes", config.ytDlpJsRuntimes);
  }
  return args;
}

function buildYtDlpArgs(task, outputTemplate, options = {}) {
  const strategy = options.strategy || "quality";
  const outputType = sanitizeOutputType(task.output_type);
  const args = buildYtDlpBaseArgs(task, outputTemplate, options);
  const explicitFormatId = String(task.format_id || "").trim();

  if (explicitFormatId) {
    args.push("-f", explicitFormatId);
    if (outputType === "mp3") {
      args.push(
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        normalizeAudioBitrate(task.audio_bitrate)
      );
    } else {
      args.push("--merge-output-format", "mp4");
    }
    args.push(task.source_url);
    return args;
  }

  if (outputType === "mp3") {
    args.push(
      "-f",
      "bestaudio/best",
      "--extract-audio",
      "--audio-format",
      "mp3",
      "--audio-quality",
      normalizeAudioBitrate(task.audio_bitrate)
    );
  } else {
    if (strategy === "progressive") {
      args.push("-f", "best");
    } else if (strategy === "adaptive") {
      args.push("-f", "bestvideo*+bestaudio/best");
    } else {
      const maxHeight = parseQualityHeight(task.quality);
      if (maxHeight) {
        // Prefer target quality first, then gracefully fall back to best available.
        args.push(
          "-f",
          `bestvideo*[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/bestvideo*+bestaudio/best`
        );
      } else {
        args.push("-f", "bestvideo*+bestaudio/best");
      }
    }

    if (strategy !== "progressive") {
      args.push("--merge-output-format", "mp4");
    }
  }

  args.push(task.source_url);
  return args;
}

function mapYtDlpError(text) {
  const message = (text || "").toLowerCase();
  if (
    message.includes("the provided youtube account cookies are no longer valid") ||
    message.includes("cookies are no longer valid")
  ) {
    return "VIDEO_UNAVAILABLE";
  }
  if (
    message.includes("only images are available for download") ||
    message.includes("n challenge solving failed") ||
    message.includes("forcing sabr streaming") ||
    message.includes("po token")
  ) {
    return "VIDEO_UNAVAILABLE";
  }
  if (
    message.includes("video unavailable") ||
    message.includes("this video is unavailable") ||
    message.includes("private video") ||
    message.includes("has been removed")
  ) {
    return "VIDEO_UNAVAILABLE";
  }
  if (message.includes("requested format is not available")) {
    return "FORMAT_NOT_AVAILABLE";
  }
  if (
    message.includes("sign in to confirm you're not a bot") ||
    message.includes("sign in to confirm you") ||
    message.includes("use --cookies-from-browser or --cookies")
  ) {
    return "VIDEO_UNAVAILABLE";
  }
  if (
    message.includes("failed to decrypt with dpapi") ||
    message.includes("could not copy chrome cookie database") ||
    message.includes("failed to decrypt")
  ) {
    return "VIDEO_UNAVAILABLE";
  }
  if (
    message.includes("ffmpeg not found") ||
    message.includes("ffprobe and ffmpeg not found")
  ) {
    return "TRANSCODE_FAILED";
  }
  if (message.includes("file is larger than max-filesize")) {
    return "INTERNAL_ERROR";
  }
  return "INTERNAL_ERROR";
}

function buildYtDlpUserMessage(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const message = raw.toLowerCase();

  if (
    message.includes("the provided youtube account cookies are no longer valid") ||
    message.includes("cookies are no longer valid")
  ) {
    return "COOKIES_INVALID: Uploaded cookies are invalid or expired. Please export fresh YouTube cookies from your current browser session and upload again.";
  }
  if (
    message.includes("sign in to confirm you're not a bot") ||
    message.includes("sign in to confirm youre not a bot")
  ) {
    return "AUTH_REQUIRED: YouTube requires authenticated cookies for this video. Please upload fresh YouTube cookies.";
  }
  if (message.includes("no supported javascript runtime could be found")) {
    return "JS_RUNTIME_MISSING: yt-dlp cannot run JavaScript challenges. Configure YT_DLP_JS_RUNTIMES, e.g. node:<path-to-node>.";
  }
  if (message.includes("requested format is not available")) {
    return "FORMAT_NOT_AVAILABLE: The requested format is not available for this video.";
  }
  if (message.includes("only images are available for download")) {
    return "NO_STREAMABLE_FORMAT: YouTube returned only storyboard/image formats for this request.";
  }

  if (raw.length > 1200) {
    return `${raw.slice(0, 1200)}...`;
  }
  return raw || "yt-dlp failed";
}

function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 30 * 60 * 1000;
  const shouldAbort =
    typeof options.shouldAbort === "function" ? options.shouldAbort : null;
  const abortMessage = options.abortMessage || "Task canceled by user";

  return new Promise((resolve, reject) => {
    const killProcessTree = async (pid) => {
      if (!pid) {
        return;
      }
      try {
        if (process.platform === "win32") {
          await new Promise((resolveKill) => {
            const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
            killer.on("error", () => resolveKill());
            killer.on("close", () => resolveKill());
          });
          return;
        }
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore kill errors
      }
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd || process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      if (err && err.code === "ENOENT") {
        reject(
          new WorkerTaskError("INTERNAL_ERROR", `Required binary not found: ${command}`)
        );
        return;
      }
      if (err && err.code === "EPERM") {
        reject(
          new WorkerTaskError(
            "INTERNAL_ERROR",
            `Permission denied when running binary: ${command}`
          )
        );
        return;
      }
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let finished = false;
    let timeout = null;
    let abortPollTimer = null;
    let abortRequested = false;

    const finish = (err, result) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (abortPollTimer) {
        clearInterval(abortPollTimer);
      }
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    };

    const requestAbort = () => {
      if (!shouldAbort || finished || abortRequested) {
        return;
      }
      let shouldStop = false;
      try {
        shouldStop = Boolean(shouldAbort());
      } catch {
        shouldStop = false;
      }
      if (!shouldStop) {
        return;
      }
      abortRequested = true;
      void killProcessTree(child.pid).finally(() => {
        finish(new WorkerTaskError("TASK_CANCELED", abortMessage));
      });
    };

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        void killProcessTree(child.pid).finally(() => {
          finish(new WorkerTaskError("INTERNAL_ERROR", `Command timeout: ${command}`));
        });
      }, timeoutMs);
    }
    if (shouldAbort) {
      abortPollTimer = setInterval(requestAbort, 1000);
      if (typeof abortPollTimer.unref === "function") {
        abortPollTimer.unref();
      }
    }

    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        finish(
          new WorkerTaskError("INTERNAL_ERROR", `Required binary not found: ${command}`)
        );
        return;
      }
      finish(err);
    });

    child.stdout.on("data", (chunk) => {
      requestAbort();
      if (finished) {
        return;
      }
      const text = chunk.toString();
      stdout += text;
      if (stdout.length > 200_000) {
        stdout = stdout.slice(-200_000);
      }
      if (typeof options.onStdoutLine === "function") {
        stdoutBuffer += text;
        const lines = stdoutBuffer.split(/[\r\n]+/);
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          try {
            options.onStdoutLine(line);
          } catch (err) {
            console.error("[worker] stdout line callback failed:", err.message);
          }
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      requestAbort();
      if (finished) {
        return;
      }
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 200_000) {
        stderr = stderr.slice(-200_000);
      }
      if (typeof options.onStderrLine === "function") {
        stderrBuffer += text;
        const lines = stderrBuffer.split(/[\r\n]+/);
        stderrBuffer = lines.pop() || "";
        for (const line of lines) {
          try {
            options.onStderrLine(line);
          } catch (err) {
            console.error("[worker] stderr line callback failed:", err.message);
          }
        }
      }
    });

    child.on("close", (code) => {
      if (stdoutBuffer && typeof options.onStdoutLine === "function") {
        try {
          options.onStdoutLine(stdoutBuffer);
        } catch (err) {
          console.error("[worker] stdout flush callback failed:", err.message);
        }
      }
      if (stderrBuffer && typeof options.onStderrLine === "function") {
        try {
          options.onStderrLine(stderrBuffer);
        } catch (err) {
          console.error("[worker] stderr flush callback failed:", err.message);
        }
      }
      finish(null, {
        code: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

async function assertBinaryExists(command, versionArgs) {
  const result = await runCommand(command, versionArgs, { timeoutMs: 15_000 });
  if (result.code !== 0) {
    throw new WorkerTaskError(
      "INTERNAL_ERROR",
      `Binary check failed for ${command}: ${result.stderr || result.stdout}`
    );
  }
}

async function assertWorkerToolingReady() {
  await assertBinaryExists(config.ytDlpBin, ["--version"]);
  await assertBinaryExists(config.ffmpegBin, ["-version"]);
}

async function findDownloadedFile(taskDir) {
  const entries = await fs.readdir(taskDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        !name.endsWith(".part") &&
        !name.endsWith(".ytdl") &&
        !name.endsWith(".tmp")
    );

  if (candidates.length === 0) {
    throw new WorkerTaskError(
      "VIDEO_UNAVAILABLE",
      "No output file was produced by downloader"
    );
  }

  const fileStats = await Promise.all(
    candidates.map(async (name) => {
      const fullPath = path.join(taskDir, name);
      const stat = await fs.stat(fullPath);
      return {
        name,
        fullPath,
        size: stat.size,
      };
    })
  );

  fileStats.sort((a, b) => b.size - a.size);
  return fileStats[0].fullPath;
}

async function ensureExpectedExtension(task, sourceFilePath, taskDir, runOptions = {}) {
  const outputType = sanitizeOutputType(task.output_type);
  const targetExt = `.${outputType}`;
  const currentExt = path.extname(sourceFilePath).toLowerCase();
  if (currentExt === targetExt) {
    return sourceFilePath;
  }

  const convertedPath = path.join(taskDir, `converted${targetExt}`);
  if (outputType === "mp3") {
    const bitrate = normalizeAudioBitrate(task.audio_bitrate);
    const args = [
      "-y",
      "-i",
      sourceFilePath,
      "-vn",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      bitrate,
      convertedPath,
    ];
    const result = await runCommand(config.ffmpegBin, args, runOptions);
    if (result.code !== 0) {
      throw new WorkerTaskError(
        "TRANSCODE_FAILED",
        result.stderr || "ffmpeg audio conversion failed"
      );
    }
    return convertedPath;
  }

  const args = [
    "-y",
    "-i",
    sourceFilePath,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    convertedPath,
  ];
  const result = await runCommand(config.ffmpegBin, args, runOptions);
  if (result.code !== 0) {
    throw new WorkerTaskError(
      "TRANSCODE_FAILED",
      result.stderr || "ffmpeg video conversion failed"
    );
  }
  return convertedPath;
}

function ensureSizeWithinLimit(fileSizeBytes) {
  const maxBytes = config.maxFileSizeMb * 1024 * 1024;
  if (fileSizeBytes > maxBytes) {
    throw new WorkerTaskError(
      "INTERNAL_ERROR",
      `Output file exceeds configured max size (${config.maxFileSizeMb}MB)`
    );
  }
}

function hasAnyCookieSource(task) {
  if (task.cookie_file_path) {
    return true;
  }
  if (config.ytDlpCookiesFile) {
    return true;
  }
  if (config.ytDlpAllowBrowserCookies && config.ytDlpCookiesFromBrowser) {
    return true;
  }
  return false;
}

function buildDownloadAttempts(task, template) {
  const explicitFormatId = String(task.format_id || "").trim();
  if (explicitFormatId) {
    const attempts = [
      {
        label: "exact format selector",
        args: buildYtDlpArgs(task, template, { strategy: "exact", useCookies: true }),
      },
    ];
    if (hasAnyCookieSource(task)) {
      attempts.push({
        label: "exact format selector (without cookies)",
        args: buildYtDlpArgs(task, template, { strategy: "exact", useCookies: false }),
      });
    }
    return attempts;
  }

  const attempts = [
    {
      label: "quality selector",
      args: buildYtDlpArgs(task, template, { strategy: "quality", useCookies: true }),
    },
    {
      label: "adaptive selector",
      args: buildYtDlpArgs(task, template, { strategy: "adaptive", useCookies: true }),
    },
    {
      label: "progressive selector",
      args: buildYtDlpArgs(task, template, {
        strategy: "progressive",
        useCookies: true,
      }),
    },
  ];

  if (hasAnyCookieSource(task)) {
    attempts.push(
      {
        label: "adaptive selector (without cookies)",
        args: buildYtDlpArgs(task, template, {
          strategy: "adaptive",
          useCookies: false,
        }),
      },
      {
        label: "progressive selector (without cookies)",
        args: buildYtDlpArgs(task, template, {
          strategy: "progressive",
          useCookies: false,
        }),
      }
    );
  }

  return attempts;
}

async function processTask(taskId) {
  const task = await getTaskById(taskId);
  if (!task) {
    return;
  }
  if (task.status === "canceled") {
    console.log(`[worker] task already canceled, skipping: ${taskId}`);
    return;
  }

  const taskDir = path.join(config.workTmpDir, task.id);
  const targetExt = sanitizeOutputType(task.output_type);
  const finalFileName = `${task.id}.${targetExt}`;
  const finalOutputPath = path.join(config.outputDir, finalFileName);
  let canceled = false;
  let cancelPollTimer = null;

  const syncCanceledFlag = async () => {
    const status = await getTaskStatus(task.id);
    canceled = status === "canceled";
  };

  const throwIfCanceled = (message = "Task canceled by user") => {
    if (canceled) {
      throw new WorkerTaskError("TASK_CANCELED", message);
    }
  };

  try {
    await syncCanceledFlag();
    throwIfCanceled();
    cancelPollTimer = setInterval(() => {
      void syncCanceledFlag().catch((err) => {
        console.error("[worker] cancel poll failed:", err.message);
      });
    }, 2000);
    if (typeof cancelPollTimer.unref === "function") {
      cancelPollTimer.unref();
    }

    await fs.mkdir(config.workTmpDir, { recursive: true });
    await fs.mkdir(config.outputDir, { recursive: true });
    await fs.rm(taskDir, { recursive: true, force: true });
    await fs.mkdir(taskDir, { recursive: true });

    if (task.cookie_file_id && !task.cookie_file_path) {
      throw new WorkerTaskError(
        "VIDEO_UNAVAILABLE",
        "cookieFileId is set but cookie file cannot be resolved"
      );
    }

    throwIfCanceled();
    await updateStatus(
      task.id,
      "downloading",
      { progress: 15, started_at: new Date() },
      "Downloading media with yt-dlp"
    );

    const template = path.join(taskDir, "source.%(ext)s");
    const downloadAttempts = buildDownloadAttempts(task, template);
    const progressTracker = createDownloadProgressTracker(task.id);
    let runError = null;
    let runSucceeded = false;
    let lastOutput = "";
    let lastCode = "INTERNAL_ERROR";
    try {
      for (let i = 0; i < downloadAttempts.length; i += 1) {
        const attempt = downloadAttempts[i];
        const result = await runCommand(config.ytDlpBin, attempt.args, {
          onStdoutLine: progressTracker.onLine,
          onStderrLine: progressTracker.onLine,
          shouldAbort: () => canceled,
          abortMessage: "Task canceled by user during download",
        });
        if (result.code === 0) {
          runSucceeded = true;
          break;
        }

        const output = result.stderr || result.stdout || "yt-dlp failed";
        const mappedCode = mapYtDlpError(output);
        lastOutput = output;
        lastCode = mappedCode;

        if (mappedCode !== "FORMAT_NOT_AVAILABLE") {
          throw new WorkerTaskError(mappedCode, buildYtDlpUserMessage(output));
        }

        if (i < downloadAttempts.length - 1) {
          const nextAttempt = downloadAttempts[i + 1];
          console.warn(
            `[worker] FORMAT_NOT_AVAILABLE, retrying with ${nextAttempt.label}: ${task.id}`
          );
        }
      }
    } catch (err) {
      runError = err;
    } finally {
      try {
        await progressTracker.stop();
      } catch (progressErr) {
        if (!runError) {
          runError = progressErr;
        } else {
          console.error(
            "[worker] progress tracker stop failed (suppressed):",
            progressErr.message
          );
        }
      }
    }
    if (runError) {
      throw runError;
    }
    if (!runSucceeded) {
      throw new WorkerTaskError(lastCode, buildYtDlpUserMessage(lastOutput));
    }

    throwIfCanceled();
    await updateStatus(task.id, "transcoding", { progress: 92 }, "Preparing output file");

    const downloadedFile = await findDownloadedFile(taskDir);
    const normalizedOutput = await ensureExpectedExtension(task, downloadedFile, taskDir, {
      shouldAbort: () => canceled,
      abortMessage: "Task canceled by user during transcoding",
    });

    throwIfCanceled();
    await updateStatus(task.id, "uploading", { progress: 97 }, "Storing output file");

    await fs.copyFile(normalizedOutput, finalOutputPath);
    const stat = await fs.stat(finalOutputPath);
    ensureSizeWithinLimit(stat.size);

    throwIfCanceled();
    const expiresAt = new Date(Date.now() + config.downloadLinkTtlHours * 3600 * 1000);
    await updateStatus(
      task.id,
      "success",
      {
        progress: 100,
        output_object_key: finalFileName,
        file_size: stat.size,
        expires_at: expiresAt,
        finished_at: new Date(),
      },
      "Task completed successfully"
    );
  } catch (err) {
    if (err instanceof WorkerTaskError && err.errorCode === "TASK_CANCELED") {
      console.log(`[worker] task canceled: ${taskId}`);
      return;
    }
    const latestStatus = await getTaskStatus(task.id).catch(() => null);
    if (latestStatus === "canceled") {
      console.log(`[worker] task canceled: ${taskId}`);
      return;
    }
    console.error("[worker] task failed:", taskId, err);
    const errorMessage = err.message || "Unknown worker error";
    let errorCode =
      err instanceof WorkerTaskError ? err.errorCode : "INTERNAL_ERROR";
    if (errorCode === "INTERNAL_ERROR") {
      const mapped = mapYtDlpError(errorMessage);
      if (mapped !== "INTERNAL_ERROR") {
        errorCode = mapped;
      }
    }
    await markTaskFailed(task.id, errorCode, errorMessage);
  } finally {
    if (cancelPollTimer) {
      clearInterval(cancelPollTimer);
    }
    await safeRemoveDir(taskDir);
  }
}

module.exports = {
  processTask,
  assertWorkerToolingReady,
};

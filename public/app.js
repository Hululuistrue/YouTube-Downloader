const $ = (id) => document.getElementById(id);
const COOKIE_FILE_ID_STORAGE_KEY = "video_downloader_cookie_file_id";
let taskPollTimer = null;
let uploadedCookieFileId = null;
let latestParsedFormats = [];
let isTaskListRefreshing = false;
const DEFAULT_MP4_QUALITIES = ["1080p", "720p", "480p", "360p"];
const DEFAULT_MP3_BITRATES = ["320k", "256k", "192k", "128k"];
const APP_LANG = (document.documentElement.lang || "zh-CN")
  .toLowerCase()
  .startsWith("en")
  ? "en"
  : "zh";

const I18N = {
  zh: {
    autoSelectFormat: "按质量/码率自动选择",
    hintParseFirst: "请先解析链接，系统会按解析结果填充可选质量/码率。",
    hintLoadedFormats:
      "已根据解析结果加载：{videoCount} 项视频质量，{audioCount} 项音频码率。",
    noUploadedCookies: "暂无已上传 cookies",
    currentInUse: "（当前使用）",
    use: "使用",
    delete: "删除",
    fetchCookiesFailed: "获取 cookies 列表失败",
    selectCookieFileFirst: "请先选择 cookies 文件",
    uploadingCookies: "正在上传 cookies...",
    uploadCookiesFailed: "上传 cookies 失败",
    uploadMissingCookieId: "上传失败：服务端未返回 cookieFileId",
    confirmDeleteCookieFile: "确认删除这个 cookies 文件吗？",
    deleteCookiesFailed: "删除 cookies 失败",
    deleteSuccess: "删除成功",
    setCurrentCookies: "已设为当前 cookies",
    inputUrlFirst: "请先输入链接",
    parseFailed: "解析失败",
    requestFailedApi: "请求失败：{message}",
    apiNotRunning: "请确认 API 已启动",
    autoUploadingCookies: "检测到未上传的 cookies，正在自动上传...",
    cookieAutoUploadFailed: "Cookies 上传失败，请修复后再创建任务。",
    createTaskFailed: "创建任务失败",
    taskCreated: "任务创建成功：{taskId}（状态 {status}）",
    stageQueued: "阶段：排队中",
    stageQueuedDetail: "任务已创建，等待 worker 处理。",
    stageDownloading: "阶段：下载中",
    stageDownloadingDetail: "正在从源站拉取音视频流。",
    stageTranscoding: "阶段：转码中",
    stageTranscodingDetail: "正在整理封装/转码目标输出格式。",
    stageUploading: "阶段：落盘中",
    stageUploadingDetail: "正在写入最终文件并生成下载链接。",
    stageSuccess: "阶段：已完成",
    stageSuccessDetail: "任务成功，已可下载。",
    stageFailed: "阶段：失败",
    stageFailedDetail: "任务失败，请查看 error/message。",
    stageCanceled: "阶段：已取消",
    stageCanceledDetail: "任务已被手动取消。",
    stageExpired: "阶段：已过期",
    stageExpiredDetail: "下载链接已过期，需要重新创建任务。",
    stageUnknown: "阶段：{status}",
    stageUnknownDetail: "状态未知。",
    confirmCancelTask: "确认取消任务 {taskId} 吗？",
    cancelTaskFailed: "取消任务失败",
    taskCanceled: "任务已取消：{taskId}",
    requestFailed: "请求失败：{message}",
    ensureApiRunning: "请确认 API 服务已启动",
    ensureApiWorkerRunning: "请确认 API/Worker 已启动",
    fetchTasksFailed: "获取任务失败",
    noTasks: "暂无任务",
    download: "下载",
    cancel: "取消",
    selectedFile:
      "已选择：{fileName}。可点击“上传 Cookies”，或直接创建任务自动上传。",
    uploadSucceeded: "上传成功：{fileName}",
    qualityAudioTypeVideoAudio: "视频+音频",
    qualityAudioTypeVideoOnly: "仅视频",
    qualityAudioTypeAudioOnly: "仅音频",
    qualityAudioTypeUnknown: "未知",
    yesNoHyphen: "-",
    progressRetryLabel: "进度={progress}% 重试={retry}",
  },
  en: {
    autoSelectFormat: "Auto select by quality/bitrate",
    hintParseFirst:
      "Parse a URL first. Quality and bitrate options will be filled from parsed formats.",
    hintLoadedFormats:
      "Loaded from parse result: {videoCount} video quality options, {audioCount} audio bitrate options.",
    noUploadedCookies: "No uploaded cookies",
    currentInUse: "(In use)",
    use: "Use",
    delete: "Delete",
    fetchCookiesFailed: "Failed to fetch cookie list",
    selectCookieFileFirst: "Please select a cookie file first",
    uploadingCookies: "Uploading cookies...",
    uploadCookiesFailed: "Failed to upload cookies",
    uploadMissingCookieId: "Upload failed: server did not return cookieFileId",
    confirmDeleteCookieFile: "Delete this cookie file?",
    deleteCookiesFailed: "Failed to delete cookies",
    deleteSuccess: "Deleted",
    setCurrentCookies: "Set as current cookies",
    inputUrlFirst: "Please input URL first",
    parseFailed: "Parse failed",
    requestFailedApi: "Request failed: {message}",
    apiNotRunning: "Please ensure API is running",
    autoUploadingCookies: "Detected unuploaded cookies, uploading automatically...",
    cookieAutoUploadFailed:
      "Cookie upload failed. Please fix it first, then create the task again.",
    createTaskFailed: "Failed to create task",
    taskCreated: "Task created: {taskId} (status {status})",
    stageQueued: "Stage: Queued",
    stageQueuedDetail: "Task created and waiting for worker.",
    stageDownloading: "Stage: Downloading",
    stageDownloadingDetail: "Pulling media stream from source.",
    stageTranscoding: "Stage: Transcoding",
    stageTranscodingDetail: "Preparing target container/codec.",
    stageUploading: "Stage: Finalizing",
    stageUploadingDetail: "Writing output file and preparing download link.",
    stageSuccess: "Stage: Completed",
    stageSuccessDetail: "Task succeeded and is ready to download.",
    stageFailed: "Stage: Failed",
    stageFailedDetail: "Task failed. Check error/message.",
    stageCanceled: "Stage: Canceled",
    stageCanceledDetail: "Task canceled by user.",
    stageExpired: "Stage: Expired",
    stageExpiredDetail: "Download link expired. Create a new task.",
    stageUnknown: "Stage: {status}",
    stageUnknownDetail: "Unknown status.",
    confirmCancelTask: "Confirm cancel task {taskId}?",
    cancelTaskFailed: "Failed to cancel task",
    taskCanceled: "Task canceled: {taskId}",
    requestFailed: "Request failed: {message}",
    ensureApiRunning: "Please ensure API is running",
    ensureApiWorkerRunning: "Please ensure API/Worker is running",
    fetchTasksFailed: "Failed to fetch tasks",
    noTasks: "No tasks yet",
    download: "Download",
    cancel: "Cancel",
    selectedFile:
      "Selected: {fileName}. Click \"Upload Cookies\" or create task to auto-upload.",
    uploadSucceeded: "Upload succeeded: {fileName}",
    qualityAudioTypeVideoAudio: "video+audio",
    qualityAudioTypeVideoOnly: "video-only",
    qualityAudioTypeAudioOnly: "audio-only",
    qualityAudioTypeUnknown: "unknown",
    yesNoHyphen: "-",
    progressRetryLabel: "progress={progress}% retry={retry}",
  },
};

function t(key, vars = {}) {
  const template =
    (I18N[APP_LANG] && I18N[APP_LANG][key]) ||
    (I18N.en && I18N.en[key]) ||
    key;
  return String(template).replace(/\{(\w+)\}/g, (_, token) => {
    const value = vars[token];
    return value === undefined || value === null ? "" : String(value);
  });
}

document.title = APP_LANG === "en" ? "VideoDownloader MVP" : "视频下载工具 MVP";

function persistCookieFileId(value) {
  try {
    if (value) {
      window.localStorage.setItem(COOKIE_FILE_ID_STORAGE_KEY, value);
    } else {
      window.localStorage.removeItem(COOKIE_FILE_ID_STORAGE_KEY);
    }
  } catch {
    // ignore storage failures
  }
}

function readCookieFileIdFromStorage() {
  try {
    return window.localStorage.getItem(COOKIE_FILE_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

function createIdempotencyKey() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  const rand = Math.random().toString(36).slice(2);
  return `idem_${Date.now()}_${rand}`;
}

function showError(el, text) {
  el.className = "error";
  el.textContent = text;
}

function showOk(el, text) {
  el.className = "ok";
  el.textContent = text;
}

function formatApiError(data, fallback) {
  if (data && data.errorCode && data.message) {
    return `${data.errorCode}: ${data.message}`;
  }
  return fallback;
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "-";
  }
  return date.toLocaleString();
}

function setSelectedCookieFile(cookieFileId) {
  uploadedCookieFileId = cookieFileId || null;
  persistCookieFileId(uploadedCookieFileId);
  renderCookieFileState();
}

function renderCookieFileState() {
  const box = $("cookieFileIdBox");
  if (!uploadedCookieFileId) {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }
  box.classList.remove("hidden");
  box.textContent = `cookieFileId=${uploadedCookieFileId}`;
}

function normalizeQualityLabel(value) {
  if (!value) {
    return null;
  }
  const matched = String(value).match(/(\d{3,4})p/i);
  if (!matched) {
    return null;
  }
  return `${matched[1]}p`;
}

function normalizeBitrateLabel(value) {
  if (!value) {
    return null;
  }
  const matched = String(value).match(/(\d{2,3})/);
  if (!matched) {
    return null;
  }
  return `${matched[1]}k`;
}

function numericDescSorter(a, b) {
  const aNum = Number.parseInt(String(a), 10);
  const bNum = Number.parseInt(String(b), 10);
  return bNum - aNum;
}

function collectFormatOptions(formats) {
  const qualitySet = new Set();
  const bitrateSet = new Set();
  for (const item of Array.isArray(formats) ? formats : []) {
    const hasVideo = Boolean(item && (item.hasVideo || item.videoCodec));
    const hasAudio = Boolean(item && (item.hasAudio || item.audioCodec));
    if (hasVideo) {
      const quality = normalizeQualityLabel(item.quality);
      if (quality) {
        qualitySet.add(quality);
      }
    }
    if (hasAudio) {
      const bitrate = normalizeBitrateLabel(item.audioBitrate);
      if (bitrate) {
        bitrateSet.add(bitrate);
      }
    }
  }
  return {
    qualities: Array.from(qualitySet).sort(numericDescSorter),
    bitrates: Array.from(bitrateSet).sort(numericDescSorter),
  };
}

function toFileSizeLabel(bytes) {
  const size = Number.parseInt(bytes, 10);
  if (!Number.isFinite(size) || size <= 0) {
    return "-";
  }
  const gb = 1024 * 1024 * 1024;
  const mb = 1024 * 1024;
  if (size >= gb) {
    return `${(size / gb).toFixed(2)} GB`;
  }
  return `${(size / mb).toFixed(1)} MB`;
}

function buildFormatOptionLabel(item) {
  const quality = item.quality || "-";
  const abr = item.audioBitrate || "-";
  const typeLabel =
    item.hasVideo && item.hasAudio
      ? "video+audio"
      : item.hasVideo
        ? "video-only"
        : item.hasAudio
          ? "audio-only"
          : "unknown";
  return `${item.id} | ${item.container} | ${quality} | abr=${abr} | ${typeLabel} | size=${toFileSizeLabel(item.estimatedFileSize)}`;
}

function getSelectableFormatsByOutputType(outputType) {
  if (!Array.isArray(latestParsedFormats)) {
    return [];
  }
  if (outputType === "mp3") {
    const audioOnly = latestParsedFormats.filter(
      (f) =>
        Boolean(f && (f.hasAudio || f.audioCodec)) &&
        !Boolean(f && (f.hasVideo || f.videoCodec))
    );
    if (audioOnly.length > 0) {
      return audioOnly;
    }
    return latestParsedFormats.filter((f) => Boolean(f && (f.hasAudio || f.audioCodec)));
  }
  return latestParsedFormats.filter((f) => Boolean(f && (f.hasVideo || f.videoCodec)));
}

function refreshFormatIdSelector() {
  const selectEl = $("formatIdInput");
  if (!selectEl) {
    return;
  }
  const outputType = $("outputType").value;
  const candidates = getSelectableFormatsByOutputType(outputType);
  const previousValue = selectEl.value;
  selectEl.innerHTML = "";

  const autoOption = document.createElement("option");
  autoOption.value = "";
  autoOption.textContent = t("autoSelectFormat");
  selectEl.appendChild(autoOption);

  for (const item of candidates) {
    const option = document.createElement("option");
    option.value = String(item.id || "");
    option.textContent = buildFormatOptionLabel(item);
    selectEl.appendChild(option);
  }

  if (previousValue && candidates.some((item) => String(item.id) === previousValue)) {
    selectEl.value = previousValue;
  } else {
    selectEl.value = "";
  }
}

function setSelectOptions(selectEl, values) {
  const previousValue = selectEl.value;
  selectEl.innerHTML = "";
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    selectEl.appendChild(option);
  }
  if (previousValue && values.includes(previousValue)) {
    selectEl.value = previousValue;
  } else if (values.length > 0) {
    selectEl.value = values[0];
  }
}

function syncOutputTypeFields() {
  const outputType = $("outputType").value;
  const qualitySelect = $("qualityInput");
  const bitrateSelect = $("bitrateInput");
  if (outputType === "mp4") {
    qualitySelect.disabled = false;
    bitrateSelect.disabled = true;
  } else {
    qualitySelect.disabled = true;
    bitrateSelect.disabled = false;
  }
  refreshFormatIdSelector();
}

function refreshFormatSelectors(formats) {
  const { qualities, bitrates } = collectFormatOptions(formats);
  const qualityOptions = qualities.length ? qualities : DEFAULT_MP4_QUALITIES;
  const bitrateOptions = bitrates.length ? bitrates : DEFAULT_MP3_BITRATES;

  setSelectOptions($("qualityInput"), qualityOptions);
  setSelectOptions($("bitrateInput"), bitrateOptions);
  syncOutputTypeFields();
  refreshFormatIdSelector();

  const hint = $("formatSelectHint");
  if (!hint) {
    return;
  }
  if (!Array.isArray(formats) || formats.length === 0) {
    hint.textContent = t("hintParseFirst");
    return;
  }
  hint.textContent = t("hintLoadedFormats", {
    videoCount: qualities.length || 0,
    audioCount: bitrates.length || 0,
  });
}

function renderCookieList(items) {
  const container = $("cookieList");
  if (!items.length) {
    container.innerHTML = `<div class='mono'>${escapeHtml(t("noUploadedCookies"))}</div>`;
    return;
  }

  container.innerHTML = items
    .map((item) => {
      const id = String(item.cookieFileId || "");
      const selected = id === uploadedCookieFileId;
      const selectedLabel = selected ? t("currentInUse") : "";
      return `
        <div class="cookie-row">
          <div class="cookie-meta mono">
            <div>file=${escapeHtml(item.fileName || "cookies.txt")} ${selectedLabel}</div>
            <div>cookieFileId=${escapeHtml(id)}</div>
            <div>createdAt=${escapeHtml(formatDateTime(item.createdAt))}</div>
            <div>lastUsedAt=${escapeHtml(formatDateTime(item.lastUsedAt))}</div>
          </div>
          <div class="cookie-actions">
            <button type="button" class="secondary btn-mini" data-action="use" data-id="${escapeHtml(id)}">${escapeHtml(t("use"))}</button>
            <button type="button" class="btn-mini btn-danger" data-action="delete" data-id="${escapeHtml(id)}">${escapeHtml(t("delete"))}</button>
          </div>
        </div>
      `;
    })
    .join("");
}

async function listCookieFiles() {
  const container = $("cookieList");
  try {
    const res = await fetch("/api/v1/cookies");
    const data = await safeJson(res);
    if (!res.ok) {
      container.innerHTML = `<div class="error">${formatApiError(data, t("fetchCookiesFailed"))}</div>`;
      return;
    }
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (
      uploadedCookieFileId &&
      !items.some((item) => item.cookieFileId === uploadedCookieFileId)
    ) {
      setSelectedCookieFile(null);
    }
    renderCookieList(items);
  } catch (err) {
    container.innerHTML = `<div class="error">${t("requestFailed", {
      message: err.message || t("ensureApiRunning"),
    })}</div>`;
  }
}

async function uploadCookieFile() {
  $("cookieUploadMsg").textContent = "";
  const input = $("cookieFileInput");
  const file = input.files && input.files[0];
  if (!file) {
    showError($("cookieUploadMsg"), t("selectCookieFileFirst"));
    return null;
  }

  try {
    showOk($("cookieUploadMsg"), t("uploadingCookies"));
    const form = new FormData();
    form.append("cookieFile", file);

    const res = await fetch("/api/v1/cookies", {
      method: "POST",
      body: form,
    });
    const data = await safeJson(res);
    if (!res.ok) {
      showError($("cookieUploadMsg"), formatApiError(data, t("uploadCookiesFailed")));
      return null;
    }

    const newCookieFileId = data.cookieFileId;
    if (!newCookieFileId) {
      showError($("cookieUploadMsg"), t("uploadMissingCookieId"));
      return null;
    }
    setSelectedCookieFile(newCookieFileId);
    showOk(
      $("cookieUploadMsg"),
      t("uploadSucceeded", { fileName: data.fileName || "cookies.txt" })
    );
    await listCookieFiles();
    return newCookieFileId;
  } catch (err) {
    showError(
      $("cookieUploadMsg"),
      t("requestFailed", {
        message: err.message || t("ensureApiRunning"),
      })
    );
    return null;
  }
}

function clearCookieFile() {
  setSelectedCookieFile(null);
  $("cookieFileInput").value = "";
  $("cookieUploadMsg").textContent = "";
}

async function deleteCookieFile(cookieFileId) {
  if (!cookieFileId) {
    return;
  }
  const confirmed = window.confirm(t("confirmDeleteCookieFile"));
  if (!confirmed) {
    return;
  }

  try {
    const res = await fetch(`/api/v1/cookies/${encodeURIComponent(cookieFileId)}`, {
      method: "DELETE",
    });
    const data = await safeJson(res);
    if (!res.ok) {
      showError($("cookieUploadMsg"), formatApiError(data, t("deleteCookiesFailed")));
      return;
    }
    if (uploadedCookieFileId === cookieFileId) {
      setSelectedCookieFile(null);
    }
    showOk($("cookieUploadMsg"), t("deleteSuccess"));
    await listCookieFiles();
  } catch (err) {
    showError(
      $("cookieUploadMsg"),
      t("requestFailed", {
        message: err.message || t("ensureApiRunning"),
      })
    );
  }
}

async function selectCookieFile(cookieFileId) {
  if (!cookieFileId) {
    return;
  }
  setSelectedCookieFile(cookieFileId);
  showOk($("cookieUploadMsg"), t("setCurrentCookies"));
  await listCookieFiles();
}

async function parseUrl() {
  $("parseError").textContent = "";
  $("parseResult").classList.add("hidden");
  const url = $("urlInput").value.trim();
  if (!url) {
    showError($("parseError"), t("inputUrlFirst"));
    return;
  }

  try {
    const res = await fetch("/api/v1/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        cookieFileId: uploadedCookieFileId || undefined,
      }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      latestParsedFormats = [];
      refreshFormatSelectors(latestParsedFormats);
      showError($("parseError"), formatApiError(data, t("parseFailed")));
      return;
    }

    latestParsedFormats = Array.isArray(data.formats) ? data.formats : [];
    refreshFormatSelectors(latestParsedFormats);

    $("parseResult").classList.remove("hidden");
    $("metaBlock").textContent =
      `videoId=${data.videoId}\n` +
      `title=${data.title}\n` +
      `durationSeconds=${data.durationSeconds}`;

    $("formatList").innerHTML = latestParsedFormats
      .map((f) => {
        const typeLabel =
          f.hasVideo && f.hasAudio
            ? t("qualityAudioTypeVideoAudio")
            : f.hasVideo
              ? t("qualityAudioTypeVideoOnly")
              : f.hasAudio
                ? t("qualityAudioTypeAudioOnly")
                : t("qualityAudioTypeUnknown");
        return `<li>${f.id} | ${f.container} | ${f.quality || "-"} | abr=${f.audioBitrate || "-"} | ${typeLabel} | size=${f.estimatedFileSize || "-"}</li>`;
      })
      .join("");
  } catch (err) {
    latestParsedFormats = [];
    refreshFormatSelectors(latestParsedFormats);
    showError(
      $("parseError"),
      t("requestFailedApi", { message: err.message || t("apiNotRunning") })
    );
  }
}

async function createTask() {
  $("taskCreateMsg").textContent = "";
  const url = $("urlInput").value.trim();
  if (!url) {
    showError($("taskCreateMsg"), t("inputUrlFirst"));
    return;
  }

  const selectedCookieFile = $("cookieFileInput").files?.[0];
  if (selectedCookieFile && !uploadedCookieFileId) {
    showOk($("taskCreateMsg"), t("autoUploadingCookies"));
    const uploadedId = await uploadCookieFile();
    if (!uploadedId) {
      showError($("taskCreateMsg"), t("cookieAutoUploadFailed"));
      return;
    }
  }

  const outputType = $("outputType").value;
  const payload = {
    url,
    outputType,
    formatId: $("formatIdInput").value.trim() || undefined,
    quality: outputType === "mp4" ? $("qualityInput").value.trim() : undefined,
    audioBitrate: outputType === "mp3" ? $("bitrateInput").value.trim() : undefined,
    rightsConfirmed: $("rightsConfirmed").checked,
    cookieFileId: uploadedCookieFileId || undefined,
  };

  try {
    const res = await fetch("/api/v1/tasks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": createIdempotencyKey(),
      },
      body: JSON.stringify(payload),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      showError($("taskCreateMsg"), formatApiError(data, t("createTaskFailed")));
      return;
    }

    showOk($("taskCreateMsg"), t("taskCreated", { taskId: data.taskId, status: data.status }));

    await listTasks();
    if (taskPollTimer) {
      window.clearInterval(taskPollTimer);
    }
    taskPollTimer = window.setInterval(listTasks, 1000);
  } catch (err) {
    showError(
      $("taskCreateMsg"),
      t("requestFailed", {
        message: err.message || t("ensureApiWorkerRunning"),
      })
    );
  }
}

function isTaskCancelable(status) {
  return status === "queued" || status === "downloading" || status === "transcoding";
}

function getTaskStage(status) {
  switch (status) {
    case "queued":
      return {
        label: t("stageQueued"),
        detail: t("stageQueuedDetail"),
      };
    case "downloading":
      return {
        label: t("stageDownloading"),
        detail: t("stageDownloadingDetail"),
      };
    case "transcoding":
      return {
        label: t("stageTranscoding"),
        detail: t("stageTranscodingDetail"),
      };
    case "uploading":
      return {
        label: t("stageUploading"),
        detail: t("stageUploadingDetail"),
      };
    case "success":
      return {
        label: t("stageSuccess"),
        detail: t("stageSuccessDetail"),
      };
    case "failed":
      return {
        label: t("stageFailed"),
        detail: t("stageFailedDetail"),
      };
    case "canceled":
      return {
        label: t("stageCanceled"),
        detail: t("stageCanceledDetail"),
      };
    case "expired":
      return {
        label: t("stageExpired"),
        detail: t("stageExpiredDetail"),
      };
    default:
      return {
        label: t("stageUnknown", { status: status || t("yesNoHyphen") }),
        detail: t("stageUnknownDetail"),
      };
  }
}

function renderTaskProgressBlock(item) {
  const progress = Number.isFinite(Number(item.progress))
    ? Math.max(0, Math.min(100, Number(item.progress)))
    : 0;
  const stage = getTaskStage(item.status);
  return `
    <div class="task-stage">${escapeHtml(stage.label)}</div>
    <div class="task-stage-detail">${escapeHtml(stage.detail)}</div>
    <div class="task-progress"><div class="task-progress-fill" style="width:${progress}%;"></div></div>
    <div class="task-progress-label">${escapeHtml(
      t("progressRetryLabel", { progress, retry: item.retryCount })
    )}</div>
  `;
}

async function cancelTaskById(taskId) {
  if (!taskId) {
    return;
  }
  const confirmed = window.confirm(t("confirmCancelTask", { taskId }));
  if (!confirmed) {
    return;
  }
  try {
    const res = await fetch(`/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
    });
    const data = await safeJson(res);
    if (!res.ok) {
      showError($("taskCreateMsg"), formatApiError(data, t("cancelTaskFailed")));
      return;
    }
    showOk($("taskCreateMsg"), t("taskCanceled", { taskId: data.taskId }));
    await listTasks();
  } catch (err) {
    showError(
      $("taskCreateMsg"),
      t("requestFailed", {
        message: err.message || t("ensureApiRunning"),
      })
    );
  }
}

async function listTasks() {
  if (isTaskListRefreshing) {
    return;
  }
  isTaskListRefreshing = true;
  const refreshBtn = $("listBtn");
  if (refreshBtn) {
    refreshBtn.disabled = true;
  }
  try {
    const res = await fetch(`/api/v1/tasks?page=1&pageSize=20&_=${Date.now()}`, {
      cache: "no-store",
    });
    const data = await safeJson(res);
    if (!res.ok) {
      $("taskList").innerHTML = `<div class="error">${formatApiError(data, t("fetchTasksFailed"))}</div>`;
      return;
    }
    if (!data.items.length) {
      $("taskList").innerHTML = `<div class='mono'>${escapeHtml(t("noTasks"))}</div>`;
      return;
    }

    $("taskList").innerHTML = data.items
      .map((item) => {
        const download = item.downloadUrl
          ? `<a href="${item.downloadUrl}" target="_blank">${escapeHtml(t("download"))}</a>`
          : "-";
        const cancelButton = isTaskCancelable(item.status)
          ? `<button type="button" class="btn-mini btn-danger" data-action="cancel-task" data-id="${escapeHtml(item.taskId)}">${escapeHtml(t("cancel"))}</button>`
          : "-";
        const cookieInfo = item.cookieFileId ? item.cookieFileId : "-";
        return `
          <div class="mono" style="margin-bottom:8px;">
            <div>taskId=${item.taskId}</div>
            <div>status=${item.status}</div>
            ${renderTaskProgressBlock(item)}
            <div>formatId=${item.formatId || "-"}</div>
            <div>cookieFileId=${cookieInfo}</div>
            <div>error=${item.errorCode || "-"}</div>
            <div>message=${item.errorMessage || "-"}</div>
            <div>download=${download}</div>
            <div>actions=${cancelButton}</div>
          </div>
        `;
      })
      .join("");
  } catch (err) {
    $("taskList").innerHTML = `<div class="error">${t("requestFailed", {
      message: err.message || t("ensureApiRunning"),
    })}</div>`;
  } finally {
    isTaskListRefreshing = false;
    if (refreshBtn) {
      refreshBtn.disabled = false;
    }
  }
}

$("uploadCookieBtn").addEventListener("click", uploadCookieFile);
$("clearCookieBtn").addEventListener("click", clearCookieFile);
$("refreshCookieListBtn").addEventListener("click", listCookieFiles);
$("cookieList").addEventListener("click", async (event) => {
  const target = event.target.closest("button[data-action][data-id]");
  if (!target) {
    return;
  }
  const action = target.getAttribute("data-action");
  const cookieFileId = target.getAttribute("data-id");
  if (action === "use") {
    await selectCookieFile(cookieFileId);
    return;
  }
  if (action === "delete") {
    await deleteCookieFile(cookieFileId);
  }
});
$("cookieFileInput").addEventListener("change", () => {
  if (uploadedCookieFileId) {
    setSelectedCookieFile(null);
  }
  const file = $("cookieFileInput").files?.[0];
  if (file) {
    showOk(
      $("cookieUploadMsg"),
      t("selectedFile", { fileName: file.name })
    );
  } else {
    $("cookieUploadMsg").textContent = "";
  }
});
$("parseBtn").addEventListener("click", parseUrl);
$("createBtn").addEventListener("click", createTask);
$("listBtn").addEventListener("click", listTasks);
$("taskList").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action='cancel-task'][data-id]");
  if (!button) {
    return;
  }
  const taskId = button.getAttribute("data-id");
  await cancelTaskById(taskId);
});
$("outputType").addEventListener("change", syncOutputTypeFields);
uploadedCookieFileId = readCookieFileIdFromStorage() || null;
renderCookieFileState();
refreshFormatSelectors(latestParsedFormats);
listCookieFiles();
listTasks();


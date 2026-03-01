# VideoDownloader MVP

This project implements the PRD MVP with:
- Express API
- BullMQ queue + worker
- PostgreSQL schema (`db/schema.sql`)
- Minimal web page (`public/index.html`)

Real download mode is enabled by default.

## 1. Prerequisites

You need these services/tools:
- PostgreSQL
- Redis
- `yt-dlp`
- `ffmpeg`

Quick check:

```powershell
yt-dlp --version
ffmpeg -version
```

If you use Windows and `winget`:

```powershell
winget install -e --id yt-dlp.yt-dlp
winget install -e --id Gyan.FFmpeg
```

## 2. Environment

```powershell
Copy-Item .env.example .env
```

Important values:
- `YT_DLP_BIN` (default: `yt-dlp`)
- `FFMPEG_BIN` (default: `ffmpeg`)
- `YT_DLP_COOKIES_FILE` (optional, Netscape cookie file path)
- `YT_DLP_COOKIES_FROM_BROWSER` (optional, e.g. `chrome`, `edge`)
- `YT_DLP_ALLOW_BROWSER_COOKIES` (default: `false`; set `true` only if you explicitly want `--cookies-from-browser`)
- `YT_DLP_JS_RUNTIMES` (optional; e.g. `node:C:\\Program Files\\nodejs\\node.exe`)
- `COOKIE_UPLOAD_MAX_BYTES` (default: `10485760`)

## 3. Install dependencies

```powershell
npm.cmd install --cache .npm-cache
```

## 4. Run database migration

```powershell
npm.cmd run migrate
```

## 5. Start services

API:

```powershell
npm.cmd run dev
```

Worker:

```powershell
npm.cmd run worker
```

Open:

```text
http://localhost:3000
```

## 6. Optional: generate JWT for registered user

```powershell
npm.cmd run make-token -- demo@example.com
```

Use header:

```text
Authorization: Bearer <token>
```

## 7. Implemented API

- `POST /api/v1/parse`
- `POST /api/v1/tasks`
- `GET /api/v1/tasks/:taskId`
- `GET /api/v1/tasks`
- `POST /api/v1/tasks/:taskId/retry`
- `GET /api/v1/cookies`
- `POST /api/v1/cookies`
- `DELETE /api/v1/cookies/:cookieFileId`
- `POST /api/v1/complaints`
- `GET /api/v1/download/:taskId?token=...`

## 8. Notes

- Worker downloads real media via `yt-dlp`.
- Parse API (`POST /api/v1/parse`) now queries `yt-dlp` metadata and returns real available formats (not mock formats).
- Worker uses `ffmpeg` when output format conversion is needed.
- You can upload your own cookies in the web UI (Netscape `cookies.txt` or common JSON export); task creation binds `cookieFileId`.
- You can manage uploaded cookie files in the UI: list, select for current task, and delete.
- If a cookie file is selected but not uploaded, clicking `开始下载任务` will auto-upload before task creation.
- Browser cookie fallback (`YT_DLP_COOKIES_FROM_BROWSER`) is disabled by default to avoid DPAPI errors.
- Download links are signed and expire by default in 24 hours.
- If JWT is missing, request is treated as anonymous user (lower quota/concurrency).

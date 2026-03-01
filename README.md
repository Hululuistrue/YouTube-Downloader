# YouTube Downloader (MVP)

Web-based YouTube downloader MVP with real download pipeline:
- Express API
- BullMQ queue + worker
- PostgreSQL + Redis
- `yt-dlp` + `ffmpeg`
- Web UI (default English page at `/`, Chinese page at `/index.html`)

Use this project only for content you own or are explicitly authorized to download.

## English Guide

### 1. Prerequisites

- PostgreSQL (default `localhost:5432`)
- Redis (default `localhost:6379`)
- `yt-dlp`
- `ffmpeg`
- Node.js 20+

Quick check:

```powershell
yt-dlp --version
ffmpeg -version
node -v
```

Windows (`winget`) example:

```powershell
winget install -e --id yt-dlp.yt-dlp
winget install -e --id Gyan.FFmpeg
```

### 2. Setup environment

```powershell
Copy-Item .env.example .env
```

Key variables:
- `DATABASE_URL`
- `REDIS_URL`
- `YT_DLP_BIN` (default: `yt-dlp`)
- `FFMPEG_BIN` (default: `ffmpeg`)
- `YT_DLP_ALLOW_BROWSER_COOKIES` (default: `false`)
- `YT_DLP_COOKIES_FROM_BROWSER` (optional)
- `YT_DLP_JS_RUNTIMES` (optional; example: `node:C:\\Program Files\\nodejs\\node.exe`)
- `COOKIE_UPLOAD_MAX_BYTES` (default: `10485760`)
- `RUNNING_TASK_STALE_MINUTES` (default: `10`)

### 3. Install dependencies

```powershell
npm.cmd install --cache .npm-cache
```

### 4. Run migration

```powershell
npm.cmd run migrate
```

### 5. Start API and worker

API:

```powershell
npm.cmd run dev
```

Worker:

```powershell
npm.cmd run worker
```

Open UI:
- English: `http://localhost:3000/`
- Chinese: `http://localhost:3000/index.html`

### 6. Basic usage flow

1. Upload a valid cookie file in UI (`cookies.txt` Netscape format recommended).
2. Parse a YouTube URL.
3. Select output type (`mp4` or `mp3`) and exact `formatId` (optional but recommended).
4. Create task and watch staged progress (`downloading` -> `transcoding` -> `uploading`).
5. Download the file after task status becomes `success`.

### 7. Available scripts

- `npm.cmd run dev` - start API server
- `npm.cmd run worker` - start worker
- `npm.cmd run migrate` - apply DB schema
- `npm.cmd run db:reset` - reset schema data (development only)
- `npm.cmd run make-token -- <email>` - create JWT for testing

### 8. Implemented API

- `GET /health`
- `POST /api/v1/parse`
- `POST /api/v1/tasks`
- `GET /api/v1/tasks/:taskId`
- `GET /api/v1/tasks`
- `POST /api/v1/tasks/:taskId/retry`
- `POST /api/v1/tasks/:taskId/cancel`
- `GET /api/v1/cookies`
- `POST /api/v1/cookies`
- `DELETE /api/v1/cookies/:cookieFileId`
- `POST /api/v1/complaints`
- `GET /api/v1/download/:taskId?token=...`

## 中文使用说明

### 1. 运行前准备

- PostgreSQL（默认 `localhost:5432`）
- Redis（默认 `localhost:6379`）
- `yt-dlp`
- `ffmpeg`
- Node.js 20+

快速检查：

```powershell
yt-dlp --version
ffmpeg -version
node -v
```

Windows（`winget`）安装示例：

```powershell
winget install -e --id yt-dlp.yt-dlp
winget install -e --id Gyan.FFmpeg
```

### 2. 配置环境变量

```powershell
Copy-Item .env.example .env
```

重点配置项：
- `DATABASE_URL`
- `REDIS_URL`
- `YT_DLP_BIN`（默认 `yt-dlp`）
- `FFMPEG_BIN`（默认 `ffmpeg`）
- `YT_DLP_ALLOW_BROWSER_COOKIES`（默认 `false`）
- `YT_DLP_COOKIES_FROM_BROWSER`（可选）
- `YT_DLP_JS_RUNTIMES`（可选，示例：`node:C:\\Program Files\\nodejs\\node.exe`）
- `COOKIE_UPLOAD_MAX_BYTES`（默认 `10485760`）
- `RUNNING_TASK_STALE_MINUTES`（默认 `10`）

### 3. 安装依赖

```powershell
npm.cmd install --cache .npm-cache
```

### 4. 执行数据库迁移

```powershell
npm.cmd run migrate
```

### 5. 启动服务

启动 API：

```powershell
npm.cmd run dev
```

启动 Worker：

```powershell
npm.cmd run worker
```

访问页面：
- 英文默认页：`http://localhost:3000/`
- 中文页面：`http://localhost:3000/index.html`

### 6. 基本操作流程

1. 在页面上传可用的 Cookie 文件（建议 Netscape `cookies.txt`）。
2. 输入 YouTube 链接并解析。
3. 选择输出格式（`mp4` 或 `mp3`）和具体 `formatId`（推荐）。
4. 创建任务并观察阶段进度（下载 -> 转码 -> 落盘）。
5. 任务状态变成 `success` 后下载文件。

### 7. 说明

- 默认启用真实下载模式（非模拟）。
- 若未携带 JWT，会按匿名用户限额和并发策略执行。
- 下载链接默认签名并在 24 小时后过期。

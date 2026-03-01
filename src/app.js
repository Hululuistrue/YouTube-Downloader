const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const multer = require("multer");
const { z } = require("zod");
const { requestContext } = require("./middleware/request-context");
const { authContext } = require("./middleware/auth-context");
const { errorResponse } = require("./errors");
const db = require("./db");
const config = require("./config");
const { AppError } = require("./utils/app-error");
const { parseSourceWithYtDlp } = require("./services/parse-service");
const {
  createTask,
  findTaskByIdForUser,
  listTasksForUser,
  retryTask,
  cancelTask,
} = require("./services/task-service");
const {
  saveUserCookieFile,
  resolveCookieFileForUser,
  listCookieFilesForUser,
  deleteCookieFileForUser,
} = require("./services/cookie-file-service");
const { taskQueue } = require("./queue");
const {
  createDownloadToken,
  verifyDownloadToken,
} = require("./services/download-token-service");

const statusSchema = z.enum([
  "queued",
  "downloading",
  "transcoding",
  "uploading",
  "success",
  "failed",
  "canceled",
  "expired",
]);

function buildDownloadUrl(taskId, expiresAtIso) {
  if (!expiresAtIso) {
    return null;
  }
  const exp = Math.floor(new Date(expiresAtIso).getTime() / 1000);
  if (!Number.isFinite(exp)) {
    return null;
  }
  const token = createDownloadToken({ taskId, expEpochSeconds: exp });
  return `/api/v1/download/${taskId}?token=${token}`;
}

function formatTask(task) {
  return {
    taskId: task.id,
    status: task.status,
    progress: task.progress,
    formatId: task.format_id,
    errorCode: task.error_code,
    errorMessage: task.error_message,
    downloadUrl:
      task.status === "success" ? buildDownloadUrl(task.id, task.expires_at) : null,
    expiresAt: task.expires_at,
    retryCount: task.retry_count,
    cookieFileId: task.cookie_file_id,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

async function failTaskAfterEnqueueError(taskId, message) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT status
       FROM download_tasks
       WHERE id = $1
       FOR UPDATE`,
      [taskId]
    );
    if (current.rows.length === 0) {
      await client.query("COMMIT");
      return;
    }
    const fromStatus = current.rows[0].status;
    if (fromStatus !== "queued") {
      await client.query("COMMIT");
      return;
    }

    await client.query(
      `UPDATE download_tasks
       SET status = 'failed',
           error_code = 'INTERNAL_ERROR',
           error_message = $2,
           finished_at = now()
       WHERE id = $1`,
      [taskId, message]
    );

    await client.query(
      `INSERT INTO task_events (task_id, from_status, to_status, message)
       VALUES ($1, $2, 'failed', $3)`,
      [taskId, fromStatus, message]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function createApp() {
  const app = express();
  const cookieUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.cookieUploadMaxBytes,
      files: 1,
    },
  });

  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan("tiny"));
  app.use(requestContext);
  app.use(authContext);

  app.get("/", (req, res) => {
    return res.sendFile(path.join(process.cwd(), "public", "en.html"));
  });

  app.use(express.static(path.join(process.cwd(), "public")));

  app.use(
    "/api/",
    rateLimit({
      windowMs: 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
      handler: (req, res) =>
        errorResponse(res, 429, "RATE_LIMITED", "Too many requests"),
    })
  );

  app.get("/health", async (req, res) => {
    try {
      await db.query("SELECT 1");
      return res.json({
        status: "ok",
        requestId: res.locals.requestId,
        timestamp: new Date().toISOString(),
      });
    } catch {
      return errorResponse(res, 500, "INTERNAL_ERROR", "Health check failed");
    }
  });

  app.post("/api/v1/parse", async (req, res) => {
    try {
      const cookieFileId =
        req.body && typeof req.body.cookieFileId === "string"
          ? req.body.cookieFileId
          : null;
      let cookieFilePath = null;
      if (cookieFileId) {
        const cookieFile = await resolveCookieFileForUser(req.user, cookieFileId);
        cookieFilePath = cookieFile.file_path;
      }

      const parsed = await parseSourceWithYtDlp(req.body, { cookieFilePath });
      if (!parsed.ok) {
        const statusCode = parsed.errorCode === "INTERNAL_ERROR" ? 500 : 400;
        return errorResponse(res, statusCode, parsed.errorCode, parsed.message);
      }
      return res.json({
        videoId: parsed.data.videoId,
        title: parsed.data.title,
        durationSeconds: parsed.data.durationSeconds,
        thumbnail: parsed.data.thumbnail,
        formats: parsed.data.formats,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return errorResponse(res, 400, "BAD_REQUEST", "Invalid parse payload", {
          issues: err.issues,
        });
      }
      console.error("[parse] error:", err);
      return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to parse URL");
    }
  });

  app.post("/api/v1/cookies", (req, res) => {
    cookieUpload.single("cookieFile")(req, res, async (uploadErr) => {
      if (uploadErr) {
        if (uploadErr.code === "LIMIT_FILE_SIZE") {
          return errorResponse(
            res,
            400,
            "BAD_REQUEST",
            `Cookie file exceeds max size (${config.cookieUploadMaxBytes} bytes)`
          );
        }
        if (uploadErr.code === "LIMIT_UNEXPECTED_FILE") {
          return errorResponse(
            res,
            400,
            "BAD_REQUEST",
            "Form field 'cookieFile' is required"
          );
        }
        return errorResponse(res, 400, "BAD_REQUEST", uploadErr.message);
      }
      if (!req.file) {
        return errorResponse(res, 400, "BAD_REQUEST", "cookieFile is required");
      }
      try {
        const saved = await saveUserCookieFile(req.user, req.file);
        return res.status(201).json({
          cookieFileId: saved.id,
          fileName: saved.original_file_name,
          createdAt: saved.created_at,
        });
      } catch (err) {
        if (err instanceof AppError) {
          return errorResponse(
            res,
            err.statusCode,
            err.errorCode,
            err.message,
            err.details
          );
        }
        console.error("[cookies.upload] error:", err);
        return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to upload cookie file");
      }
    });
  });

  app.get("/api/v1/cookies", async (req, res) => {
    try {
      const rows = await listCookieFilesForUser(req.user);
      return res.json({
        items: rows.map((row) => ({
          cookieFileId: row.id,
          fileName: row.original_file_name,
          isActive: row.is_active,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastUsedAt: row.last_used_at,
        })),
      });
    } catch (err) {
      console.error("[cookies.list] error:", err);
      return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to list cookie files");
    }
  });

  app.delete("/api/v1/cookies/:cookieFileId", async (req, res) => {
    try {
      const cookieFileId = z.string().uuid().parse(req.params.cookieFileId);
      const result = await deleteCookieFileForUser(req.user, cookieFileId);
      return res.json({
        cookieFileId: result.id,
        deleted: result.deleted,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return errorResponse(res, 400, "BAD_REQUEST", "Invalid cookieFileId");
      }
      if (err instanceof AppError) {
        return errorResponse(res, err.statusCode, err.errorCode, err.message, err.details);
      }
      console.error("[cookies.delete] error:", err);
      return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to delete cookie file");
    }
  });

  app.post("/api/v1/tasks", async (req, res) => {
    try {
      const idempotencyKey = req.get("Idempotency-Key") || null;
      const result = await createTask(req.user, req.body, idempotencyKey);

      if (!result.deduplicated) {
        const jobId = `task_${result.task.id}_r${result.task.retry_count ?? 0}`;
        try {
          await taskQueue.add("process_download", { taskId: result.task.id }, { jobId });
        } catch (queueErr) {
          await failTaskAfterEnqueueError(
            result.task.id,
            "Queue enqueue failed while creating task"
          );
          throw queueErr;
        }
      }

      return res.status(202).json({
        taskId: result.task.id,
        status: result.task.status,
        deduplicated: result.deduplicated,
      });
    } catch (err) {
      if (err instanceof AppError) {
        return errorResponse(res, err.statusCode, err.errorCode, err.message, err.details);
      }
      console.error("[tasks.create] error:", err);
      return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to create task");
    }
  });

  app.get("/api/v1/tasks/:taskId", async (req, res) => {
    try {
      const task = await findTaskByIdForUser(req.params.taskId, req.user.id);
      if (!task) {
        return errorResponse(res, 404, "TASK_NOT_FOUND", "Task not found");
      }
      return res.json(formatTask(task));
    } catch (err) {
      console.error("[tasks.get] error:", err);
      return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to fetch task");
    }
  });

  app.get("/api/v1/tasks", async (req, res) => {
    try {
      let status;
      if (req.query.status !== undefined) {
        const parsedStatus = statusSchema.safeParse(req.query.status);
        if (!parsedStatus.success) {
          return errorResponse(res, 400, "BAD_REQUEST", "Invalid status filter");
        }
        status = parsedStatus.data;
      }
      const page = Math.max(Number.parseInt(req.query.page || "1", 10), 1);
      const pageSize = Math.min(
        Math.max(Number.parseInt(req.query.pageSize || "20", 10), 1),
        100
      );

      const result = await listTasksForUser(req.user.id, status, page, pageSize);
      return res.json({
        items: result.items.map(formatTask),
        page,
        pageSize,
        total: result.total,
      });
    } catch (err) {
      console.error("[tasks.list] error:", err);
      return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to list tasks");
    }
  });

  app.post("/api/v1/tasks/:taskId/retry", async (req, res) => {
    try {
      const retried = await retryTask(req.user, req.params.taskId);
      const jobId = `task_${retried.id}_r${retried.retry_count}`;
      try {
        await taskQueue.add("process_download", { taskId: retried.id }, { jobId });
      } catch (queueErr) {
        await failTaskAfterEnqueueError(
          retried.id,
          "Queue enqueue failed while retrying task"
        );
        throw queueErr;
      }
      return res.status(202).json({
        taskId: retried.id,
        status: retried.status,
        retryCount: retried.retry_count,
      });
    } catch (err) {
      if (err instanceof AppError) {
        return errorResponse(res, err.statusCode, err.errorCode, err.message, err.details);
      }
      console.error("[tasks.retry] error:", err);
      return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to retry task");
    }
  });

  app.post("/api/v1/tasks/:taskId/cancel", async (req, res) => {
    try {
      const canceled = await cancelTask(req.user, req.params.taskId);
      if (canceled.fromStatus === "queued") {
        const jobId = `task_${canceled.id}_r${canceled.retry_count ?? 0}`;
        try {
          const job = await taskQueue.getJob(jobId);
          if (job) {
            await job.remove();
          }
        } catch (queueErr) {
          console.warn(
            `[tasks.cancel] failed to remove queued job from queue. taskId=${canceled.id}: ${queueErr.message}`
          );
        }
      }
      return res.json({
        taskId: canceled.id,
        status: canceled.status,
        alreadyCanceled: canceled.alreadyCanceled,
      });
    } catch (err) {
      if (err instanceof AppError) {
        return errorResponse(res, err.statusCode, err.errorCode, err.message, err.details);
      }
      console.error("[tasks.cancel] error:", err);
      return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to cancel task");
    }
  });

  app.post("/api/v1/complaints", async (req, res) => {
    try {
      const complaintSchema = z.object({
        taskId: z.string().uuid().optional(),
        url: z.string().url(),
        reason: z.string().min(5).max(2000),
        contact: z.string().min(5).max(320),
      });
      const payload = complaintSchema.parse(req.body);
      const { rows } = await db.query(
        `INSERT INTO complaint_tickets (task_id, source_url, reason, contact, status)
         VALUES ($1, $2, $3, $4, 'open')
         RETURNING id, status, created_at`,
        [payload.taskId || null, payload.url, payload.reason, payload.contact]
      );
      const ticket = rows[0];
      return res.status(201).json({
        ticketId: ticket.id,
        status: ticket.status,
        createdAt: ticket.created_at,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return errorResponse(res, 400, "BAD_REQUEST", "Invalid complaint payload", {
          issues: err.issues,
        });
      }
      console.error("[complaints.create] error:", err);
      return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to create complaint");
    }
  });

  app.get("/api/v1/download/:taskId", async (req, res) => {
    try {
      const task = await findTaskByIdForUser(req.params.taskId, req.user.id);
      if (!task) {
        return errorResponse(res, 404, "TASK_NOT_FOUND", "Task not found");
      }
      if (task.status !== "success") {
        return errorResponse(res, 409, "INVALID_TASK_STATE", "Task is not ready to download");
      }
      if (!task.expires_at || new Date(task.expires_at).getTime() <= Date.now()) {
        return errorResponse(res, 410, "DOWNLOAD_EXPIRED", "Download link has expired");
      }

      const token = req.query.token;
      if (!verifyDownloadToken(token, task.id)) {
        return errorResponse(res, 403, "INVALID_DOWNLOAD_TOKEN", "Invalid download token");
      }

      if (!task.output_object_key) {
        return errorResponse(res, 500, "INTERNAL_ERROR", "Missing output object key");
      }
      const filePath = path.join(config.outputDir, task.output_object_key);
      if (!fs.existsSync(filePath)) {
        return errorResponse(res, 404, "FILE_NOT_FOUND", "Output file not found");
      }

      return res.download(filePath);
    } catch (err) {
      console.error("[download] error:", err);
      return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to process download");
    }
  });

  app.use((req, res) => errorResponse(res, 404, "NOT_FOUND", "Route not found"));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error("[unhandled]", err);
    return errorResponse(res, 500, "INTERNAL_ERROR", "Unhandled server error");
  });

  return app;
}

module.exports = {
  createApp,
};

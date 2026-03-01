const crypto = require("crypto");
const { z } = require("zod");
const db = require("../db");
const config = require("../config");
const { parseSource } = require("./parse-service");
const { AppError } = require("../utils/app-error");
const {
  resolveCookieFileForUser,
  markCookieFileUsed,
} = require("./cookie-file-service");

const runningStatuses = ["queued", "downloading", "transcoding", "uploading"];
const cancelableStatuses = ["queued", "downloading", "transcoding"];

function resolveStaleMinutes() {
  const value = Number.parseInt(config.runningTaskStaleMinutes, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return 10;
  }
  return value;
}

const createTaskSchema = z
  .object({
    url: z.string().url(),
    outputType: z.enum(["mp4", "mp3"]),
    formatId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[0-9A-Za-z._+\-]+$/)
      .optional(),
    quality: z.string().min(2).max(20).optional(),
    audioBitrate: z.string().min(2).max(20).optional(),
    rightsConfirmed: z.boolean(),
    cookieFileId: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.outputType === "mp4" && !value.quality) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quality"],
        message: "quality is required when outputType is mp4",
      });
    }
    if (value.outputType === "mp3" && !value.audioBitrate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["audioBitrate"],
        message: "audioBitrate is required when outputType is mp3",
      });
    }
  });

function hashSource(sourceUrl, outputType, formatId, quality, audioBitrate) {
  return crypto
    .createHash("sha256")
    .update(
      `${sourceUrl}|${outputType}|${formatId || ""}|${quality || ""}|${audioBitrate || ""}`
    )
    .digest("hex");
}

async function countDailyTasks(userId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM download_tasks
     WHERE user_id = $1
       AND created_at >= date_trunc('day', now())`,
    [userId]
  );
  return rows[0].count;
}

async function countRunningTasks(userId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM download_tasks
     WHERE user_id = $1
       AND status = ANY($2::task_status[])`,
    [userId, runningStatuses]
  );
  return rows[0].count;
}

async function recoverStaleRunningTasks(userId) {
  const staleMinutes = resolveStaleMinutes();
  const staleMessage = `Task auto-failed after ${staleMinutes} minutes without status/progress updates. Please retry.`;
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: staleRows } = await client.query(
      `SELECT id, status
       FROM download_tasks
       WHERE user_id = $1
         AND status = ANY($2::task_status[])
         AND updated_at < now() - ($3::int * interval '1 minute')
       FOR UPDATE`,
      [userId, runningStatuses, staleMinutes]
    );

    if (staleRows.length === 0) {
      await client.query("COMMIT");
      return 0;
    }

    for (const row of staleRows) {
      await client.query(
        `UPDATE download_tasks
         SET status = 'failed',
             error_code = 'INTERNAL_ERROR',
             error_message = $2,
             finished_at = now()
         WHERE id = $1`,
        [row.id, staleMessage]
      );
      await client.query(
        `INSERT INTO task_events (task_id, from_status, to_status, message)
         VALUES ($1, $2, 'failed', $3)`,
        [row.id, row.status, staleMessage]
      );
    }

    await client.query("COMMIT");
    return staleRows.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function resolveLimits(user) {
  if (user.role === "anonymous") {
    return {
      dailyQuota: config.anonDailyQuota,
      concurrencyLimit: config.anonConcurrencyLimit,
    };
  }
  return {
    dailyQuota: config.registeredDailyQuota,
    concurrencyLimit: config.registeredConcurrencyLimit,
  };
}

async function ensureTaskLimits(user) {
  const limits = resolveLimits(user);
  const recoveredCount = await recoverStaleRunningTasks(user.id);
  if (recoveredCount > 0) {
    console.warn(
      `[tasks.limits] recovered stale running tasks for user=${user.id}, count=${recoveredCount}`
    );
  }
  const [dailyCount, runningCount] = await Promise.all([
    countDailyTasks(user.id),
    countRunningTasks(user.id),
  ]);

  if (dailyCount >= limits.dailyQuota) {
    throw new AppError(429, "QUOTA_EXCEEDED", "Daily quota exceeded");
  }
  if (runningCount >= limits.concurrencyLimit) {
    throw new AppError(429, "CONCURRENCY_LIMITED", "Concurrency limit exceeded");
  }
}

async function findTaskByIdForUser(taskId, userId) {
  const { rows } = await db.query(
    `SELECT id, user_id, source_url, output_type, format_id, quality, audio_bitrate, status, progress,
            error_code, error_message, output_object_key, file_size, expires_at, created_at, updated_at, retry_count, cookie_file_id
     FROM download_tasks
     WHERE id = $1 AND user_id = $2`,
    [taskId, userId]
  );
  return rows[0] || null;
}

async function listTasksForUser(userId, status, page, pageSize) {
  const values = [userId];
  let whereClause = "WHERE user_id = $1";
  if (status) {
    values.push(status);
    whereClause += ` AND status = $${values.length}`;
  }
  values.push(pageSize);
  values.push((page - 1) * pageSize);

  const listQuery = `
    SELECT id, source_url, output_type, format_id, quality, audio_bitrate, status, progress,
           error_code, error_message, output_object_key, file_size, expires_at, created_at, updated_at, retry_count, cookie_file_id
    FROM download_tasks
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}
  `;

  const countValues = values.slice(0, values.length - 2);
  const countQuery = `
    SELECT COUNT(*)::int AS total
    FROM download_tasks
    ${whereClause}
  `;

  const [itemsResult, totalResult] = await Promise.all([
    db.query(listQuery, values),
    db.query(countQuery, countValues),
  ]);

  return {
    items: itemsResult.rows,
    total: totalResult.rows[0].total,
  };
}

async function insertTaskEvent(taskId, fromStatus, toStatus, message = null) {
  await db.query(
    `INSERT INTO task_events (task_id, from_status, to_status, message)
     VALUES ($1, $2, $3, $4)`,
    [taskId, fromStatus, toStatus, message]
  );
}

async function createTask(user, payload, idempotencyKey) {
  const parsed = createTaskSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(400, "BAD_REQUEST", "Invalid request payload", {
      issues: parsed.error.issues,
    });
  }
  const data = parsed.data;
  if (!data.rightsConfirmed) {
    throw new AppError(
      400,
      "RIGHTS_CONFIRMATION_REQUIRED",
      "rightsConfirmed must be true"
    );
  }

  if (idempotencyKey) {
    const { rows: dedupRows } = await db.query(
      `SELECT id, status
       FROM download_tasks
       WHERE user_id = $1 AND idempotency_key = $2`,
      [user.id, idempotencyKey]
    );
    if (dedupRows.length > 0) {
      return {
        task: dedupRows[0],
        deduplicated: true,
      };
    }
  }

  await ensureTaskLimits(user);

  const parsedSource = parseSource({ url: data.url });
  if (!parsedSource.ok) {
    throw new AppError(400, parsedSource.errorCode, parsedSource.message);
  }
  const normalizedUrl = parsedSource.data.sourceUrl;

  const sourceHash = hashSource(
    normalizedUrl,
    data.outputType,
    data.formatId,
    data.quality,
    data.audioBitrate
  );
  const cookieFile = await resolveCookieFileForUser(user, data.cookieFileId);

  const { rows } = await db.query(
    `INSERT INTO download_tasks
      (user_id, source_url, source_hash, platform, output_type, format_id, quality, audio_bitrate, status, progress, idempotency_key, rights_confirmed_at, cookie_file_id)
     VALUES
      ($1, $2, $3, 'youtube', $4, $5, $6, $7, 'queued', 0, $8, now(), $9)
     RETURNING id, status, retry_count`,
    [
      user.id,
      normalizedUrl,
      sourceHash,
      data.outputType,
      data.formatId || null,
      data.quality || null,
      data.audioBitrate || null,
      idempotencyKey || null,
      cookieFile ? cookieFile.id : null,
    ]
  );
  const task = rows[0];
  await markCookieFileUsed(cookieFile ? cookieFile.id : null);
  await insertTaskEvent(task.id, null, "queued", "Task created");
  return { task, deduplicated: false };
}

async function retryTask(user, taskId) {
  const task = await findTaskByIdForUser(taskId, user.id);
  if (!task) {
    throw new AppError(404, "TASK_NOT_FOUND", "Task not found");
  }
  if (task.status !== "failed") {
    throw new AppError(409, "INVALID_TASK_STATE", "Only failed tasks can be retried");
  }
  if (task.retry_count >= 2) {
    throw new AppError(409, "RETRY_LIMIT_REACHED", "Retry limit reached");
  }

  await ensureTaskLimits(user);

  const { rows } = await db.query(
    `UPDATE download_tasks
     SET status = 'queued',
         progress = 0,
         error_code = NULL,
         error_message = NULL,
         retry_count = retry_count + 1
     WHERE id = $1
     RETURNING id, status, retry_count`,
    [taskId]
  );
  const updated = rows[0];
  await insertTaskEvent(taskId, "failed", "queued", "Task retried");
  return updated;
}

async function cancelTask(user, taskId) {
  const task = await findTaskByIdForUser(taskId, user.id);
  if (!task) {
    throw new AppError(404, "TASK_NOT_FOUND", "Task not found");
  }
  if (task.status === "canceled") {
    return {
      id: task.id,
      status: task.status,
      retry_count: task.retry_count,
      fromStatus: task.status,
      alreadyCanceled: true,
    };
  }
  if (!cancelableStatuses.includes(task.status)) {
    throw new AppError(
      409,
      "INVALID_TASK_STATE",
      "Only queued/downloading/transcoding tasks can be canceled"
    );
  }

  const { rows } = await db.query(
    `UPDATE download_tasks
     SET status = 'canceled',
         error_code = NULL,
         error_message = 'Canceled by user',
         finished_at = now()
     WHERE id = $1
       AND user_id = $2
       AND status = ANY($3::task_status[])
     RETURNING id, status, retry_count`,
    [taskId, user.id, cancelableStatuses]
  );
  if (rows.length === 0) {
    const latest = await findTaskByIdForUser(taskId, user.id);
    if (!latest) {
      throw new AppError(404, "TASK_NOT_FOUND", "Task not found");
    }
    throw new AppError(
      409,
      "INVALID_TASK_STATE",
      `Task is ${latest.status}, cannot be canceled`
    );
  }

  await insertTaskEvent(taskId, task.status, "canceled", "Task canceled by user");
  return {
    ...rows[0],
    fromStatus: task.status,
    alreadyCanceled: false,
  };
}

module.exports = {
  createTask,
  findTaskByIdForUser,
  listTasksForUser,
  retryTask,
  cancelTask,
  insertTaskEvent,
};

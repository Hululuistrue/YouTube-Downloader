const { Worker } = require("bullmq");
const config = require("./config");
const {
  processTask,
  assertWorkerToolingReady,
} = require("./services/worker-task-service");

let worker = null;
let redisConnection = null;

async function start() {
  await assertWorkerToolingReady();
  const { connection } = require("./queue");
  redisConnection = connection;

  if (config.ytDlpCookiesFromBrowser && !config.ytDlpAllowBrowserCookies) {
    console.warn(
      "[worker] YT_DLP_COOKIES_FROM_BROWSER is set but disabled by YT_DLP_ALLOW_BROWSER_COOKIES=false"
    );
  }

  worker = new Worker(
    config.queueName,
    async (job) => {
      const { taskId } = job.data || {};
      if (!taskId) {
        throw new Error("Missing taskId in job payload");
      }
      await processTask(taskId);
    },
    {
      connection: redisConnection,
      concurrency: 2,
    }
  );

  worker.on("ready", () => {
    console.log(`[worker] ready. queue=${config.queueName}`);
  });

  worker.on("completed", (job) => {
    console.log(`[worker] completed job ${job.id}`);
  });

  worker.on("failed", (job, err) => {
    const id = job ? job.id : "unknown";
    console.error(`[worker] failed job ${id}:`, err.message);
  });
}

const shutdown = async (signal) => {
  console.log(`[worker] received ${signal}, shutting down...`);
  if (worker) {
    try {
      await worker.close();
    } catch (err) {
      console.warn("[worker] close failed:", err.message);
    }
  }
  if (redisConnection) {
    try {
      await redisConnection.quit();
    } catch (err) {
      console.warn("[worker] redis quit failed:", err.message);
    }
  }
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start().catch(async (err) => {
  console.error("[worker] startup failed:", err.message);
  if (redisConnection) {
    try {
      await redisConnection.quit();
    } catch (quitErr) {
      console.warn("[worker] redis quit failed:", quitErr.message);
    }
  }
  process.exit(1);
});

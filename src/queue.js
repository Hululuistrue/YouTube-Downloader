const IORedis = require("ioredis");
const { Queue } = require("bullmq");
const config = require("./config");

const connection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

connection.on("error", (err) => {
  console.error("[redis] connection error:", err.message);
});

const taskQueue = new Queue(config.queueName, { connection });

module.exports = {
  connection,
  taskQueue,
};

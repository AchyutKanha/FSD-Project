/**
 * BullMQ (Redis) job queue — the Node equivalent of Celery.
 *
 *   enqueueOrRun(name, data)  -> 'queued'  : handed to the worker process
 *                             -> 'inline'  : Redis unavailable (or tests), run in this process
 *
 * The inline fallback keeps the app usable on a laptop without Redis; in
 * production the worker (`npm run worker`) runs jobs and the cron schedules.
 */
const config = require('../config');

const QUEUE_NAME = 'emp-jobs';
let queue = null;
let connection = null;

function getQueue() {
  if (!config.redisUrl) return null;
  if (!queue) {
    // eslint-disable-next-line global-require
    const { Queue } = require('bullmq');
    // eslint-disable-next-line global-require
    const IORedis = require('ioredis');
    connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, enableOfflineQueue: false });
    connection.on('error', () => {});
    queue = new Queue(QUEUE_NAME, { connection });
  }
  return queue;
}

const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: 500,
  removeOnFail: 1000,
};

async function enqueueOrRun(name, data) {
  const q = getQueue();
  if (q && connection.status === 'ready') {
    try {
      await q.add(name, data, DEFAULT_JOB_OPTS);
      return 'queued';
    } catch (err) {
      if (!config.isTest) console.warn(`[queue] could not enqueue ${name}, running inline: ${err.message}`);
    }
  }
  // eslint-disable-next-line global-require
  const { runJob } = require('./handlers');
  const p = runJob(name, data).catch((err) => console.error(`[job:${name}] failed`, err));
  if (config.isTest) await p; // deterministic tests
  return 'inline';
}

async function closeQueue() {
  if (queue) await queue.close();
  if (connection) connection.disconnect();
  queue = null;
  connection = null;
}

// connect eagerly so the connection is ready by the first request
getQueue();

module.exports = { QUEUE_NAME, getQueue, enqueueOrRun, closeQueue, DEFAULT_JOB_OPTS };

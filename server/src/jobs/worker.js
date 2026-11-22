/**
 * Background worker: `npm run worker`
 *  - processes queued jobs (CSV exports, manual report/reminder runs)
 *  - registers the two cron schedules (daily reminders, monthly report)
 * Run exactly one or many — schedules are upserted by id, and every job is idempotent.
 */
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../config');
const { QUEUE_NAME, getQueue, closeQueue } = require('./queue');
const { runJob } = require('./handlers');
const { pool } = require('../db');

async function main() {
  if (!config.redisUrl) throw new Error('REDIS_URL is required for the worker');
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker(QUEUE_NAME, async (job) => runJob(job.name, job.data), { connection, concurrency: 4 });
  worker.on('completed', (job, result) => console.log(`[worker] ${job.name}#${job.id} done`, result ?? ''));
  worker.on('failed', (job, err) => console.error(`[worker] ${job?.name}#${job?.id} failed: ${err.message}`));

  const queue = getQueue();
  await queue.upsertJobScheduler('daily-reminders', { pattern: config.reminderCron, tz: config.tz }, { name: 'daily-reminders', data: {} });
  await queue.upsertJobScheduler('monthly-report', { pattern: config.monthlyReportCron, tz: config.tz }, { name: 'monthly-report', data: {} });
  console.log(`[worker] listening on "${QUEUE_NAME}". Reminders: "${config.reminderCron}", monthly report: "${config.monthlyReportCron}" (${config.tz})`);

  const shutdown = async () => {
    console.log('[worker] shutting down');
    await worker.close();
    await closeQueue();
    connection.disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => { console.error(err); process.exit(1); });

/**
 * Run a background job once, in this process (no Redis needed):
 *   npm run job -- reminders
 *   npm run job -- monthly 2026-10        (force re-generate October 2026)
 */
const { pool } = require('../src/db');
const { runJob } = require('../src/jobs/handlers');
const { closeCache } = require('../src/lib/cache');
const { closeQueue } = require('../src/jobs/queue');

const [, , which, arg] = process.argv;
const jobs = {
  reminders: () => runJob('daily-reminders', {}),
  monthly: () => runJob('monthly-report', { month: arg, force: true }),
};

if (!jobs[which]) {
  console.log('Usage: npm run job -- reminders | monthly [YYYY-MM]');
  process.exit(1);
}

jobs[which]()
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await closeQueue(); await closeCache(); await pool.end(); });

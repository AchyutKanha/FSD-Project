const { sendDailyReminders } = require('./reminders');
const { sendMonthlyReport } = require('./monthlyReport');
const { runExportJob } = require('./exportCsv');

const HANDLERS = {
  'daily-reminders': () => sendDailyReminders(),
  'monthly-report': (data) => sendMonthlyReport(data || {}),
  'export-history': (data) => runExportJob(data.exportJobId),
};

async function runJob(name, data) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown job "${name}"`);
  return handler(data);
}

module.exports = { runJob, HANDLERS };

/**
 * Background jobs. In tests Redis is not required: enqueueOrRun() runs the job
 * inline and awaits it, so the effects can be asserted immediately.
 */
const fs = require('fs');
const path = require('path');
const h = require('./helpers');
const config = require('../src/config');
const { sendDailyReminders } = require('../src/jobs/reminders');
const { sendMonthlyReport } = require('../src/jobs/monthlyReport');

beforeAll(h.start);
afterAll(h.stop);

test('student CSV export runs as a job, writes the file and notifies the student', async () => {
  const { slots } = await h.bookableExam({ slots: [{ capacity: 2 }] });
  const s = await h.registerStudent();
  await h.api('POST', '/student/bookings', { token: s.token, body: { slot_id: slots[0].id } });

  const start = await h.api('POST', '/student/exports', { token: s.token });
  expect(start.status).toBe(202);
  // poll like the UI does
  let job;
  for (let i = 0; i < 20; i += 1) {
    job = (await h.api('GET', `/student/exports/${start.body.job.id}`, { token: s.token })).body.job;
    if (job.status === 'Completed' || job.status === 'Failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(job.status).toBe('Completed');
  expect(job.row_count).toBe(1);
  const csv = fs.readFileSync(path.join(config.exportDir, job.file_name), 'utf8');
  expect(csv).toMatch(/Student ID,Roll Number,Student Name,Examination Name/);
  expect(csv).toMatch(/Not published/);

  const dl = await fetch(`${h.baseUrl()}/api/student/exports/${job.id}/download`, { headers: { Authorization: `Bearer ${s.token}` } });
  expect(dl.status).toBe(200);
  const other = await h.registerStudent();
  expect((await h.api('GET', `/student/exports/${job.id}`, { token: other.token })).status).toBe(404);

  const notes = await h.api('GET', '/notifications', { token: s.token });
  expect(notes.body.items.some((n) => n.title === 'Your export is ready')).toBe(true);
});

test('daily reminders are sent once per booking per day, even if the job runs twice at once', async () => {
  const { slots } = await h.bookableExam({ slots: [{ capacity: 2 }] });
  const s = await h.registerStudent();
  await h.api('POST', '/student/bookings', { token: s.token, body: { slot_id: slots[0].id } });

  const [a, b] = await Promise.all([sendDailyReminders(), sendDailyReminders()]);
  const { rows } = await h.query(
    "SELECT count(*)::int AS n FROM reminder_log rl JOIN bookings b ON b.id = rl.booking_id WHERE b.student_id = $1 AND rl.channel = 'email'",
    [s.id],
  );
  expect(rows[0].n).toBe(1);
  expect(a.email + b.email).toBeGreaterThanOrEqual(1);
  const again = await sendDailyReminders();
  expect(again.email).toBe(0);
});

test('monthly report is generated once per month unless forced', async () => {
  const first = await sendMonthlyReport({ month: '2026-01', force: false });
  expect(first.month).toBe('2026-01');
  const second = await sendMonthlyReport({ month: '2026-01', force: false });
  expect(second.skipped).toBe(true);
  const forced = await sendMonthlyReport({ month: '2026-01', force: true });
  expect(forced.summary).toBeDefined();
  const admin = await h.adminToken();
  const html = await fetch(`${h.baseUrl()}/api/admin/reports/monthly/2026-01`, { headers: { Authorization: `Bearer ${admin}` } });
  expect(await html.text()).toMatch(/Monthly examination report/);
});

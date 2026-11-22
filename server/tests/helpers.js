/**
 * Test helpers: boots the real Express app on an ephemeral port and talks to it
 * over HTTP with fetch, so every test exercises routing, validation, auth and SQL.
 * Fixtures are created through the API (as a user would), except where a test
 * needs to move time (e.g. put a slot in the past), which is done with SQL.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const app = require('../src/app');
const { pool, query } = require('../src/db');
const { ensureAdmin } = require('../src/lib/admin');
const config = require('../src/config');
const { closeCache } = require('../src/lib/cache');
const { closeQueue } = require('../src/jobs/queue');

let server;
let base;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function start() {
  await ensureAdmin();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}

async function stop() {
  if (server) await new Promise((r) => server.close(r));
  await closeQueue();
  await closeCache();
  await pool.end();
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, body: data };
}

async function login(email, password) {
  const r = await api('POST', '/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.body.token;
}
const adminToken = () => login(config.admin.email, config.admin.password);

async function registerStudent(i = uniq()) {
  const email = `stu${i}@test.edu`;
  const r = await api('POST', '/auth/register', {
    body: { full_name: `Student ${i}`, email, password: 'Passw0rd!', roll_number: `R${i}`.slice(0, 20) },
  });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  return { id: r.body.user.id, token: r.body.token, email };
}

async function createExaminer(admin) {
  const i = uniq();
  const r = await api('POST', '/admin/examiners', {
    token: admin,
    body: { full_name: `Examiner ${i}`, email: `ex${i}@test.edu`, password: 'Passw0rd!', employee_code: `E${i}`.slice(0, 20), department: 'Testing' },
  });
  if (r.status !== 201) throw new Error(`examiner failed: ${JSON.stringify(r.body)}`);
  return { id: r.body.examiner.id, token: await login(`ex${i}@test.edu`, 'Passw0rd!') };
}

const tomorrow = (days = 1) => {
  const d = new Date(Date.now() + days * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: config.tz }); // YYYY-MM-DD
};

/**
 * Builds a ready-to-book examination:
 * course -> exam -> 2-criterion rubric (100%) -> examiner(s) -> slot creation open
 * -> slots created by examiners -> booking open.
 * slots: array of { capacity, examiner (index), day, start, end }
 */
async function bookableExam({ slots = [{ capacity: 1 }], examiners = 1, openBooking = true } = {}) {
  const admin = await adminToken();
  const i = uniq();
  const course = await api('POST', '/admin/courses', { token: admin, body: { code: `T-${i}`.toUpperCase().slice(0, 20), name: `Test course ${i}` } });
  const exam = await api('POST', '/admin/exams', {
    token: admin,
    body: { course_id: course.body.course.id, name: `Viva ${i}`, exam_type: 'Viva', duration_minutes: 15, max_marks: 50, pass_marks: 20 },
  });
  const examId = exam.body.exam.id;
  await api('POST', `/admin/exams/${examId}/rubrics`, { token: admin, body: { criterion_name: 'Concepts', max_marks: 10, weightage: 60 } });
  await api('POST', `/admin/exams/${examId}/rubrics`, { token: admin, body: { criterion_name: 'Communication', max_marks: 5, weightage: 40 } });
  const exs = [];
  for (let k = 0; k < examiners; k += 1) exs.push(await createExaminer(admin));
  await api('PUT', `/admin/exams/${examId}/examiners`, { token: admin, body: { examiner_ids: exs.map((e) => e.id) } });
  const open = await api('POST', `/admin/exams/${examId}/status`, { token: admin, body: { status: 'Slot Creation' } });
  if (open.status !== 200) throw new Error(`open slot creation: ${JSON.stringify(open.body)}`);

  const created = [];
  for (const [n, s] of slots.entries()) {
    const ex = exs[s.examiner || 0];
    const r = await api('POST', '/examiner/slots', {
      token: ex.token,
      body: {
        exam_id: examId, slot_date: tomorrow(s.day || 1), start_time: s.start || `${String(9 + n).padStart(2, '0')}:00`,
        end_time: s.end || `${String(9 + n).padStart(2, '0')}:45`, capacity: s.capacity,
      },
    });
    if (r.status !== 201) throw new Error(`slot: ${JSON.stringify(r.body)}`);
    created.push(r.body.slot);
  }
  if (openBooking) {
    const ob = await api('POST', `/admin/exams/${examId}/status`, { token: admin, body: { status: 'Booking Open' } });
    if (ob.status !== 200) throw new Error(`open booking: ${JSON.stringify(ob.body)}`);
  }
  return { admin, examId, examiners: exs, slots: created };
}

/** The invariant the whole design protects: the counter equals the active bookings. */
async function seatInvariant(slotId) {
  const { rows: [r] } = await query(
    `SELECT s.booked_count, s.capacity, s.status,
            (SELECT count(*)::int FROM bookings b WHERE b.slot_id = s.id AND b.status <> 'Cancelled') AS active
       FROM slots s WHERE s.id = $1`,
    [slotId],
  );
  return r;
}

/** Move a slot into the past (and close booking) so it can be evaluated. */
async function moveSlotToPast(admin, examId, slotId) {
  await api('POST', `/admin/exams/${examId}/status`, { token: admin, body: { status: 'Closed' } });
  await query(
    "UPDATE slots SET slot_date = CURRENT_DATE - 1, start_time = '09:00', end_time = '10:00' WHERE id = $1",
    [slotId],
  );
}

const baseUrl = () => base;

module.exports = {
  baseUrl, start, stop, api, login, adminToken, registerStudent, createExaminer, bookableExam, seatInvariant,
  moveSlotToPast, tomorrow, query, uniq,
};

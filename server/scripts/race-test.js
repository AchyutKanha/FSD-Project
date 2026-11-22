/**
 * Live race demonstration against a RUNNING server (no test framework needed):
 *
 *   npm run race                 # 50 students, 1 seat
 *   npm run race -- 100 3        # 100 students, 3 seats
 *
 * It builds a fresh bookable exam through the API as the admin, registers N
 * students, then fires all N booking requests at the same instant and reports
 * what the database says afterwards. Run it once normally (exactly `seats`
 * succeed) and once with NAIVE_BOOKING_DEMO=true on the server (overbooked).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const BASE = process.env.RACE_API || `http://localhost:${process.env.PORT || 4000}/api`;
const N = Number(process.argv[2] || 50);
const SEATS = Number(process.argv[3] || 1);
const tag = Date.now().toString(36);

async function call(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status >= 400 && !call.quiet) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return { status: res.status, data };
}

async function main() {
  const admin = (await call('POST', '/auth/login', null, { email: process.env.ADMIN_EMAIL || 'admin@emp.edu', password: process.env.ADMIN_PASSWORD || 'Admin@12345' })).data.token;
  const course = (await call('POST', '/admin/courses', admin, { code: `RACE-${tag}`.toUpperCase().slice(0, 20), name: `Race demo ${tag}` })).data.course;
  const exam = (await call('POST', '/admin/exams', admin, { course_id: course.id, name: `Race viva ${tag}`, exam_type: 'Viva', duration_minutes: 10, max_marks: 10 })).data.exam;
  await call('POST', `/admin/exams/${exam.id}/rubrics`, admin, { criterion_name: 'Overall', max_marks: 10, weightage: 100 });
  const pw = 'Passw0rd!';
  const ex = (await call('POST', '/admin/examiners', admin, { full_name: `Race Examiner ${tag}`, email: `race-ex-${tag}@demo.edu`, password: pw, employee_code: `RX${tag}`.slice(0, 20), department: 'Demo' })).data.examiner;
  await call('PUT', `/admin/exams/${exam.id}/examiners`, admin, { examiner_ids: [ex.id] });
  await call('POST', `/admin/exams/${exam.id}/status`, admin, { status: 'Slot Creation' });
  const exToken = (await call('POST', '/auth/login', null, { email: `race-ex-${tag}@demo.edu`, password: pw })).data.token;
  const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const slot = (await call('POST', '/examiner/slots', exToken, { exam_id: exam.id, slot_date: day, start_time: '10:00', end_time: '11:00', capacity: SEATS })).data.slot;
  await call('POST', `/admin/exams/${exam.id}/status`, admin, { status: 'Booking Open' });

  process.stdout.write(`Registering ${N} students... `);
  const students = await Promise.all(Array.from({ length: N }, (_, i) => call('POST', '/auth/register', null, {
    full_name: `Racer ${i}`, email: `racer-${tag}-${i}@demo.edu`, password: pw, roll_number: `RC${tag}${i}`.slice(0, 20),
  }).then((r) => r.data.token)));
  console.log('done.');

  console.log(`Firing ${N} simultaneous bookings at slot #${slot.id} (${SEATS} seat${SEATS > 1 ? 's' : ''})...`);
  call.quiet = true;
  const t0 = Date.now();
  const results = await Promise.all(students.map((t) => call('POST', '/student/bookings', t, { slot_id: slot.id })));
  const ms = Date.now() - t0;

  const tally = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  const detail = (await call('GET', `/admin/slots/${slot.id}`, admin)).data;
  const active = detail.bookings.filter((b) => b.status !== 'Cancelled').length;

  console.log(`\nHTTP results in ${ms} ms:`, tally);
  console.log(`Database: capacity=${detail.slot.capacity} booked_count=${detail.slot.booked_count} active bookings=${active} status=${detail.slot.status}`);
  const ok = active <= detail.slot.capacity && active === detail.slot.booked_count;
  console.log(ok ? '\n✅ PASS — no overbooking, counter matches the bookings.' : '\n❌ FAIL — OVERBOOKED: more bookings than seats (this is the naive version).');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e.message); process.exit(2); });

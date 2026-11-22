/**
 * The server must refuse invalid requests even when they bypass the UI.
 * Every request here is something the React app would never send.
 */
const h = require('./helpers');

beforeAll(h.start);
afterAll(h.stop);

describe('authentication and roles', () => {
  test('no token -> 401, wrong role -> 403', async () => {
    expect((await h.api('GET', '/admin/dashboard')).status).toBe(401);
    const s = await h.registerStudent();
    expect((await h.api('GET', '/admin/dashboard', { token: s.token })).status).toBe(403);
    expect((await h.api('GET', '/examiner/dashboard', { token: s.token })).status).toBe(403);
    expect((await h.api('GET', '/student/dashboard', { token: s.token })).status).toBe(200);
  });

  test('a tampered token is rejected', async () => {
    const s = await h.registerStudent();
    const [hd, , sig] = s.token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: String(s.id), role: 'admin' })).toString('base64url');
    expect((await h.api('GET', '/admin/dashboard', { token: `${hd}.${forged}.${sig}` })).status).toBe(401);
  });

  test('registration cannot create an admin or examiner', async () => {
    const r = await h.api('POST', '/auth/register', {
      body: { full_name: 'Mallory', email: `m${h.uniq()}@x.edu`, password: 'Passw0rd!', roll_number: `M${h.uniq()}`.slice(0, 20), role: 'admin' },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body.errors)).toMatch(/role|Unrecognized/i);
  });

  test('only one admin can ever exist (enforced by a unique index)', async () => {
    const res = await h.query(
      "INSERT INTO users (email, password_hash, full_name, role) VALUES ('second@x.edu', '$2b$10$abc', 'Second', 'admin')",
    ).catch((e) => e);
    expect(res.constraint).toBe('users_single_admin_uq');
  });

  test('duplicate email is 409, weak password is 400, wrong password is 401', async () => {
    const s = await h.registerStudent();
    const dup = await h.api('POST', '/auth/register', { body: { full_name: 'Dup', email: s.email.toUpperCase(), password: 'Passw0rd!', roll_number: `D${h.uniq()}`.slice(0, 20) } });
    expect(dup.status).toBe(409);
    const weak = await h.api('POST', '/auth/register', { body: { full_name: 'Weak', email: `w${h.uniq()}@x.edu`, password: 'short', roll_number: `W${h.uniq()}`.slice(0, 20) } });
    expect(weak.status).toBe(400);
    expect((await h.api('POST', '/auth/login', { body: { email: s.email, password: 'nope' } })).status).toBe(401);
  });

  test('a deactivated student is locked out immediately, even with a valid token', async () => {
    const admin = await h.adminToken();
    const s = await h.registerStudent();
    await h.api('PUT', `/admin/students/${s.id}/status`, { token: admin, body: { is_active: false } });
    expect((await h.api('GET', '/student/dashboard', { token: s.token })).status).toBe(403);
  });
});

describe('server-side validation', () => {
  test('malformed JSON, bad types and unknown fields are 400', async () => {
    const admin = await h.adminToken();
    const raw = await fetch(`${h.baseUrl()}/api/admin/courses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` }, body: '{"code": ',
    });
    expect(raw.status).toBe(400);
    const bad = await h.api('POST', '/admin/courses', { token: admin, body: { code: 'bad code!', name: 'x' } });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e) => e.field)).toEqual(expect.arrayContaining(['code', 'name']));
    const extra = await h.api('POST', '/admin/courses', { token: admin, body: { code: 'OK-1', name: 'Fine name', hacked: true } });
    expect(extra.status).toBe(400);
    const idParam = await h.api('GET', '/admin/exams/abc', { token: admin });
    expect(idParam.status).toBe(400);
  });

  test('exam timeline must be ordered', async () => {
    const admin = await h.adminToken();
    const c = await h.api('POST', '/admin/courses', { token: admin, body: { code: `TL-${h.uniq()}`.toUpperCase().slice(0, 20), name: 'Timeline course' } });
    const r = await h.api('POST', '/admin/exams', {
      token: admin,
      body: {
        course_id: c.body.course.id, name: 'Bad timeline', exam_type: 'Viva', duration_minutes: 10, max_marks: 10,
        booking_start: '2030-01-10T10:00:00+05:30', booking_end: '2030-01-05T10:00:00+05:30',
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.errors[0].field).toBe('booking_end');
  });

  test('rubric weightage cannot exceed 100 and booking cannot open below 100', async () => {
    const { admin, examId } = await h.bookableExam({ slots: [{ capacity: 2 }], openBooking: false });
    const over = await h.api('POST', `/admin/exams/${examId}/rubrics`, { token: admin, body: { criterion_name: 'Extra', max_marks: 5, weightage: 1 } });
    expect(over.status).toBe(400);
    const { body } = await h.api('GET', `/admin/exams/${examId}/rubrics`, { token: admin });
    await h.api('DELETE', `/admin/rubrics/${body.items[0].id}`, { token: admin });
    const open = await h.api('POST', `/admin/exams/${examId}/status`, { token: admin, body: { status: 'Booking Open' } });
    expect(open.status).toBe(409);
    expect(open.body.message).toMatch(/total 100/);
  });
});

describe('booking rules', () => {
  test('cannot book before booking opens, twice for one exam, or a cancelled slot', async () => {
    const { admin, examId, slots } = await h.bookableExam({ slots: [{ capacity: 3 }, { capacity: 3 }], openBooking: false });
    const s = await h.registerStudent();
    expect((await h.api('POST', '/student/bookings', { token: s.token, body: { slot_id: slots[0].id } })).status).toBe(409);
    await h.api('POST', `/admin/exams/${examId}/status`, { token: admin, body: { status: 'Booking Open' } });
    expect((await h.api('POST', '/student/bookings', { token: s.token, body: { slot_id: slots[0].id } })).status).toBe(201);
    const again = await h.api('POST', '/student/bookings', { token: s.token, body: { slot_id: slots[1].id } });
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/already have a booking/);
  });

  test('students cannot cancel after the booking deadline; admin can', async () => {
    const { admin, examId, slots } = await h.bookableExam({ slots: [{ capacity: 3 }] });
    const s = await h.registerStudent();
    const b = await h.api('POST', '/student/bookings', { token: s.token, body: { slot_id: slots[0].id } });
    await h.api('POST', `/admin/exams/${examId}/status`, { token: admin, body: { status: 'Closed' } });
    const late = await h.api('POST', `/student/bookings/${b.body.booking.id}/cancel`, { token: s.token, body: {} });
    expect(late.status).toBe(409);
    const byAdmin = await h.api('POST', `/admin/bookings/${b.body.booking.id}/cancel`, { token: admin, body: { reason: 'Medical leave' } });
    expect(byAdmin.status).toBe(200);
    expect(await h.seatInvariant(slots[0].id)).toMatchObject({ booked_count: 0, active: 0, status: 'Available' });
  });

  test('a student cannot see or cancel another student\'s booking', async () => {
    const { slots } = await h.bookableExam({ slots: [{ capacity: 3 }] });
    const a = await h.registerStudent();
    const b = await h.registerStudent();
    const bk = await h.api('POST', '/student/bookings', { token: a.token, body: { slot_id: slots[0].id } });
    expect((await h.api('GET', `/student/bookings/${bk.body.booking.id}`, { token: b.token })).status).toBe(404);
    expect((await h.api('POST', `/student/bookings/${bk.body.booking.id}/cancel`, { token: b.token, body: {} })).status).toBe(404);
  });
});

describe('examiner rules', () => {
  test('slots only during the slot-creation window; edits blocked once booking opened', async () => {
    const { examiners, examId, slots } = await h.bookableExam({ slots: [{ capacity: 2 }] });
    const create = await h.api('POST', '/examiner/slots', {
      token: examiners[0].token, body: { exam_id: examId, slot_date: h.tomorrow(4), start_time: '10:00', end_time: '11:00', capacity: 2 },
    });
    expect(create.status).toBe(409);
    const edit = await h.api('PUT', `/examiner/slots/${slots[0].id}`, { token: examiners[0].token, body: { capacity: 4 } });
    expect(edit.status).toBe(409);
  });

  test('a slot shorter than the exam duration or in the past is rejected', async () => {
    const { examiners, examId } = await h.bookableExam({ slots: [], openBooking: false });
    const short = await h.api('POST', '/examiner/slots', { token: examiners[0].token, body: { exam_id: examId, slot_date: h.tomorrow(), start_time: '10:00', end_time: '10:05', capacity: 1 } });
    expect(short.status).toBe(400);
    const past = await h.api('POST', '/examiner/slots', { token: examiners[0].token, body: { exam_id: examId, slot_date: '2020-01-01', start_time: '10:00', end_time: '11:00', capacity: 1 } });
    expect(past.status).toBe(400);
  });

  test('examiners evaluate only their own students, within rubric limits', async () => {
    const { admin, examId, slots, examiners } = await h.bookableExam({ slots: [{ capacity: 2, examiner: 0 }, { capacity: 2, examiner: 1 }], examiners: 2 });
    const s = await h.registerStudent();
    const bk = await h.api('POST', '/student/bookings', { token: s.token, body: { slot_id: slots[0].id } });
    const bookingId = bk.body.booking.id;

    // before the slot starts
    const early = await h.api('PUT', `/examiner/bookings/${bookingId}/evaluation`, { token: examiners[0].token, body: { scores: [], submit: false } });
    expect(early.status).toBe(409);

    await h.moveSlotToPast(admin, examId, slots[0].id);
    const form = await h.api('GET', `/examiner/bookings/${bookingId}/evaluation`, { token: examiners[0].token });
    const [c1, c2] = form.body.rubric;

    const other = await h.api('PUT', `/examiner/bookings/${bookingId}/evaluation`, { token: examiners[1].token, body: { scores: [], submit: false } });
    expect(other.status).toBe(403);

    const tooHigh = await h.api('PUT', `/examiner/bookings/${bookingId}/evaluation`, {
      token: examiners[0].token, body: { scores: [{ criterion_id: c1.id, marks: 11 }, { criterion_id: c2.id, marks: 5 }], submit: true },
    });
    expect(tooHigh.status).toBe(400);

    const incomplete = await h.api('PUT', `/examiner/bookings/${bookingId}/evaluation`, {
      token: examiners[0].token, body: { scores: [{ criterion_id: c1.id, marks: 8 }], submit: true },
    });
    expect(incomplete.status).toBe(400);

    const draft = await h.api('PUT', `/examiner/bookings/${bookingId}/evaluation`, {
      token: examiners[0].token, body: { scores: [{ criterion_id: c1.id, marks: 8 }], remarks: 'in progress', submit: false },
    });
    expect(draft.status).toBe(200);
    expect(draft.body.evaluation.version).toBe(1);

    // stale version -> 409 (optimistic concurrency)
    const stale = await h.api('PUT', `/examiner/bookings/${bookingId}/evaluation`, {
      token: examiners[0].token, body: { scores: [{ criterion_id: c1.id, marks: 8 }, { criterion_id: c2.id, marks: 4 }], submit: true, expected_version: 7 },
    });
    expect(stale.status).toBe(409);

    const ok = await h.api('PUT', `/examiner/bookings/${bookingId}/evaluation`, {
      token: examiners[0].token,
      body: { scores: [{ criterion_id: c1.id, marks: 8 }, { criterion_id: c2.id, marks: 4 }], remarks: 'Good', submit: true, expected_version: 1 },
    });
    expect(ok.status).toBe(200);
    // 50 * (8/10*60 + 4/5*40) / 100 = 50 * (48 + 32) / 100 = 40
    expect(ok.body.evaluation.total_marks).toBe(40);

    // history: two versions kept, booking completed
    const { rows: versions } = await h.query('SELECT version, status FROM evaluation_versions WHERE evaluation_id = $1 ORDER BY version', [ok.body.evaluation.id]);
    expect(versions).toEqual([{ version: 1, status: 'Draft' }, { version: 2, status: 'Submitted' }]);

    // results hidden until published, then visible
    expect((await h.api('GET', '/student/results', { token: s.token })).body.items).toHaveLength(0);
    const pub = await h.api('POST', `/admin/exams/${examId}/publish`, { token: admin });
    expect(pub.status).toBe(200);
    const results = await h.api('GET', '/student/results', { token: s.token });
    expect(results.body.items[0]).toMatchObject({ total_marks: 40, remarks: 'Good', passed: true });

    // published results lock evaluations
    const locked = await h.api('PUT', `/examiner/bookings/${bookingId}/evaluation`, {
      token: examiners[0].token, body: { scores: [{ criterion_id: c1.id, marks: 1 }, { criterion_id: c2.id, marks: 1 }], submit: true },
    });
    expect(locked.status).toBe(409);
  });

  test('publishing is refused while evaluations are pending', async () => {
    const { admin, examId, slots } = await h.bookableExam({ slots: [{ capacity: 2 }] });
    const s = await h.registerStudent();
    await h.api('POST', '/student/bookings', { token: s.token, body: { slot_id: slots[0].id } });
    await h.moveSlotToPast(admin, examId, slots[0].id);
    const pub = await h.api('POST', `/admin/exams/${examId}/publish`, { token: admin });
    expect(pub.status).toBe(409);
  });
});

describe('append-only history', () => {
  test('booking events cannot be edited or deleted, even with direct SQL', async () => {
    const { rows: [e] } = await h.query('SELECT id FROM booking_events LIMIT 1');
    const upd = await h.query("UPDATE booking_events SET reason = 'rewritten' WHERE id = $1", [e.id]).catch((err) => err);
    expect(upd.message).toMatch(/append-only/);
    const del = await h.query('DELETE FROM booking_events WHERE id = $1', [e.id]).catch((err) => err);
    expect(del.message).toMatch(/append-only|still referenced|violates/);
  });

  test('reassigning a slot to another examiner records history and notifies students', async () => {
    const { admin, slots, examiners } = await h.bookableExam({ slots: [{ capacity: 2 }], examiners: 2 });
    const s = await h.registerStudent();
    const bk = await h.api('POST', '/student/bookings', { token: s.token, body: { slot_id: slots[0].id } });
    const r = await h.api('PUT', `/admin/slots/${slots[0].id}/examiner`, { token: admin, body: { examiner_id: examiners[1].id, reason: 'Examiner unwell' } });
    expect(r.status).toBe(200);
    const detail = await h.api('GET', `/student/bookings/${bk.body.booking.id}`, { token: s.token });
    expect(detail.body.booking.examiner_id).toBe(examiners[1].id);
    expect(detail.body.events.map((e) => e.event_type)).toEqual(['BOOKED', 'EXAMINER_CHANGED']);
    const notes = await h.api('GET', '/notifications', { token: s.token });
    expect(notes.body.items.some((n) => /examiner has changed/i.test(n.title))).toBe(true);
  });
});

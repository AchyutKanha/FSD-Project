/**
 * THE HARD REQUIREMENT, TESTED.
 * "If two students book the last seat at the same moment, a naive version
 *  would let both in." Each test fires many requests at the same instant
 * (Promise.all) and then checks the database, not just the HTTP responses.
 */
const h = require('./helpers');

beforeAll(h.start);
afterAll(h.stop);

describe('concurrent booking', () => {
  test('30 students race for a 1-seat slot: exactly one wins', async () => {
    const { slots } = await h.bookableExam({ slots: [{ capacity: 1 }] });
    const students = await Promise.all(Array.from({ length: 30 }, () => h.registerStudent()));

    const results = await Promise.all(students.map((s) => h.api('POST', '/student/bookings', { token: s.token, body: { slot_id: slots[0].id } })));

    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(29);
    const inv = await h.seatInvariant(slots[0].id);
    expect(inv).toEqual({ booked_count: 1, capacity: 1, status: 'Full', active: 1 });
  });

  test('40 students race for 5 seats: exactly five win and the slot becomes Full', async () => {
    const { slots } = await h.bookableExam({ slots: [{ capacity: 5 }] });
    const students = await Promise.all(Array.from({ length: 40 }, () => h.registerStudent()));
    const results = await Promise.all(students.map((s) => h.api('POST', '/student/bookings', { token: s.token, body: { slot_id: slots[0].id } })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    const inv = await h.seatInvariant(slots[0].id);
    expect(inv.booked_count).toBe(5);
    expect(inv.active).toBe(5);
    expect(inv.status).toBe('Full');
  });

  test('one student double-clicking across two slots of the same exam gets one booking', async () => {
    const { slots, examId } = await h.bookableExam({ slots: [{ capacity: 10 }, { capacity: 10 }] });
    const s = await h.registerStudent();
    const results = await Promise.all(Array.from({ length: 10 }, (_, k) => h.api('POST', '/student/bookings', {
      token: s.token, body: { slot_id: slots[k % 2].id },
    })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const { rows } = await h.query("SELECT count(*)::int AS n FROM bookings WHERE student_id = $1 AND exam_id = $2 AND status <> 'Cancelled'", [s.id, examId]);
    expect(rows[0].n).toBe(1);
    const a = await h.seatInvariant(slots[0].id);
    const b = await h.seatInvariant(slots[1].id);
    expect(a.booked_count + b.booked_count).toBe(1);
    expect(a.booked_count).toBe(a.active);
    expect(b.booked_count).toBe(b.active);
  });

  test('a cancellation and a new booking for the freed seat at the same instant stay consistent', async () => {
    const { slots } = await h.bookableExam({ slots: [{ capacity: 1 }] });
    const holder = await h.registerStudent();
    const first = await h.api('POST', '/student/bookings', { token: holder.token, body: { slot_id: slots[0].id } });
    expect(first.status).toBe(201);
    const others = await Promise.all(Array.from({ length: 10 }, () => h.registerStudent()));

    const [cancel, ...attempts] = await Promise.all([
      h.api('POST', `/student/bookings/${first.body.booking.id}/cancel`, { token: holder.token, body: {} }),
      ...others.map((s) => h.api('POST', '/student/bookings', { token: s.token, body: { slot_id: slots[0].id } })),
    ]);
    expect(cancel.status).toBe(200);
    // the seat is either still free or taken by exactly one of the others
    expect(attempts.filter((r) => r.status === 201).length).toBeLessThanOrEqual(1);
    const inv = await h.seatInvariant(slots[0].id);
    expect(inv.booked_count).toBe(inv.active);
    expect(inv.booked_count).toBeLessThanOrEqual(1);
  });

  test('admin reschedule into a last seat while a student books it: one wins, counters stay exact', async () => {
    const { admin, slots } = await h.bookableExam({ slots: [{ capacity: 3 }, { capacity: 1 }] });
    const mover = await h.registerStudent();
    const b = await h.api('POST', '/student/bookings', { token: mover.token, body: { slot_id: slots[0].id } });
    const rival = await h.registerStudent();

    const [move, book] = await Promise.all([
      h.api('POST', `/admin/bookings/${b.body.booking.id}/reschedule`, { token: admin, body: { slot_id: slots[1].id, reason: 'Examiner request' } }),
      h.api('POST', '/student/bookings', { token: rival.token, body: { slot_id: slots[1].id } }),
    ]);
    // exactly one of the two requests gets the seat; the loser receives 409
    expect([move.status === 200, book.status === 201].filter(Boolean)).toHaveLength(1);
    expect([move.status, book.status]).toContain(409);

    for (const s of slots) {
      const inv = await h.seatInvariant(s.id);
      expect(inv.booked_count).toBe(inv.active);
    }
    const target = await h.seatInvariant(slots[1].id);
    expect(target).toMatchObject({ booked_count: 1, status: 'Full' });
  });

  test('two examiners cannot be double-booked: overlapping slots created at once -> one succeeds', async () => {
    const { examiners, examId, admin } = await h.bookableExam({ slots: [], openBooking: false });
    const day = h.tomorrow(3);
    const results = await Promise.all(Array.from({ length: 6 }, () => h.api('POST', '/examiner/slots', {
      token: examiners[0].token,
      body: { exam_id: examId, slot_date: day, start_time: '14:00', end_time: '15:00', capacity: 2 },
    })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(admin).toBeTruthy();
  });
});

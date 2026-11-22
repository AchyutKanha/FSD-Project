/**
 * THE HARD REQUIREMENT.
 *
 * "If two students book the last seat of a slot at the same moment, a naive
 *  version (read seats -> check -> insert -> write seats+1) would let both
 *  through and leave the slot overbooked."
 *
 * Here every seat-changing operation runs in ONE transaction that first locks
 * the slot row (SELECT ... FOR NO KEY UPDATE). The second request blocks on
 * that lock until the first commits, then re-reads the *committed* seat count
 * and is refused. Two database constraints back this up even if the code were
 * wrong: CHECK (booked_count <= capacity) and the partial UNIQUE index
 * "one active booking per student per exam".
 */
const { withTransaction } = require('../db');
const { badRequest, conflict, forbidden, notFound } = require('../lib/errors');
const { invalidate } = require('../lib/cache');
const { notify, fmtSlot } = require('../lib/notify');
const { lockStudent, lockSlotForWrite, peekBooking, lockBooking } = require('./locks');

const SEAT_INCREMENT = `
  UPDATE slots
     SET booked_count = booked_count + 1,
         status = CASE WHEN booked_count + 1 >= capacity THEN 'Full' ELSE 'Available' END
   WHERE id = $1
  RETURNING id, booked_count, capacity, available_seats, status`;

const SEAT_DECREMENT = `
  UPDATE slots
     SET booked_count = booked_count - 1,
         status = CASE WHEN status IN ('Available', 'Full') THEN 'Available' ELSE status END
   WHERE id = $1
  RETURNING id, booked_count, capacity, available_seats, status`;

async function assertNoTimeClash(c, studentId, slot, ignoreBookingId = 0) {
  const { rows } = await c.query(
    `SELECT e.name
       FROM bookings b
       JOIN slots s ON s.id = b.slot_id
       JOIN examinations e ON e.id = b.exam_id
      WHERE b.student_id = $1 AND b.status = 'Booked' AND b.id <> $5
        AND s.slot_date = $2 AND s.start_time < $4 AND s.end_time > $3
      LIMIT 1`,
    [studentId, slot.slot_date, slot.start_time, slot.end_time, ignoreBookingId],
  );
  if (rows[0]) throw conflict(`This slot clashes with your booking for "${rows[0].name}"`);
}

async function bookSlot({ studentId, slotId }) {
  const result = await withTransaction(async (c) => {
    const student = await lockStudent(c, studentId);         // 1. serialise this student's requests
    if (!student.is_active) throw forbidden('Your account has been deactivated');

    const slot = await lockSlotForWrite(c, slotId);          // 2. queue behind other bookers of this slot
    if (!slot.booking_window_open) throw conflict('Booking is not open for this examination');
    if (slot.has_started) throw conflict('This slot has already started');
    if (slot.status === 'Full' || slot.booked_count >= slot.capacity) throw conflict('This slot is full');
    if (slot.status !== 'Available') throw conflict(`This slot is ${slot.status.toLowerCase()}`);

    const dup = await c.query(                               // 3. one booking per exam
      "SELECT id FROM bookings WHERE student_id = $1 AND exam_id = $2 AND status <> 'Cancelled'",
      [studentId, slot.exam_id],
    );
    if (dup.rows[0]) throw conflict('You already have a booking for this examination');
    await assertNoTimeClash(c, studentId, slot);             // 4. no overlapping exams

    const { rows: [booking] } = await c.query(               // 5. write booking + seat atomically
      'INSERT INTO bookings (student_id, slot_id, exam_id) VALUES ($1, $2, $3) RETURNING *',
      [studentId, slotId, slot.exam_id],
    );
    const { rows: [seats] } = await c.query(SEAT_INCREMENT, [slotId]);
    await c.query(
      `INSERT INTO booking_events (booking_id, event_type, to_slot_id, to_examiner_id, actor_id)
       VALUES ($1, 'BOOKED', $2, $3, $4)`,
      [booking.id, slotId, slot.examiner_id, studentId],
    );
    await notify(c, studentId, 'Booking confirmed',
      `Your slot for ${slot.exam_name} on ${fmtSlot(slot)} is booked.`, `/student/bookings/${booking.id}`);
    return { booking, slot: seats };
  });
  await invalidate('slots', 'exams');
  return result;
}

/**
 * Cancel a booking. Students may cancel only their own booking, only while
 * booking is open and before the booking deadline. Admin may cancel any
 * not-yet-evaluated booking.
 */
async function cancelBooking({ bookingId, actor, reason }) {
  const isAdmin = actor.role === 'admin';
  const result = await withTransaction(async (c) => {
    const pre = await peekBooking(c, bookingId);
    if (!isAdmin && pre.student_id !== actor.id) throw notFound('Booking');

    await lockStudent(c, pre.student_id);
    const slot = await lockSlotForWrite(c, pre.slot_id);
    const booking = await lockBooking(c, bookingId, pre.slot_id);

    if (booking.status !== 'Booked') throw conflict(`This booking is already ${booking.status.toLowerCase()}`);
    if (!isAdmin) {
      if (slot.exam_status !== 'Booking Open' || !slot.before_booking_deadline) {
        throw conflict('The cancellation deadline for this examination has passed');
      }
      if (slot.has_started) throw conflict('This slot has already started');
    }
    const ev = await c.query('SELECT id FROM evaluations WHERE booking_id = $1', [bookingId]);
    if (ev.rows[0]) throw conflict('This booking already has an evaluation and cannot be cancelled');

    const { rows: [updated] } = await c.query(
      `UPDATE bookings SET status = 'Cancelled', cancelled_at = now(), cancel_reason = $2
        WHERE id = $1 RETURNING *`,
      [bookingId, reason || null],
    );
    const { rows: [seats] } = await c.query(SEAT_DECREMENT, [pre.slot_id]);
    await c.query(
      `INSERT INTO booking_events (booking_id, event_type, from_slot_id, from_examiner_id, actor_id, reason)
       VALUES ($1, 'CANCELLED', $2, $3, $4, $5)`,
      [bookingId, pre.slot_id, slot.examiner_id, actor.id, reason || null],
    );
    if (isAdmin) {
      await notify(c, booking.student_id, 'Booking cancelled by admin',
        `Your booking for ${slot.exam_name} on ${fmtSlot(slot)} was cancelled.${reason ? ` Reason: ${reason}` : ''}`,
        `/student/bookings/${bookingId}`);
    }
    return { booking: updated, slot: seats };
  });
  await invalidate('slots', 'exams');
  return result;
}

/**
 * Admin: move a booking to another slot of the same exam (multi-row transaction).
 * Source seat released, target seat taken, booking moved and history written —
 * all or nothing. If the target slot belongs to a different examiner this is
 * also the "reassign student to another examiner" operation.
 */
async function rescheduleBooking({ bookingId, targetSlotId, actorId, reason }) {
  const result = await withTransaction(async (c) => {
    const pre = await peekBooking(c, bookingId);
    if (pre.slot_id === targetSlotId) throw badRequest('The booking is already in that slot');

    await lockStudent(c, pre.student_id);
    // lock both slots in ascending id order (canonical order => no deadlock)
    const [firstId, secondId] = [pre.slot_id, targetSlotId].sort((a, b) => a - b);
    const first = await lockSlotForWrite(c, firstId);
    const second = await lockSlotForWrite(c, secondId);
    const source = first.id === pre.slot_id ? first : second;
    const target = first.id === targetSlotId ? first : second;

    const booking = await lockBooking(c, bookingId, pre.slot_id);
    if (booking.status !== 'Booked') throw conflict(`Only active bookings can be rescheduled (this one is ${booking.status.toLowerCase()})`);
    if (target.exam_id !== booking.exam_id) throw badRequest('The target slot belongs to a different examination');
    if (target.status !== 'Available' || target.booked_count >= target.capacity) {
      throw conflict(`The target slot is ${target.status === 'Available' ? 'full' : target.status.toLowerCase()}`);
    }
    if (target.has_started) throw conflict('The target slot has already started');
    const ev = await c.query('SELECT id FROM evaluations WHERE booking_id = $1', [bookingId]);
    if (ev.rows[0]) throw conflict('This booking already has an evaluation and cannot be moved');
    await assertNoTimeClash(c, booking.student_id, target, bookingId);

    const { rows: [moved] } = await c.query(
      'UPDATE bookings SET slot_id = $2 WHERE id = $1 RETURNING *', [bookingId, targetSlotId],
    );
    await c.query(SEAT_DECREMENT, [source.id]);
    await c.query(SEAT_INCREMENT, [target.id]);

    const examinerChanged = source.examiner_id !== target.examiner_id;
    await c.query(
      `INSERT INTO booking_events
         (booking_id, event_type, from_slot_id, to_slot_id, from_examiner_id, to_examiner_id, actor_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [bookingId, examinerChanged ? 'EXAMINER_CHANGED' : 'RESCHEDULED', source.id, target.id,
        source.examiner_id, target.examiner_id, actorId, reason || null],
    );
    await notify(c, booking.student_id, 'Your examination slot was rescheduled',
      `${target.exam_name}: moved from ${fmtSlot(source)} to ${fmtSlot(target)}.${reason ? ` Reason: ${reason}` : ''}`,
      `/student/bookings/${bookingId}`);
    return { booking: moved, from_slot_id: source.id, to_slot_id: target.id, examiner_changed: examinerChanged };
  });
  await invalidate('slots', 'exams');
  return result;
}

module.exports = { bookSlot, cancelBooking, rescheduleBooking };

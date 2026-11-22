/**
 * Row-locking helpers shared by every write path that touches seats.
 *
 * LOCK ORDER (always acquired in this order, so two transactions can never
 * wait on each other in a cycle, i.e. no deadlocks):
 *
 *     student (users row)  ->  slot(s), ascending id  ->  booking  ->  evaluation
 *
 * The examination row is taken FOR SHARE together with its slot: many bookings
 * can proceed in parallel, but an admin changing the exam's status (which takes
 * the row exclusively) waits for in-flight bookings and vice versa — so nobody
 * can book in the instant after booking is closed.
 *
 * FOR NO KEY UPDATE is used rather than FOR UPDATE because it still serialises
 * writers on the row, but does not block inserts elsewhere whose foreign keys
 * merely reference it.
 */
const { notFound, conflict } = require('../lib/errors');

const SLOT_WITH_EXAM = `
  SELECT s.id, s.exam_id, s.examiner_id, s.capacity, s.booked_count, s.available_seats, s.status,
         s.slot_date, s.start_time, s.end_time, s.meeting_link, s.venue,
         (s.slot_date + s.start_time) <= LOCALTIMESTAMP AS has_started,
         e.name AS exam_name, e.status AS exam_status, e.duration_minutes,
         e.booking_start, e.booking_end, e.results_published,
         (e.status = 'Booking Open'
            AND (e.booking_start IS NULL OR now() >= e.booking_start)
            AND (e.booking_end   IS NULL OR now() <= e.booking_end)) AS booking_window_open,
         (e.booking_end IS NULL OR now() <= e.booking_end) AS before_booking_deadline
  FROM slots s
  JOIN examinations e ON e.id = s.exam_id
  WHERE s.id = $1`;

async function lockStudent(c, studentId) {
  const { rows } = await c.query(
    "SELECT id, is_active FROM users WHERE id = $1 AND role = 'student' FOR NO KEY UPDATE",
    [studentId],
  );
  if (!rows[0]) throw notFound('Student');
  return rows[0];
}

/** Lock a slot exclusively (seat counter will change) and its exam in share mode. */
async function lockSlotForWrite(c, slotId) {
  const { rows } = await c.query(`${SLOT_WITH_EXAM} FOR NO KEY UPDATE OF s FOR SHARE OF e`, [slotId]);
  if (!rows[0]) throw notFound('Slot');
  return rows[0];
}

/** Lock a slot in share mode (we read it but do not change its seats). */
async function lockSlotForRead(c, slotId) {
  const { rows } = await c.query(`${SLOT_WITH_EXAM} FOR SHARE OF s, e`, [slotId]);
  if (!rows[0]) throw notFound('Slot');
  return rows[0];
}

/**
 * Read a booking's slot without locking, so the caller can lock in the
 * canonical order, then lock the booking and confirm it did not move meanwhile.
 */
async function peekBooking(c, bookingId) {
  const { rows } = await c.query('SELECT id, student_id, slot_id FROM bookings WHERE id = $1', [bookingId]);
  if (!rows[0]) throw notFound('Booking');
  return rows[0];
}

async function lockBooking(c, bookingId, expectedSlotId) {
  const { rows } = await c.query('SELECT * FROM bookings WHERE id = $1 FOR NO KEY UPDATE', [bookingId]);
  const b = rows[0];
  if (!b) throw notFound('Booking');
  if (expectedSlotId !== undefined && b.slot_id !== expectedSlotId) {
    throw conflict('This booking was changed by another request. Please reload and try again.');
  }
  return b;
}

module.exports = { lockStudent, lockSlotForWrite, lockSlotForRead, peekBooking, lockBooking, SLOT_WITH_EXAM };

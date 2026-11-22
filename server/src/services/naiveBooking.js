/**
 * ⚠️  DELIBERATELY WRONG — for the viva demonstration only. ⚠️
 *
 * This is the version most tutorials show. Every line looks reasonable:
 *   1. read the seat count          3. insert the booking
 *   2. check there is a seat        4. write back count + 1
 * Under concurrency, many requests read the same count at step 1, all pass
 * step 2, all insert, and all write the same "count + 1" — a lost update.
 * The slot ends up with more bookings than seats while booked_count says 1.
 *
 * It is only reachable when NAIVE_BOOKING_DEMO=true and NODE_ENV is not
 * production. Compare with services/bookings.js -> bookSlot().
 */
const { query } = require('../db');
const { conflict } = require('../lib/errors');

async function bookSlotNaive({ studentId, slotId }) {
  const { rows: [slot] } = await query('SELECT id, exam_id, capacity, booked_count FROM slots WHERE id = $1', [slotId]);
  if (slot.booked_count >= slot.capacity) throw conflict('This slot is full');
  await new Promise((r) => setTimeout(r, 20));          // any real work here widens the race window
  const { rows: [booking] } = await query(
    'INSERT INTO bookings (student_id, slot_id, exam_id) VALUES ($1, $2, $3) RETURNING *', [studentId, slotId, slot.exam_id],
  );
  await query(
    "UPDATE slots SET booked_count = $2, status = CASE WHEN $2 >= capacity THEN 'Full' ELSE 'Available' END WHERE id = $1",
    [slotId, slot.booked_count + 1],
  );
  return { booking, slot: { id: slotId, booked_count: slot.booked_count + 1 }, naive: true };
}

module.exports = { bookSlotNaive };

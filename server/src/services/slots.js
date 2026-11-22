const { withTransaction } = require('../db');
const { badRequest, conflict, forbidden, notFound } = require('../lib/errors');
const { invalidate } = require('../lib/cache');
const { notify, fmtSlot } = require('../lib/notify');
const { lockSlotForWrite } = require('./locks');

/** Compute facts about a proposed slot time, in the database's (institution's) time zone. */
async function slotTimeFacts(c, date, start, end) {
  const { rows: [f] } = await c.query(
    `SELECT ($1::date + $2::time) > LOCALTIMESTAMP AS in_future,
            EXTRACT(EPOCH FROM ($3::time - $2::time)) / 60 AS minutes,
            ($1::date + $2::time) AT TIME ZONE current_setting('TimeZone') AS starts_at`,
    [date, start, end],
  );
  return f;
}

function checkSlotTiming(facts, exam) {
  if (facts.minutes <= 0) throw badRequest('End time must be after start time');
  if (!facts.in_future) throw badRequest('The slot must start in the future');
  if (facts.minutes < exam.duration_minutes) {
    throw badRequest(`The slot must be at least ${exam.duration_minutes} minutes long (the examination duration)`);
  }
  if (exam.booking_start && new Date(facts.starts_at) <= new Date(exam.booking_start)) {
    throw badRequest('The slot must take place after booking opens for this examination');
  }
}

/** Slot edits by examiners are allowed only before student booking begins. */
function examinerCanEdit(exam, slot) {
  const bookingNotStarted = !exam.booking_start || new Date() < new Date(exam.booking_start);
  return ['Draft', 'Slot Creation'].includes(exam.status) && bookingNotStarted
    && slot.booked_count === 0 && slot.status === 'Available';
}

async function lockExamForSlotWork(c, examId, examinerId) {
  const { rows: [exam] } = await c.query(
    `SELECT e.*,
            (e.status = 'Slot Creation'
               AND (e.slot_creation_start IS NULL OR now() >= e.slot_creation_start)
               AND (e.slot_creation_end   IS NULL OR now() <= e.slot_creation_end)) AS slot_window_open,
            EXISTS (SELECT 1 FROM exam_examiners ee WHERE ee.exam_id = e.id AND ee.examiner_id = $2) AS assigned
       FROM examinations e WHERE e.id = $1 FOR SHARE`,
    [examId, examinerId],
  );
  if (!exam) throw notFound('Examination');
  if (!exam.assigned) throw forbidden('You are not assigned to this examination');
  return exam;
}

async function createSlot({ examinerId, data }) {
  const slot = await withTransaction(async (c) => {
    const exam = await lockExamForSlotWork(c, data.exam_id, examinerId);
    if (!exam.slot_window_open) throw conflict('Slot creation is not open for this examination');
    checkSlotTiming(await slotTimeFacts(c, data.slot_date, data.start_time, data.end_time), exam);

    const { rows: [s] } = await c.query(
      `INSERT INTO slots (exam_id, examiner_id, slot_date, start_time, end_time, capacity, meeting_link, venue, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [data.exam_id, examinerId, data.slot_date, data.start_time, data.end_time, data.capacity,
        data.meeting_link || null, data.venue || null, data.notes || null],
    );
    await c.query(
      `INSERT INTO slot_changes (slot_id, change_type, new_date, new_start_time, new_end_time, new_examiner_id, new_capacity, actor_id)
       VALUES ($1, 'CREATED', $2, $3, $4, $5, $6, $5)`,
      [s.id, s.slot_date, s.start_time, s.end_time, examinerId, s.capacity],
    );
    return s;
  });
  await invalidate('slots', 'exams');
  return slot;
}

async function updateSlotByExaminer({ examinerId, slotId, data }) {
  const slot = await withTransaction(async (c) => {
    const current = await lockSlotForWrite(c, slotId);
    if (current.examiner_id !== examinerId) throw notFound('Slot');
    const exam = await lockExamForSlotWork(c, current.exam_id, examinerId);
    if (!examinerCanEdit(exam, current)) {
      throw conflict('Slots can only be changed before student booking begins and while they have no bookings');
    }
    const next = { ...current, ...data };
    checkSlotTiming(await slotTimeFacts(c, next.slot_date, next.start_time, next.end_time), exam);

    const { rows: [s] } = await c.query(
      `UPDATE slots SET slot_date = $2, start_time = $3, end_time = $4, capacity = $5,
              meeting_link = $6, venue = $7, notes = COALESCE($8, notes)
        WHERE id = $1 RETURNING *`,
      [slotId, next.slot_date, next.start_time, next.end_time, next.capacity,
        next.meeting_link ?? null, next.venue ?? null, data.notes ?? null],
    );
    await c.query(
      `INSERT INTO slot_changes (slot_id, change_type, old_date, new_date, old_start_time, new_start_time,
                                 old_end_time, new_end_time, old_capacity, new_capacity, actor_id)
       VALUES ($1, 'UPDATED', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [slotId, current.slot_date, s.slot_date, current.start_time, s.start_time,
        current.end_time, s.end_time, current.capacity, s.capacity, examinerId],
    );
    return s;
  });
  await invalidate('slots', 'exams');
  return slot;
}

async function deleteSlotByExaminer({ examinerId, slotId }) {
  await withTransaction(async (c) => {
    const current = await lockSlotForWrite(c, slotId);
    if (current.examiner_id !== examinerId) throw notFound('Slot');
    const exam = await lockExamForSlotWork(c, current.exam_id, examinerId);
    if (!examinerCanEdit(exam, current)) {
      throw conflict('Slots can only be removed before student booking begins and while they have no bookings');
    }
    const anyBooking = await c.query('SELECT 1 FROM bookings WHERE slot_id = $1 LIMIT 1', [slotId]);
    if (anyBooking.rows[0]) throw conflict('This slot has booking history and cannot be removed');
    await c.query('DELETE FROM slots WHERE id = $1', [slotId]);
  });
  await invalidate('slots', 'exams');
}

/** Admin: reschedule a slot (date/time/capacity/venue) in exceptional situations. */
async function adminUpdateSlot({ actorId, slotId, data }) {
  const { reason, ...changes } = data;
  const result = await withTransaction(async (c) => {
    const current = await lockSlotForWrite(c, slotId);
    if (['Cancelled', 'Completed'].includes(current.status)) throw conflict(`A ${current.status.toLowerCase()} slot cannot be changed`);
    const next = { ...current, ...changes };
    if (next.capacity < current.booked_count) {
      throw conflict(`Capacity cannot be lower than the ${current.booked_count} seats already booked`);
    }
    const timeChanged = next.slot_date !== current.slot_date
      || next.start_time.slice(0, 5) !== current.start_time.slice(0, 5)
      || next.end_time.slice(0, 5) !== current.end_time.slice(0, 5);
    if (timeChanged) {
      const facts = await slotTimeFacts(c, next.slot_date, next.start_time, next.end_time);
      if (facts.minutes <= 0) throw badRequest('End time must be after start time');
      if (!facts.in_future) throw badRequest('The new time must be in the future');
      if (facts.minutes < current.duration_minutes) throw badRequest(`The slot must be at least ${current.duration_minutes} minutes long`);
    }
    const status = current.booked_count >= next.capacity ? 'Full' : 'Available';
    const { rows: [s] } = await c.query(
      `UPDATE slots SET slot_date = $2, start_time = $3, end_time = $4, capacity = $5, status = $6,
              meeting_link = $7, venue = $8
        WHERE id = $1 RETURNING *`,
      [slotId, next.slot_date, next.start_time, next.end_time, next.capacity, status,
        next.meeting_link ?? null, next.venue ?? null],
    );
    await c.query(
      `INSERT INTO slot_changes (slot_id, change_type, old_date, new_date, old_start_time, new_start_time,
                                 old_end_time, new_end_time, old_capacity, new_capacity, actor_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [slotId, timeChanged ? 'RESCHEDULED' : 'UPDATED', current.slot_date, s.slot_date, current.start_time,
        s.start_time, current.end_time, s.end_time, current.capacity, s.capacity, actorId, reason || null],
    );
    if (timeChanged) {
      const { rows: affected } = await c.query(
        "SELECT id, student_id FROM bookings WHERE slot_id = $1 AND status = 'Booked'", [slotId],
      );
      for (const b of affected) {
        await c.query(
          `INSERT INTO booking_events (booking_id, event_type, from_slot_id, to_slot_id, actor_id, reason)
           VALUES ($1, 'RESCHEDULED', $2, $2, $3, $4)`,
          [b.id, slotId, actorId, reason || 'Slot time changed by admin'],
        );
        await notify(c, b.student_id, 'Examination slot time changed',
          `${current.exam_name}: now on ${fmtSlot(s)} (was ${fmtSlot(current)}).`, `/student/bookings/${b.id}`);
      }
      await notify(c, s.examiner_id, 'Your slot was rescheduled',
        `${current.exam_name}: now on ${fmtSlot(s)} (was ${fmtSlot(current)}).`, '/examiner/slots');
    }
    return s;
  });
  await invalidate('slots', 'exams');
  return result;
}

/** Admin: hand a whole slot (and its booked students) to a different examiner. */
async function changeSlotExaminer({ actorId, slotId, examinerId, reason }) {
  const result = await withTransaction(async (c) => {
    const slot = await lockSlotForWrite(c, slotId);
    if (['Cancelled', 'Completed'].includes(slot.status)) throw conflict(`A ${slot.status.toLowerCase()} slot cannot be reassigned`);
    if (slot.examiner_id === examinerId) throw badRequest('This examiner already owns the slot');
    const { rows: [ex] } = await c.query(
      `SELECT u.id, u.full_name FROM users u JOIN examiner_profiles p ON p.user_id = u.id
        WHERE u.id = $1 AND u.role = 'examiner' AND u.is_active AND p.status = 'Active'`,
      [examinerId],
    );
    if (!ex) throw badRequest('The new examiner does not exist or is not active');
    const evals = await c.query(
      "SELECT 1 FROM evaluations ev JOIN bookings b ON b.id = ev.booking_id WHERE b.slot_id = $1 AND b.status <> 'Cancelled' LIMIT 1",
      [slotId],
    );
    if (evals.rows[0]) throw conflict('Students in this slot have already been evaluated; move individual bookings instead');

    await c.query(
      'INSERT INTO exam_examiners (exam_id, examiner_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [slot.exam_id, examinerId],
    );
    const { rows: [s] } = await c.query('UPDATE slots SET examiner_id = $2 WHERE id = $1 RETURNING *', [slotId, examinerId]);
    await c.query(
      `INSERT INTO slot_changes (slot_id, change_type, old_examiner_id, new_examiner_id, actor_id, reason)
       VALUES ($1, 'EXAMINER_CHANGED', $2, $3, $4, $5)`,
      [slotId, slot.examiner_id, examinerId, actorId, reason || null],
    );
    const { rows: affected } = await c.query(
      "SELECT id, student_id FROM bookings WHERE slot_id = $1 AND status = 'Booked'", [slotId],
    );
    for (const b of affected) {
      await c.query(
        `INSERT INTO booking_events (booking_id, event_type, from_slot_id, to_slot_id, from_examiner_id, to_examiner_id, actor_id, reason)
         VALUES ($1, 'EXAMINER_CHANGED', $2, $2, $3, $4, $5, $6)`,
        [b.id, slotId, slot.examiner_id, examinerId, actorId, reason || null],
      );
      await notify(c, b.student_id, 'Your examiner has changed',
        `${slot.exam_name} on ${fmtSlot(slot)} will now be conducted by ${ex.full_name}.`, `/student/bookings/${b.id}`);
    }
    await notify(c, examinerId, 'New slot assigned to you', `${slot.exam_name} on ${fmtSlot(slot)} (${affected.length} students booked).`, '/examiner/slots');
    await notify(c, slot.examiner_id, 'Slot reassigned', `${slot.exam_name} on ${fmtSlot(slot)} has been reassigned to ${ex.full_name}.`, '/examiner/slots');
    return { slot: s, students_notified: affected.length };
  });
  await invalidate('slots', 'exams');
  return result;
}

async function adminCancelSlot({ actorId, slotId, reason }) {
  const result = await withTransaction(async (c) => {
    const slot = await lockSlotForWrite(c, slotId);
    if (slot.status === 'Cancelled') throw conflict('The slot is already cancelled');
    if (slot.status === 'Completed') throw conflict('A completed slot cannot be cancelled');
    if (slot.booked_count > 0) {
      throw conflict(`Move or cancel the ${slot.booked_count} active booking(s) in this slot first`);
    }
    const { rows: [s] } = await c.query("UPDATE slots SET status = 'Cancelled' WHERE id = $1 RETURNING *", [slotId]);
    await c.query(
      "INSERT INTO slot_changes (slot_id, change_type, actor_id, reason) VALUES ($1, 'CANCELLED', $2, $3)",
      [slotId, actorId, reason || null],
    );
    await notify(c, slot.examiner_id, 'Slot cancelled', `${slot.exam_name} on ${fmtSlot(slot)} was cancelled by the admin.`, '/examiner/slots');
    return s;
  });
  await invalidate('slots', 'exams');
  return result;
}

/** Examiner: mark one slot completed once every booked student has been evaluated or marked absent. */
async function completeSlot({ examinerId, slotId }) {
  const result = await withTransaction(async (c) => {
    const slot = await lockSlotForWrite(c, slotId);
    if (slot.examiner_id !== examinerId) throw notFound('Slot');
    if (slot.status === 'Completed') throw conflict('The slot is already completed');
    if (slot.status === 'Cancelled') throw conflict('A cancelled slot cannot be completed');
    if (!slot.has_started) throw conflict('The slot has not started yet');
    const { rows: [p] } = await c.query(
      "SELECT count(*)::int AS pending FROM bookings WHERE slot_id = $1 AND status = 'Booked'", [slotId],
    );
    if (p.pending > 0) throw conflict(`${p.pending} student(s) in this slot still need to be evaluated or marked absent`);
    const { rows: [s] } = await c.query("UPDATE slots SET status = 'Completed' WHERE id = $1 RETURNING *", [slotId]);
    await c.query(
      "INSERT INTO slot_changes (slot_id, change_type, actor_id) VALUES ($1, 'COMPLETED', $2)", [slotId, examinerId],
    );
    return s;
  });
  await invalidate('slots', 'exams');
  return result;
}

module.exports = {
  createSlot, updateSlotByExaminer, deleteSlotByExaminer, adminUpdateSlot, changeSlotExaminer,
  adminCancelSlot, completeSlot, examinerCanEdit,
};

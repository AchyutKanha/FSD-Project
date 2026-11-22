const { withTransaction } = require('../db');
const config = require('../config');
const { badRequest, conflict, forbidden } = require('../lib/errors');
const { invalidate } = require('../lib/cache');
const { lockSlotForRead, peekBooking, lockBooking } = require('./locks');

/**
 * Weighted total, scaled to the exam's maximum marks:
 *   total = max_marks * Σ (marks_i / criterion_max_i * weightage_i) / Σ weightage_i
 * Booking can only open once weightages sum to exactly 100.
 */
function computeTotal(criteria, scoreMap, examMaxMarks) {
  const totalWeight = criteria.reduce((s, c) => s + Number(c.weightage), 0);
  if (!totalWeight) return 0;
  const weighted = criteria.reduce((s, c) => {
    const m = scoreMap.get(c.id);
    return s + ((m ? m.marks : 0) / Number(c.max_marks)) * Number(c.weightage);
  }, 0);
  return Math.round((weighted / totalWeight) * Number(examMaxMarks) * 100) / 100;
}

/** Lock order: slot (share) -> booking -> evaluation. Validates the examiner owns the slot. */
async function lockForEvaluation(c, examinerId, bookingId) {
  const pre = await peekBooking(c, bookingId);
  const slot = await lockSlotForRead(c, pre.slot_id);
  const booking = await lockBooking(c, bookingId, pre.slot_id);
  if (slot.examiner_id !== examinerId) throw forbidden('You can evaluate only students booked into your own slots');
  if (booking.status === 'Cancelled') throw conflict('This booking was cancelled');
  if (slot.results_published) throw conflict('Results for this examination are published; evaluations are locked');
  if (!['Booking Open', 'Closed', 'Completed'].includes(slot.exam_status)) {
    throw conflict(`Evaluations are not possible while the examination is in "${slot.exam_status}"`);
  }
  if (!slot.has_started && !config.allowEarlyEvaluation) {
    throw conflict('You can evaluate a student only after their slot has started');
  }
  const { rows: [existing] } = await c.query('SELECT * FROM evaluations WHERE booking_id = $1 FOR NO KEY UPDATE', [bookingId]);
  return { slot, booking, existing };
}

async function writeVersion(c, evaluation, actorId, scoreRows) {
  const { rows: [v] } = await c.query(
    `INSERT INTO evaluation_versions (evaluation_id, version, status, total_marks, remarks, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [evaluation.id, evaluation.version, evaluation.status, evaluation.total_marks, evaluation.remarks, actorId],
  );
  if (scoreRows.length) {
    await c.query(
      `INSERT INTO evaluation_version_scores (version_id, criterion_id, marks, comment)
       SELECT $1, * FROM unnest($2::bigint[], $3::numeric[], $4::text[])`,
      [v.id, scoreRows.map((s) => s.criterion_id), scoreRows.map((s) => s.marks), scoreRows.map((s) => s.comment ?? null)],
    );
  }
}

async function upsertEvaluation(c, { existing, booking, slot, examinerId, total, remarks, status, expectedVersion }) {
  if (existing) {
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw conflict('This evaluation was changed since you opened it. Reload to see the latest version.', { current_version: existing.version });
    }
    if (existing.status !== 'Draft' && status === 'Draft') {
      throw conflict('A submitted evaluation cannot be turned back into a draft; submit your changes instead');
    }
    const { rows: [ev] } = await c.query(
      `UPDATE evaluations
          SET total_marks = $2, remarks = $3, status = $4, examiner_id = $5, version = version + 1,
              evaluated_at = CASE WHEN $4 = 'Draft' THEN evaluated_at ELSE now() END
        WHERE id = $1 RETURNING *`,
      [existing.id, total, remarks, status, examinerId],
    );
    return ev;
  }
  const { rows: [ev] } = await c.query(
    `INSERT INTO evaluations (booking_id, exam_id, student_id, examiner_id, total_marks, remarks, status, evaluated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 = 'Draft' THEN NULL ELSE now() END) RETURNING *`,
    [booking.id, slot.exam_id, booking.student_id, examinerId, total, remarks, status],
  );
  return ev;
}

async function saveEvaluation({ examinerId, bookingId, scores, remarks, submit, expectedVersion }) {
  const result = await withTransaction(async (c) => {
    const { slot, booking, existing } = await lockForEvaluation(c, examinerId, bookingId);
    const { rows: criteria } = await c.query(
      'SELECT id, criterion_name, max_marks, weightage FROM rubric_criteria WHERE exam_id = $1 ORDER BY position, id',
      [slot.exam_id],
    );
    if (!criteria.length) throw conflict('This examination has no rubric yet');

    const byId = new Map(criteria.map((cr) => [cr.id, cr]));
    const scoreMap = new Map();
    const errors = [];
    scores.forEach((s, i) => {
      const cr = byId.get(s.criterion_id);
      if (!cr) errors.push({ field: `scores.${i}.criterion_id`, message: 'Not a criterion of this examination' });
      else if (scoreMap.has(s.criterion_id)) errors.push({ field: `scores.${i}.criterion_id`, message: 'Criterion scored twice' });
      else if (s.marks > Number(cr.max_marks)) errors.push({ field: `scores.${i}.marks`, message: `At most ${cr.max_marks} for "${cr.criterion_name}"` });
      else scoreMap.set(s.criterion_id, s);
    });
    if (submit) {
      for (const cr of criteria) {
        if (!scoreMap.has(cr.id)) errors.push({ field: `criterion.${cr.id}`, message: `"${cr.criterion_name}" must be scored before submitting` });
      }
    }
    if (errors.length) throw badRequest('Evaluation is invalid', errors);

    const total = computeTotal(criteria, scoreMap, (await c.query('SELECT max_marks FROM examinations WHERE id = $1', [slot.exam_id])).rows[0].max_marks);
    const status = submit ? 'Submitted' : 'Draft';
    const ev = await upsertEvaluation(c, { existing, booking, slot, examinerId, total, remarks: remarks ?? null, status, expectedVersion });

    const scoreRows = [...scoreMap.values()];
    await c.query('DELETE FROM evaluation_scores WHERE evaluation_id = $1', [ev.id]);
    if (scoreRows.length) {
      await c.query(
        `INSERT INTO evaluation_scores (evaluation_id, criterion_id, marks, comment)
         SELECT $1, * FROM unnest($2::bigint[], $3::numeric[], $4::text[])`,
        [ev.id, scoreRows.map((s) => s.criterion_id), scoreRows.map((s) => s.marks), scoreRows.map((s) => s.comment ?? null)],
      );
    }
    await writeVersion(c, ev, examinerId, scoreRows);

    if (submit) {
      await c.query("UPDATE bookings SET status = 'Completed', attendance = 'Present' WHERE id = $1", [bookingId]);
      await c.query(
        "INSERT INTO booking_events (booking_id, event_type, from_slot_id, actor_id) VALUES ($1, 'EVALUATED', $2, $3)",
        [bookingId, slot.id, examinerId],
      );
    }
    return { ...ev, scores: scoreRows };
  });
  await invalidate('exams');
  return result;
}

async function markAbsent({ examinerId, bookingId, remarks, expectedVersion }) {
  const result = await withTransaction(async (c) => {
    const { slot, booking, existing } = await lockForEvaluation(c, examinerId, bookingId);
    const ev = await upsertEvaluation(c, {
      existing, booking, slot, examinerId, total: 0, remarks: remarks || 'Absent', status: 'Absent', expectedVersion,
    });
    await c.query('DELETE FROM evaluation_scores WHERE evaluation_id = $1', [ev.id]);
    await writeVersion(c, ev, examinerId, []);
    await c.query("UPDATE bookings SET status = 'Completed', attendance = 'Absent' WHERE id = $1", [bookingId]);
    await c.query(
      "INSERT INTO booking_events (booking_id, event_type, from_slot_id, actor_id) VALUES ($1, 'MARKED_ABSENT', $2, $3)",
      [bookingId, slot.id, examinerId],
    );
    return ev;
  });
  await invalidate('exams');
  return result;
}

module.exports = { computeTotal, saveEvaluation, markAbsent };

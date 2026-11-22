const express = require('express');
const { query, withTransaction } = require('../db');
const { validate } = require('../middleware/validate');
const { notFound, conflict } = require('../lib/errors');
const { invalidate } = require('../lib/cache');
const {
  z, id, idParam, isoDate, hhmm, httpUrl, optionalText, pageQuery, paginate, whereBuilder, likeTerm,
} = require('../lib/http');
const slotsSvc = require('../services/slots');
const evalSvc = require('../services/evaluations');

const router = express.Router();

const PENDING_SQL = "b.status = 'Booked' AND (ev.id IS NULL OR ev.status = 'Draft')";

// ---------------------------------------------------------------- dashboard
router.get('/dashboard', async (req, res) => {
  const xid = req.user.id;
  const [counts, exams, pending, today] = await Promise.all([
    query(
      `SELECT
         (SELECT count(*)::int FROM exam_examiners WHERE examiner_id = $1) AS assigned_exams,
         (SELECT count(*)::int FROM slots WHERE examiner_id = $1 AND status <> 'Cancelled') AS slots_created,
         (SELECT count(*)::int FROM slots WHERE examiner_id = $1 AND status IN ('Available','Full')
             AND (slot_date + end_time) >= LOCALTIMESTAMP) AS upcoming_slots,
         (SELECT count(*)::int FROM bookings b JOIN slots s ON s.id = b.slot_id
           WHERE s.examiner_id = $1 AND b.status <> 'Cancelled') AS booked_students,
         (SELECT count(*)::int FROM bookings b JOIN slots s ON s.id = b.slot_id
            LEFT JOIN evaluations ev ON ev.booking_id = b.id
           WHERE s.examiner_id = $1 AND ${PENDING_SQL} AND (s.slot_date + s.start_time) <= LOCALTIMESTAMP) AS pending_evaluations`,
      [xid],
    ),
    query(
      `SELECT e.id, e.name, e.exam_type, e.status, c.code AS course_code, c.name AS course_name,
              e.slot_creation_end, e.booking_start,
              (SELECT count(*)::int FROM slots s WHERE s.exam_id = e.id AND s.examiner_id = $1 AND s.status <> 'Cancelled') AS my_slots
         FROM exam_examiners ee JOIN examinations e ON e.id = ee.exam_id JOIN courses c ON c.id = e.course_id
        WHERE ee.examiner_id = $1 AND e.status <> 'Completed'
        ORDER BY CASE e.status WHEN 'Slot Creation' THEN 0 WHEN 'Booking Open' THEN 1 WHEN 'Closed' THEN 2 ELSE 3 END, e.id DESC
        LIMIT 8`,
      [xid],
    ),
    query(
      `SELECT b.id AS booking_id, u.full_name AS student_name, sp.roll_number, e.name AS exam_name,
              s.slot_date, s.start_time, ev.status AS evaluation_status
         FROM bookings b JOIN slots s ON s.id = b.slot_id JOIN examinations e ON e.id = b.exam_id
         JOIN users u ON u.id = b.student_id JOIN student_profiles sp ON sp.user_id = u.id
         LEFT JOIN evaluations ev ON ev.booking_id = b.id
        WHERE s.examiner_id = $1 AND ${PENDING_SQL} AND (s.slot_date + s.start_time) <= LOCALTIMESTAMP
        ORDER BY s.slot_date, s.start_time LIMIT 10`,
      [xid],
    ),
    query(
      `SELECT s.id, s.slot_date, s.start_time, s.end_time, s.booked_count, s.capacity, s.venue, s.meeting_link, e.name AS exam_name
         FROM slots s JOIN examinations e ON e.id = s.exam_id
        WHERE s.examiner_id = $1 AND s.status IN ('Available','Full') AND s.slot_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
        ORDER BY s.slot_date, s.start_time LIMIT 10`,
      [xid],
    ),
  ]);
  res.json({ counts: counts.rows[0], exams: exams.rows, pending: pending.rows, upcoming_slots: today.rows });
});

// ---------------------------------------------------------------- assigned exams
router.get('/exams', validate({ query: z.object({ ...pageQuery, status: z.string().optional() }) }), async (req, res) => {
  const qp = req.valid.query;
  const w = whereBuilder();
  w.add('ee.examiner_id = ?', req.user.id);
  if (qp.status) w.add('e.status = ?', qp.status);
  if (qp.q) w.add('(e.name ILIKE ? OR c.code ILIKE ? OR c.name ILIKE ?)', likeTerm(qp.q), likeTerm(qp.q), likeTerm(qp.q));
  const xidParam = `$${w.params.length + 1}`;
  // the examiner id is appended as the last param for the per-exam sub-queries
  const params = [...w.params, req.user.id];
  const result = await paginate({ query }, {
    listSql: `
      SELECT e.id, e.name, e.exam_type, e.status, e.duration_minutes, e.max_marks,
             e.slot_creation_start, e.slot_creation_end, e.booking_start, e.booking_end, e.results_published,
             c.code AS course_code, c.name AS course_name,
             (e.status = 'Slot Creation' AND (e.slot_creation_start IS NULL OR now() >= e.slot_creation_start)
                AND (e.slot_creation_end IS NULL OR now() <= e.slot_creation_end)) AS slot_creation_open,
             (SELECT count(*)::int FROM slots s WHERE s.exam_id = e.id AND s.examiner_id = ${xidParam} AND s.status <> 'Cancelled') AS my_slots,
             (SELECT count(*)::int FROM bookings b JOIN slots s ON s.id = b.slot_id
                WHERE s.exam_id = e.id AND s.examiner_id = ${xidParam} AND b.status <> 'Cancelled') AS my_bookings,
             (SELECT count(*)::int FROM bookings b JOIN slots s ON s.id = b.slot_id LEFT JOIN evaluations ev ON ev.booking_id = b.id
                WHERE s.exam_id = e.id AND s.examiner_id = ${xidParam} AND ${PENDING_SQL}) AS my_pending
        FROM exam_examiners ee JOIN examinations e ON e.id = ee.exam_id JOIN courses c ON c.id = e.course_id
        ${w.sql()}
       ORDER BY CASE e.status WHEN 'Slot Creation' THEN 0 WHEN 'Booking Open' THEN 1 WHEN 'Closed' THEN 2 WHEN 'Draft' THEN 3 ELSE 4 END, e.id DESC`,
    countSql: `SELECT count(*)::int AS total FROM exam_examiners ee JOIN examinations e ON e.id = ee.exam_id
                 JOIN courses c ON c.id = e.course_id ${w.sql()} AND $${params.length}::bigint IS NOT NULL`,
    params,
    page: qp.page,
    perPage: qp.per_page,
  });
  res.json(result);
});

router.get('/exams/:id', validate({ params: idParam }), async (req, res) => {
  const { rows: [exam] } = await query(
    `SELECT e.*, c.code AS course_code, c.name AS course_name,
            (e.status = 'Slot Creation' AND (e.slot_creation_start IS NULL OR now() >= e.slot_creation_start)
               AND (e.slot_creation_end IS NULL OR now() <= e.slot_creation_end)) AS slot_creation_open
       FROM examinations e JOIN courses c ON c.id = e.course_id
       JOIN exam_examiners ee ON ee.exam_id = e.id AND ee.examiner_id = $2
      WHERE e.id = $1`,
    [req.valid.params.id, req.user.id],
  );
  if (!exam) throw notFound('Examination');
  const [rubric, slots] = await Promise.all([
    query('SELECT * FROM rubric_criteria WHERE exam_id = $1 ORDER BY position, id', [exam.id]),
    query(
      `SELECT s.*, (s.slot_date + s.start_time) <= LOCALTIMESTAMP AS has_started
         FROM slots s WHERE s.exam_id = $1 AND s.examiner_id = $2 ORDER BY s.slot_date, s.start_time`,
      [exam.id, req.user.id],
    ),
  ]);
  const editable = slots.rows.map((s) => ({ ...s, editable: slotsSvc.examinerCanEdit(exam, s) }));
  res.json({ exam, rubric: rubric.rows, slots: editable });
});

router.post('/exams/:id/complete', validate({ params: idParam }), async (req, res) => {
  const examId = req.valid.params.id;
  const result = await withTransaction(async (c) => {
    const { rows: [exam] } = await c.query(
      `SELECT e.* FROM examinations e JOIN exam_examiners ee ON ee.exam_id = e.id AND ee.examiner_id = $2
        WHERE e.id = $1 FOR NO KEY UPDATE OF e`,
      [examId, req.user.id],
    );
    if (!exam) throw notFound('Examination');
    if (exam.status !== 'Closed') throw conflict('Booking must be closed by the admin before the examination can be completed');
    const { rows: mine } = await c.query(
      `SELECT id FROM slots WHERE exam_id = $1 AND examiner_id = $2 AND status IN ('Available', 'Full')
        ORDER BY id FOR NO KEY UPDATE`,
      [examId, req.user.id],
    );
    const { rows: [p] } = await c.query(
      `SELECT count(*)::int AS pending FROM bookings b JOIN slots s ON s.id = b.slot_id
        WHERE s.exam_id = $1 AND s.examiner_id = $2 AND b.status = 'Booked'`,
      [examId, req.user.id],
    );
    if (p.pending > 0) throw conflict(`${p.pending} of your students still need to be evaluated or marked absent`);
    for (const s of mine) {
      await c.query("UPDATE slots SET status = 'Completed' WHERE id = $1", [s.id]);
      await c.query("INSERT INTO slot_changes (slot_id, change_type, actor_id) VALUES ($1, 'COMPLETED', $2)", [s.id, req.user.id]);
    }
    // When every examiner has finished, the examination itself becomes Completed.
    const { rows: [left] } = await c.query(
      "SELECT count(*)::int AS open_slots FROM slots WHERE exam_id = $1 AND status IN ('Available', 'Full')", [examId],
    );
    let examCompleted = false;
    if (left.open_slots === 0) {
      const { rows: [pp] } = await c.query("SELECT count(*)::int AS n FROM bookings WHERE exam_id = $1 AND status = 'Booked'", [examId]);
      if (pp.n === 0) {
        await c.query("UPDATE examinations SET status = 'Completed' WHERE id = $1", [examId]);
        await c.query(
          "INSERT INTO exam_status_history (exam_id, from_status, to_status, actor_id, note) VALUES ($1, 'Closed', 'Completed', $2, 'All examiners finished')",
          [examId, req.user.id],
        );
        examCompleted = true;
      }
    }
    return { slots_completed: mine.length, exam_completed: examCompleted };
  });
  await invalidate('exams', 'slots');
  res.json(result);
});

// ---------------------------------------------------------------- slots
const slotBody = z.object({
  exam_id: id,
  slot_date: isoDate,
  start_time: hhmm,
  end_time: hhmm,
  capacity: z.coerce.number().int().min(1).max(200),
  meeting_link: httpUrl.optional().nullable().or(z.literal('').transform(() => null)),
  venue: optionalText(200),
  notes: optionalText(1000),
}).strict().refine((s) => s.end_time > s.start_time, { message: 'End time must be after start time', path: ['end_time'] });

const slotUpdateBody = z.object({
  slot_date: isoDate.optional(),
  start_time: hhmm.optional(),
  end_time: hhmm.optional(),
  capacity: z.coerce.number().int().min(1).max(200).optional(),
  meeting_link: httpUrl.optional().nullable().or(z.literal('').transform(() => null)),
  venue: optionalText(200),
  notes: optionalText(1000),
}).strict();

router.get('/slots', validate({
  query: z.object({ ...pageQuery, exam_id: id.optional(), status: z.enum(['Available', 'Full', 'Cancelled', 'Completed']).optional(), upcoming: z.enum(['true', 'false']).optional() }),
}), async (req, res) => {
  const qp = req.valid.query;
  const w = whereBuilder();
  w.add('s.examiner_id = ?', req.user.id);
  if (qp.exam_id) w.add('s.exam_id = ?', qp.exam_id);
  if (qp.status) w.add('s.status = ?', qp.status);
  if (qp.upcoming === 'true') w.add('(s.slot_date + s.end_time) >= LOCALTIMESTAMP');
  if (qp.q) w.add('(e.name ILIKE ? OR c.code ILIKE ?)', likeTerm(qp.q), likeTerm(qp.q));
  const result = await paginate({ query }, {
    listSql: `SELECT s.*, e.name AS exam_name, e.status AS exam_status, c.code AS course_code,
                     (s.slot_date + s.start_time) <= LOCALTIMESTAMP AS has_started
                FROM slots s JOIN examinations e ON e.id = s.exam_id JOIN courses c ON c.id = e.course_id
                ${w.sql()} ORDER BY s.slot_date DESC, s.start_time`,
    countSql: `SELECT count(*)::int AS total FROM slots s JOIN examinations e ON e.id = s.exam_id JOIN courses c ON c.id = e.course_id ${w.sql()}`,
    params: w.params,
    page: qp.page,
    perPage: qp.per_page,
  });
  res.json(result);
});

router.post('/slots', validate({ body: slotBody }), async (req, res) => {
  res.status(201).json({ slot: await slotsSvc.createSlot({ examinerId: req.user.id, data: req.valid.body }) });
});

router.put('/slots/:id', validate({ params: idParam, body: slotUpdateBody }), async (req, res) => {
  const slot = await slotsSvc.updateSlotByExaminer({ examinerId: req.user.id, slotId: req.valid.params.id, data: req.valid.body });
  res.json({ slot });
});

router.delete('/slots/:id', validate({ params: idParam }), async (req, res) => {
  await slotsSvc.deleteSlotByExaminer({ examinerId: req.user.id, slotId: req.valid.params.id });
  res.status(204).end();
});

router.post('/slots/:id/complete', validate({ params: idParam }), async (req, res) => {
  res.json({ slot: await slotsSvc.completeSlot({ examinerId: req.user.id, slotId: req.valid.params.id }) });
});

router.get('/slots/:id/bookings', validate({ params: idParam }), async (req, res) => {
  const { rows: [slot] } = await query(
    `SELECT s.*, e.name AS exam_name, (s.slot_date + s.start_time) <= LOCALTIMESTAMP AS has_started
       FROM slots s JOIN examinations e ON e.id = s.exam_id WHERE s.id = $1 AND s.examiner_id = $2`,
    [req.valid.params.id, req.user.id],
  );
  if (!slot) throw notFound('Slot');
  const { rows } = await query(
    `SELECT b.id, b.status, b.attendance, b.booked_at, u.id AS student_id, u.full_name AS student_name, u.email,
            sp.roll_number, sp.department, ev.status AS evaluation_status, ev.total_marks
       FROM bookings b JOIN users u ON u.id = b.student_id JOIN student_profiles sp ON sp.user_id = u.id
       LEFT JOIN evaluations ev ON ev.booking_id = b.id
      WHERE b.slot_id = $1 AND b.status <> 'Cancelled' ORDER BY b.booked_at`,
    [slot.id],
  );
  res.json({ slot, bookings: rows });
});

// ---------------------------------------------------------------- booked students & evaluation
router.get('/bookings', validate({
  query: z.object({ ...pageQuery, exam_id: id.optional(), evaluation: z.enum(['pending', 'done']).optional() }),
}), async (req, res) => {
  const qp = req.valid.query;
  const w = whereBuilder();
  w.add('s.examiner_id = ?', req.user.id).add("b.status <> 'Cancelled'");
  if (qp.exam_id) w.add('b.exam_id = ?', qp.exam_id);
  // "pending" = the slot has started and the student still needs marks (what the examiner can act on now)
  if (qp.evaluation === 'pending') w.add(`${PENDING_SQL} AND (s.slot_date + s.start_time) <= LOCALTIMESTAMP`);
  if (qp.evaluation === 'done') w.add("ev.status IN ('Submitted', 'Absent')");
  if (qp.q) w.add('(u.full_name ILIKE ? OR sp.roll_number ILIKE ? OR u.email ILIKE ?)', likeTerm(qp.q), likeTerm(qp.q), likeTerm(qp.q));
  const from = `FROM bookings b JOIN slots s ON s.id = b.slot_id JOIN examinations e ON e.id = b.exam_id
                JOIN courses c ON c.id = e.course_id JOIN users u ON u.id = b.student_id
                JOIN student_profiles sp ON sp.user_id = u.id LEFT JOIN evaluations ev ON ev.booking_id = b.id`;
  const result = await paginate({ query }, {
    listSql: `SELECT b.id, b.status, b.attendance, u.full_name AS student_name, sp.roll_number, u.email,
                     e.id AS exam_id, e.name AS exam_name, c.code AS course_code, e.results_published,
                     s.id AS slot_id, s.slot_date, s.start_time, s.end_time,
                     (s.slot_date + s.start_time) <= LOCALTIMESTAMP AS has_started,
                     ev.status AS evaluation_status, ev.total_marks, e.max_marks
                ${from} ${w.sql()}
               ORDER BY ${qp.evaluation === 'pending' ? 's.slot_date, s.start_time' : 's.slot_date DESC, s.start_time'}, u.full_name`,
    countSql: `SELECT count(*)::int AS total ${from} ${w.sql()}`,
    params: w.params,
    page: qp.page,
    perPage: qp.per_page,
  });
  res.json(result);
});

router.get('/bookings/:id/evaluation', validate({ params: idParam }), async (req, res) => {
  const { rows: [b] } = await query(
    `SELECT b.id, b.status, b.attendance, b.exam_id, u.id AS student_id, u.full_name AS student_name, u.email,
            sp.roll_number, sp.department, sp.program, e.name AS exam_name, e.exam_type, e.max_marks, e.pass_marks,
            e.results_published, e.status AS exam_status, c.code AS course_code,
            s.id AS slot_id, s.slot_date, s.start_time, s.end_time, s.examiner_id,
            (s.slot_date + s.start_time) <= LOCALTIMESTAMP AS has_started
       FROM bookings b JOIN slots s ON s.id = b.slot_id JOIN examinations e ON e.id = b.exam_id
       JOIN courses c ON c.id = e.course_id JOIN users u ON u.id = b.student_id
       JOIN student_profiles sp ON sp.user_id = u.id
      WHERE b.id = $1 AND s.examiner_id = $2`,
    [req.valid.params.id, req.user.id],
  );
  if (!b) throw notFound('Booking');
  const [rubric, ev] = await Promise.all([
    query('SELECT id, criterion_name, max_marks, weightage, description FROM rubric_criteria WHERE exam_id = $1 ORDER BY position, id', [b.exam_id]),
    query('SELECT * FROM evaluations WHERE booking_id = $1', [b.id]),
  ]);
  const evaluation = ev.rows[0] || null;
  let scores = [];
  let versions = [];
  if (evaluation) {
    scores = (await query('SELECT criterion_id, marks, comment FROM evaluation_scores WHERE evaluation_id = $1', [evaluation.id])).rows;
    versions = (await query(
      `SELECT v.version, v.status, v.total_marks, v.remarks, v.created_at, u.full_name AS actor_name
         FROM evaluation_versions v LEFT JOIN users u ON u.id = v.actor_id
        WHERE v.evaluation_id = $1 ORDER BY v.version DESC`,
      [evaluation.id],
    )).rows;
  }
  res.json({ booking: b, rubric: rubric.rows, evaluation, scores, versions });
});

const evaluationBody = z.object({
  scores: z.array(z.object({
    criterion_id: id,
    marks: z.coerce.number().min(0).max(1000),
    comment: optionalText(1000),
  }).strict()).max(50),
  remarks: optionalText(4000),
  submit: z.boolean(),
  expected_version: z.number().int().min(1).optional(),
}).strict();

router.put('/bookings/:id/evaluation', validate({ params: idParam, body: evaluationBody }), async (req, res) => {
  const b = req.valid.body;
  const evaluation = await evalSvc.saveEvaluation({
    examinerId: req.user.id,
    bookingId: req.valid.params.id,
    scores: b.scores,
    remarks: b.remarks,
    submit: b.submit,
    expectedVersion: b.expected_version,
  });
  res.json({ evaluation });
});

router.post('/bookings/:id/absent', validate({
  params: idParam,
  body: z.object({ remarks: optionalText(1000), expected_version: z.number().int().min(1).optional() }).strict(),
}), async (req, res) => {
  const evaluation = await evalSvc.markAbsent({
    examinerId: req.user.id, bookingId: req.valid.params.id, remarks: req.valid.body.remarks, expectedVersion: req.valid.body.expected_version,
  });
  res.json({ evaluation });
});

// ---------------------------------------------------------------- profile
router.get('/profile', async (req, res) => {
  const { rows: [p] } = await query(
    `SELECT u.id, u.email, u.full_name, ep.employee_code, ep.phone, ep.department, ep.designation, ep.specialization, ep.status
       FROM users u JOIN examiner_profiles ep ON ep.user_id = u.id WHERE u.id = $1`,
    [req.user.id],
  );
  res.json({ profile: p });
});

module.exports = router;

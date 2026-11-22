const express = require('express');
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const config = require('../config');
const { validate } = require('../middleware/validate');
const { notFound, conflict } = require('../lib/errors');
const { remember } = require('../lib/cache');
const {
  z, id, idParam, pageQuery, paginate, whereBuilder, likeTerm, phone, optionalText, boolish,
} = require('../lib/http');
const bookings = require('../services/bookings');
const { bookSlotNaive } = require('../services/naiveBooking');
const { enqueueOrRun } = require('../jobs/queue');

const router = express.Router();

const BOOKING_OPEN_SQL = `(e.status = 'Booking Open'
  AND (e.booking_start IS NULL OR now() >= e.booking_start)
  AND (e.booking_end IS NULL OR now() <= e.booking_end))`;

const BOOKING_SELECT = `
  SELECT b.id, b.status, b.attendance, b.booked_at, b.cancelled_at, b.cancel_reason,
         b.exam_id, e.name AS exam_name, e.exam_type, e.status AS exam_status, e.max_marks, e.pass_marks,
         e.instructions, e.duration_minutes, e.booking_end, e.results_published,
         c.code AS course_code, c.name AS course_name,
         s.id AS slot_id, s.slot_date, s.start_time, s.end_time, s.meeting_link, s.venue, s.status AS slot_status,
         x.id AS examiner_id, x.full_name AS examiner_name,
         (b.status = 'Booked' AND ${BOOKING_OPEN_SQL} AND (s.slot_date + s.start_time) > LOCALTIMESTAMP) AS can_cancel,
         CASE WHEN e.results_published THEN ev.total_marks END AS marks,
         CASE WHEN e.results_published THEN ev.remarks END AS remarks,
         CASE WHEN e.results_published THEN ev.status END AS evaluation_status
    FROM bookings b
    JOIN examinations e ON e.id = b.exam_id
    JOIN courses c ON c.id = e.course_id
    JOIN slots s ON s.id = b.slot_id
    JOIN users x ON x.id = s.examiner_id
    LEFT JOIN evaluations ev ON ev.booking_id = b.id`;

// ---------------------------------------------------------------- dashboard
router.get('/dashboard', async (req, res) => {
  const sid = req.user.id;
  const [counts, upcoming, results] = await Promise.all([
    query(
      `SELECT
         (SELECT count(*)::int FROM examinations e JOIN courses c ON c.id = e.course_id
           WHERE c.status = 'Active' AND ${BOOKING_OPEN_SQL}
             AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.exam_id = e.id AND b.student_id = $1 AND b.status <> 'Cancelled')
         ) AS available_exams,
         (SELECT count(*)::int FROM slots s JOIN examinations e ON e.id = s.exam_id
           WHERE s.status = 'Available' AND (s.slot_date + s.start_time) > LOCALTIMESTAMP AND ${BOOKING_OPEN_SQL}
         ) AS available_slots,
         (SELECT count(*)::int FROM bookings b JOIN slots s ON s.id = b.slot_id
           WHERE b.student_id = $1 AND b.status = 'Booked' AND (s.slot_date + s.end_time) >= LOCALTIMESTAMP) AS upcoming,
         (SELECT count(*)::int FROM bookings WHERE student_id = $1 AND status <> 'Cancelled') AS total_bookings,
         (SELECT count(*)::int FROM evaluations ev JOIN examinations e ON e.id = ev.exam_id
           WHERE ev.student_id = $1 AND e.results_published) AS published_results`,
      [sid],
    ),
    query(
      `${BOOKING_SELECT}
       WHERE b.student_id = $1 AND b.status = 'Booked' AND (s.slot_date + s.end_time) >= LOCALTIMESTAMP
       ORDER BY s.slot_date, s.start_time LIMIT 5`,
      [sid],
    ),
    query(
      `${BOOKING_SELECT}
       WHERE b.student_id = $1 AND e.results_published AND ev.status IN ('Submitted', 'Absent')
       ORDER BY e.results_published_at DESC LIMIT 5`,
      [sid],
    ),
  ]);
  res.json({ counts: counts.rows[0], upcoming: upcoming.rows, recent_results: results.rows });
});

// ---------------------------------------------------------------- examinations
const examListQuery = z.object({
  ...pageQuery,
  course_id: id.optional(),
  exam_type: z.enum(['Viva', 'Practical', 'Project Demo', 'Assessment']).optional(),
  status: z.enum(['Slot Creation', 'Booking Open', 'Closed', 'Completed']).optional(),
  open_only: boolish.optional(),
});

router.get('/exams', validate({ query: examListQuery }), async (req, res) => {
  const qp = req.valid.query;
  const data = await remember('exams', `student-list:${JSON.stringify(qp)}`, config.cacheTtl.exams, async () => {
    const w = whereBuilder();
    w.add("e.status <> 'Draft'").add("c.status = 'Active'");
    if (qp.q) w.add('(e.name ILIKE ? OR c.name ILIKE ? OR c.code ILIKE ?)', likeTerm(qp.q), likeTerm(qp.q), likeTerm(qp.q));
    if (qp.course_id) w.add('e.course_id = ?', qp.course_id);
    if (qp.exam_type) w.add('e.exam_type = ?', qp.exam_type);
    if (qp.status) w.add('e.status = ?', qp.status);
    if (qp.open_only) w.add(BOOKING_OPEN_SQL);
    return paginate({ query }, {
      listSql: `
        SELECT e.id, e.name, e.exam_type, e.description, e.duration_minutes, e.max_marks, e.status,
               e.booking_start, e.booking_end, e.results_published,
               c.id AS course_id, c.code AS course_code, c.name AS course_name,
               ${BOOKING_OPEN_SQL} AS booking_open,
               COALESCE(sl.available_slots, 0) AS available_slots,
               COALESCE(sl.available_seats, 0) AS available_seats,
               sl.first_date, sl.last_date
          FROM examinations e
          JOIN courses c ON c.id = e.course_id
          LEFT JOIN LATERAL (
            SELECT count(*) FILTER (WHERE s.status = 'Available' AND (s.slot_date + s.start_time) > LOCALTIMESTAMP)::int AS available_slots,
                   COALESCE(sum(s.available_seats) FILTER (WHERE s.status = 'Available' AND (s.slot_date + s.start_time) > LOCALTIMESTAMP), 0)::int AS available_seats,
                   min(s.slot_date) AS first_date, max(s.slot_date) AS last_date
              FROM slots s WHERE s.exam_id = e.id AND s.status <> 'Cancelled'
          ) sl ON TRUE
          ${w.sql()}
         ORDER BY ${BOOKING_OPEN_SQL} DESC, sl.first_date DESC NULLS LAST, e.id DESC`,
      countSql: `SELECT count(*)::int AS total FROM examinations e JOIN courses c ON c.id = e.course_id ${w.sql()}`,
      params: w.params,
      page: qp.page,
      perPage: qp.per_page,
    });
  });

  // personal part is never cached
  const ids = data.items.map((e) => e.id);
  const mine = ids.length ? (await query(
    "SELECT exam_id, id, status FROM bookings WHERE student_id = $1 AND exam_id = ANY($2) AND status <> 'Cancelled'",
    [req.user.id, ids],
  )).rows : [];
  const byExam = new Map(mine.map((b) => [b.exam_id, b]));
  res.json({ ...data, items: data.items.map((e) => ({ ...e, my_booking: byExam.get(e.id) || null })) });
});

async function examPublicDetail(examId) {
  return remember('exams', `detail:${examId}`, config.cacheTtl.exams, async () => {
    const { rows: [exam] } = await query(
      `SELECT e.id, e.name, e.exam_type, e.description, e.instructions, e.duration_minutes, e.max_marks, e.pass_marks,
              e.status, e.slot_creation_start, e.slot_creation_end, e.booking_start, e.booking_end, e.results_published,
              c.id AS course_id, c.code AS course_code, c.name AS course_name,
              ${BOOKING_OPEN_SQL} AS booking_open
         FROM examinations e JOIN courses c ON c.id = e.course_id
        WHERE e.id = $1 AND e.status <> 'Draft' AND c.status = 'Active'`,
      [examId],
    );
    return exam || null;
  });
}

const rubricFor = (examId) => remember('rubrics', `exam:${examId}`, config.cacheTtl.rubrics, async () => (
  (await query(
    'SELECT id, criterion_name, max_marks, weightage, description, position FROM rubric_criteria WHERE exam_id = $1 ORDER BY position, id',
    [examId],
  )).rows
));

const scheduleFor = (examId) => remember('slots', `exam:${examId}`, config.cacheTtl.slots, async () => (
  (await query(
    `SELECT s.id, s.slot_date, s.start_time, s.end_time, s.capacity, s.booked_count, s.available_seats, s.status,
            s.venue, (s.meeting_link IS NOT NULL) AS online, x.id AS examiner_id, x.full_name AS examiner_name,
            (s.slot_date + s.start_time) <= LOCALTIMESTAMP AS has_started
       FROM slots s JOIN users x ON x.id = s.examiner_id
      WHERE s.exam_id = $1 AND s.status <> 'Cancelled'
      ORDER BY s.slot_date, s.start_time, s.id`,
    [examId],
  )).rows
));

router.get('/exams/:id', validate({ params: idParam }), async (req, res) => {
  const examId = req.valid.params.id;
  const exam = await examPublicDetail(examId);
  if (!exam) throw notFound('Examination');
  const [rubric, slots, mine] = await Promise.all([
    rubricFor(examId),
    scheduleFor(examId),
    query(`${BOOKING_SELECT} WHERE b.student_id = $1 AND b.exam_id = $2 AND b.status <> 'Cancelled'`, [req.user.id, examId]),
  ]);
  res.json({ exam, rubric, slots, my_booking: mine.rows[0] || null });
});

// ---------------------------------------------------------------- bookings
router.post('/bookings', validate({ body: z.object({ slot_id: id }).strict() }), async (req, res) => {
  const book = config.naiveBookingDemo ? bookSlotNaive : bookings.bookSlot;
  const result = await book({ studentId: req.user.id, slotId: req.valid.body.slot_id });
  res.status(201).json(result);
});

router.post('/bookings/:id/cancel',
  validate({ params: idParam, body: z.object({ reason: optionalText(500) }).strict() }),
  async (req, res) => {
    const result = await bookings.cancelBooking({ bookingId: req.valid.params.id, actor: req.user, reason: req.valid.body.reason });
    res.json(result);
  });

const bookingListQuery = z.object({
  ...pageQuery,
  status: z.enum(['Booked', 'Cancelled', 'Completed']).optional(),
  upcoming: boolish.optional(),
});

router.get('/bookings', validate({ query: bookingListQuery }), async (req, res) => {
  const qp = req.valid.query;
  const w = whereBuilder();
  w.add('b.student_id = ?', req.user.id);
  if (qp.status) w.add('b.status = ?', qp.status);
  if (qp.upcoming) w.add("b.status = 'Booked' AND (s.slot_date + s.end_time) >= LOCALTIMESTAMP");
  if (qp.q) w.add('(e.name ILIKE ? OR c.code ILIKE ? OR c.name ILIKE ?)', likeTerm(qp.q), likeTerm(qp.q), likeTerm(qp.q));
  const result = await paginate({ query }, {
    listSql: `${BOOKING_SELECT} ${w.sql()} ORDER BY s.slot_date DESC, s.start_time DESC`,
    countSql: `SELECT count(*)::int AS total FROM bookings b JOIN examinations e ON e.id = b.exam_id
                 JOIN courses c ON c.id = e.course_id JOIN slots s ON s.id = b.slot_id ${w.sql()}`,
    params: w.params,
    page: qp.page,
    perPage: qp.per_page,
  });
  res.json(result);
});

router.get('/bookings/:id', validate({ params: idParam }), async (req, res) => {
  const { rows: [booking] } = await query(`${BOOKING_SELECT} WHERE b.id = $1 AND b.student_id = $2`, [req.valid.params.id, req.user.id]);
  if (!booking) throw notFound('Booking');
  const { rows: events } = await query(
    `SELECT be.id, be.event_type, be.reason, be.created_at,
            fs.slot_date AS from_date, fs.start_time AS from_start, ts.slot_date AS to_date, ts.start_time AS to_start,
            fx.full_name AS from_examiner, tx.full_name AS to_examiner, a.full_name AS actor_name, a.role AS actor_role
       FROM booking_events be
       LEFT JOIN slots fs ON fs.id = be.from_slot_id
       LEFT JOIN slots ts ON ts.id = be.to_slot_id
       LEFT JOIN users fx ON fx.id = be.from_examiner_id
       LEFT JOIN users tx ON tx.id = be.to_examiner_id
       LEFT JOIN users a ON a.id = be.actor_id
      WHERE be.booking_id = $1 ORDER BY be.created_at, be.id`,
    [booking.id],
  );
  let scores = [];
  if (booking.results_published) {
    scores = (await query(
      `SELECT rc.criterion_name, rc.max_marks, rc.weightage, es.marks, es.comment
         FROM evaluations ev JOIN evaluation_scores es ON es.evaluation_id = ev.id
         JOIN rubric_criteria rc ON rc.id = es.criterion_id
        WHERE ev.booking_id = $1 ORDER BY rc.position, rc.id`,
      [booking.id],
    )).rows;
  }
  res.json({ booking, events, scores });
});

// ---------------------------------------------------------------- history & results
router.get('/history', async (req, res) => {
  const { rows } = await query(`${BOOKING_SELECT} WHERE b.student_id = $1 ORDER BY s.slot_date DESC, s.start_time DESC`, [req.user.id]);
  const evaluated = rows.filter((r) => r.marks !== null && r.evaluation_status === 'Submitted');
  res.json({
    items: rows,
    summary: {
      total: rows.length,
      completed: rows.filter((r) => r.status === 'Completed').length,
      cancelled: rows.filter((r) => r.status === 'Cancelled').length,
      average_percent: evaluated.length
        ? Math.round((evaluated.reduce((s, r) => s + (r.marks / r.max_marks) * 100, 0) / evaluated.length) * 10) / 10
        : null,
    },
  });
});

router.get('/results', async (req, res) => {
  const { rows } = await query(
    `SELECT ev.id AS evaluation_id, ev.booking_id, ev.total_marks, ev.remarks, ev.status, ev.evaluated_at,
            e.id AS exam_id, e.name AS exam_name, e.exam_type, e.max_marks, e.pass_marks, e.results_published_at,
            c.code AS course_code, c.name AS course_name, x.full_name AS examiner_name, s.slot_date,
            (ev.status = 'Submitted' AND ev.total_marks >= e.pass_marks) AS passed,
            COALESCE((SELECT json_agg(json_build_object('criterion_name', rc.criterion_name, 'max_marks', rc.max_marks,
                                      'weightage', rc.weightage, 'marks', es.marks, 'comment', es.comment)
                                      ORDER BY rc.position, rc.id)
                        FROM evaluation_scores es JOIN rubric_criteria rc ON rc.id = es.criterion_id
                       WHERE es.evaluation_id = ev.id), '[]') AS scores
       FROM evaluations ev
       JOIN examinations e ON e.id = ev.exam_id
       JOIN courses c ON c.id = e.course_id
       JOIN bookings b ON b.id = ev.booking_id
       JOIN slots s ON s.id = b.slot_id
       JOIN users x ON x.id = ev.examiner_id
      WHERE ev.student_id = $1 AND e.results_published AND ev.status <> 'Draft'
      ORDER BY e.results_published_at DESC`,
    [req.user.id],
  );
  res.json({ items: rows });
});

// ---------------------------------------------------------------- profile
router.get('/profile', async (req, res) => {
  const { rows: [p] } = await query(
    `SELECT u.id, u.email, u.full_name, u.created_at, sp.roll_number, sp.phone, sp.department, sp.program,
            sp.year_of_study, sp.gchat_webhook_url, sp.email_reminders
       FROM users u JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = $1`,
    [req.user.id],
  );
  res.json({ profile: p });
});

const profileSchema = z.object({
  full_name: z.string().trim().min(2).max(120).optional(),
  phone: phone.optional().nullable().or(z.literal('').transform(() => null)),
  department: optionalText(100),
  program: optionalText(100),
  year_of_study: z.coerce.number().int().min(1).max(6).optional().nullable(),
  gchat_webhook_url: z.string().trim().regex(/^https:\/\/chat\.googleapis\.com\//, 'Must be a Google Chat webhook URL')
    .optional().nullable().or(z.literal('').transform(() => null)),
  email_reminders: z.boolean().optional(),
}).strict();

router.put('/profile', validate({ body: profileSchema }), async (req, res) => {
  const b = req.valid.body;
  if (b.full_name) await query('UPDATE users SET full_name = $2 WHERE id = $1', [req.user.id, b.full_name]);
  const fields = ['phone', 'department', 'program', 'year_of_study', 'gchat_webhook_url', 'email_reminders'].filter((f) => b[f] !== undefined);
  if (fields.length) {
    const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    await query(`UPDATE student_profiles SET ${sets} WHERE user_id = $1`, [req.user.id, ...fields.map((f) => b[f])]);
  }
  const { rows: [p] } = await query(
    `SELECT u.id, u.email, u.full_name, sp.roll_number, sp.phone, sp.department, sp.program, sp.year_of_study,
            sp.gchat_webhook_url, sp.email_reminders
       FROM users u JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = $1`,
    [req.user.id],
  );
  res.json({ profile: p });
});

// ---------------------------------------------------------------- CSV export (async job)
router.post('/exports', async (req, res) => {
  const { rows: [running] } = await query(
    "SELECT id FROM export_jobs WHERE user_id = $1 AND status IN ('Queued', 'Processing') AND created_at > now() - interval '10 minutes'",
    [req.user.id],
  );
  if (running) throw conflict('An export is already in progress');
  const { rows: [job] } = await query('INSERT INTO export_jobs (user_id) VALUES ($1) RETURNING *', [req.user.id]);
  const mode = await enqueueOrRun('export-history', { exportJobId: job.id });
  res.status(202).json({ job, mode });
});

router.get('/exports', async (req, res) => {
  const { rows } = await query(
    'SELECT id, status, file_name, row_count, error, created_at, completed_at FROM export_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
    [req.user.id],
  );
  res.json({ items: rows });
});

router.get('/exports/:id', validate({ params: idParam }), async (req, res) => {
  const { rows: [job] } = await query(
    'SELECT id, status, file_name, row_count, error, created_at, completed_at FROM export_jobs WHERE id = $1 AND user_id = $2',
    [req.valid.params.id, req.user.id],
  );
  if (!job) throw notFound('Export');
  res.json({ job });
});

router.get('/exports/:id/download', validate({ params: idParam }), async (req, res) => {
  const { rows: [job] } = await query(
    'SELECT status, file_name FROM export_jobs WHERE id = $1 AND user_id = $2', [req.valid.params.id, req.user.id],
  );
  if (!job) throw notFound('Export');
  if (job.status !== 'Completed') throw conflict('The export is not ready yet');
  const file = path.join(config.exportDir, path.basename(job.file_name));
  if (!fs.existsSync(file)) throw notFound('Export file');
  res.download(file, job.file_name);
});

module.exports = router;

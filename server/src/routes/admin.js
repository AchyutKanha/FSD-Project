const express = require('express');
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../db');
const { validate } = require('../middleware/validate');
const { notFound, conflict, badRequest } = require('../lib/errors');
const { invalidate, cacheStats } = require('../lib/cache');
const {
  z, id, idParam, isoDate, hhmm, dateTime, httpUrl, optionalText, email, password, phone, boolish,
  pageQuery, paginate, whereBuilder, likeTerm,
} = require('../lib/http');
const examsSvc = require('../services/exams');
const slotsSvc = require('../services/slots');
const bookingsSvc = require('../services/bookings');
const { BCRYPT_ROUNDS } = require('./auth');
const { enqueueOrRun } = require('../jobs/queue');
const { buildOverview } = require('../jobs/monthlyReport');

const router = express.Router();
const EXAM_TYPES = ['Viva', 'Practical', 'Project Demo', 'Assessment'];
const EXAM_STATUSES = ['Draft', 'Slot Creation', 'Booking Open', 'Closed', 'Completed'];

// ================================================================ dashboard
router.get('/dashboard', async (_req, res) => {
  const [totals, byStatus, recent, upcoming] = await Promise.all([
    query(`SELECT
      (SELECT count(*)::int FROM courses) AS courses,
      (SELECT count(*)::int FROM examinations) AS examinations,
      (SELECT count(*)::int FROM users WHERE role = 'student') AS students,
      (SELECT count(*)::int FROM users WHERE role = 'examiner') AS examiners,
      (SELECT count(*)::int FROM slots WHERE status <> 'Cancelled') AS slots,
      (SELECT count(*)::int FROM bookings) AS bookings,
      (SELECT count(*)::int FROM bookings WHERE status = 'Booked') AS active_bookings,
      (SELECT count(*)::int FROM bookings b JOIN slots s ON s.id = b.slot_id
         WHERE b.status = 'Booked' AND (s.slot_date + s.start_time) <= LOCALTIMESTAMP) AS pending_evaluations`),
    query('SELECT status, count(*)::int AS count FROM examinations GROUP BY status'),
    query(`SELECT b.id, b.status, b.booked_at, u.full_name AS student_name, e.name AS exam_name, c.code AS course_code,
                  s.slot_date, s.start_time
             FROM bookings b JOIN users u ON u.id = b.student_id JOIN examinations e ON e.id = b.exam_id
             JOIN courses c ON c.id = e.course_id JOIN slots s ON s.id = b.slot_id
            ORDER BY b.booked_at DESC LIMIT 8`),
    query(`SELECT e.id, e.name, e.status, c.code AS course_code, e.booking_end, e.slot_creation_end
             FROM examinations e JOIN courses c ON c.id = e.course_id
            WHERE e.status IN ('Slot Creation', 'Booking Open') ORDER BY COALESCE(e.booking_end, e.slot_creation_end) NULLS LAST LIMIT 8`),
  ]);
  const statusCounts = Object.fromEntries(EXAM_STATUSES.map((s) => [s, 0]));
  byStatus.rows.forEach((r) => { statusCounts[r.status] = r.count; });
  res.json({ totals: totals.rows[0], exams_by_status: statusCounts, recent_bookings: recent.rows, active_windows: upcoming.rows, cache: cacheStats() });
});

// ================================================================ global search
router.get('/search', validate({ query: z.object({ q: z.string().trim().min(2).max(100) }) }), async (req, res) => {
  const t = likeTerm(req.valid.query.q);
  const [students, examiners, exams, bookings] = await Promise.all([
    query(`SELECT u.id, u.full_name, u.email, sp.roll_number FROM users u JOIN student_profiles sp ON sp.user_id = u.id
            WHERE u.full_name ILIKE $1 OR u.email ILIKE $1 OR sp.roll_number ILIKE $1 ORDER BY u.full_name LIMIT 6`, [t]),
    query(`SELECT u.id, u.full_name, u.email, ep.department FROM users u JOIN examiner_profiles ep ON ep.user_id = u.id
            WHERE u.full_name ILIKE $1 OR u.email ILIKE $1 OR ep.employee_code ILIKE $1 ORDER BY u.full_name LIMIT 6`, [t]),
    query(`SELECT e.id, e.name, e.status, c.code AS course_code FROM examinations e JOIN courses c ON c.id = e.course_id
            WHERE e.name ILIKE $1 OR c.code ILIKE $1 OR c.name ILIKE $1 ORDER BY e.id DESC LIMIT 6`, [t]),
    query(`SELECT b.id, b.status, u.full_name AS student_name, sp.roll_number, e.name AS exam_name
             FROM bookings b JOIN users u ON u.id = b.student_id JOIN student_profiles sp ON sp.user_id = u.id
             JOIN examinations e ON e.id = b.exam_id
            WHERE u.full_name ILIKE $1 OR sp.roll_number ILIKE $1 OR e.name ILIKE $1 OR b.id::text = $2
            ORDER BY b.booked_at DESC LIMIT 6`, [t, req.valid.query.q]),
  ]);
  res.json({ students: students.rows, examiners: examiners.rows, exams: exams.rows, bookings: bookings.rows });
});

// ================================================================ courses
const courseBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/, '2-20 capital letters, digits or hyphens'),
  name: z.string().trim().min(2).max(150),
  description: optionalText(2000),
  department: optionalText(100),
  credits: z.coerce.number().int().min(0).max(20).optional().nullable(),
  status: z.enum(['Active', 'Inactive', 'Archived']).default('Active'),
}).strict();

router.get('/courses', validate({ query: z.object({ ...pageQuery, status: z.enum(['Active', 'Inactive', 'Archived']).optional() }) }), async (req, res) => {
  const qp = req.valid.query;
  const w = whereBuilder();
  if (qp.q) w.add('(c.code ILIKE ? OR c.name ILIKE ? OR c.department ILIKE ?)', likeTerm(qp.q), likeTerm(qp.q), likeTerm(qp.q));
  if (qp.status) w.add('c.status = ?', qp.status);
  res.json(await paginate({ query }, {
    listSql: `SELECT c.*, (SELECT count(*)::int FROM examinations e WHERE e.course_id = c.id) AS exam_count
                FROM courses c ${w.sql()} ORDER BY c.code`,
    countSql: `SELECT count(*)::int AS total FROM courses c ${w.sql()}`,
    params: w.params, page: qp.page, perPage: qp.per_page,
  }));
});

router.get('/courses/:id', validate({ params: idParam }), async (req, res) => {
  const { rows: [course] } = await query('SELECT * FROM courses WHERE id = $1', [req.valid.params.id]);
  if (!course) throw notFound('Course');
  const { rows: exams } = await query('SELECT id, name, exam_type, status FROM examinations WHERE course_id = $1 ORDER BY id', [course.id]);
  res.json({ course, exams });
});

router.post('/courses', validate({ body: courseBody }), async (req, res) => {
  const b = req.valid.body;
  const { rows: [course] } = await query(
    `INSERT INTO courses (code, name, description, department, credits, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [b.code, b.name, b.description ?? null, b.department ?? null, b.credits ?? null, b.status],
  );
  await invalidate('exams');
  res.status(201).json({ course });
});

router.put('/courses/:id', validate({ params: idParam, body: courseBody.partial() }), async (req, res) => {
  const b = req.valid.body;
  const fields = Object.keys(b);
  if (!fields.length) throw badRequest('Nothing to update');
  const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const { rows: [course] } = await query(`UPDATE courses SET ${sets} WHERE id = $1 RETURNING *`, [req.valid.params.id, ...fields.map((f) => b[f])]);
  if (!course) throw notFound('Course');
  await invalidate('exams');
  res.json({ course });
});

router.delete('/courses/:id', validate({ params: idParam }), async (req, res) => {
  const { rows: [n] } = await query('SELECT count(*)::int AS n FROM examinations WHERE course_id = $1', [req.valid.params.id]);
  if (n.n > 0) throw conflict(`This course has ${n.n} examination(s). Archive it instead of deleting.`);
  const { rowCount } = await query('DELETE FROM courses WHERE id = $1', [req.valid.params.id]);
  if (!rowCount) throw notFound('Course');
  await invalidate('exams');
  res.status(204).end();
});

// ================================================================ examinations
const examFields = {
  course_id: id,
  name: z.string().trim().min(2).max(150),
  exam_type: z.enum(EXAM_TYPES),
  description: optionalText(4000),
  instructions: optionalText(4000),
  duration_minutes: z.coerce.number().int().min(5).max(600),
  max_marks: z.coerce.number().positive().max(1000),
  pass_marks: z.coerce.number().min(0).max(1000).default(0),
  slot_creation_start: dateTime.nullable().optional(),
  slot_creation_end: dateTime.nullable().optional(),
  booking_start: dateTime.nullable().optional(),
  booking_end: dateTime.nullable().optional(),
};

function checkTimeline(v, ctx) {
  const t = (k) => (v[k] ? new Date(v[k]).getTime() : null);
  const pairs = [
    ['slot_creation_start', 'slot_creation_end', 'Slot creation must end after it starts'],
    ['booking_start', 'booking_end', 'Booking must end after it starts'],
    ['slot_creation_end', 'booking_start', 'Booking must start after slot creation ends'],
  ];
  for (const [a, b, msg] of pairs) {
    if (t(a) !== null && t(b) !== null && (a === 'slot_creation_end' ? t(b) < t(a) : t(b) <= t(a))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [b], message: msg });
    }
  }
  if (v.pass_marks !== undefined && v.max_marks !== undefined && v.pass_marks > v.max_marks) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pass_marks'], message: 'Pass marks cannot exceed maximum marks' });
  }
}

const examCreate = z.object(examFields).strict().superRefine(checkTimeline);
const examUpdate = z.object(examFields).partial().strict().superRefine(checkTimeline);

const EXAM_LIST_SELECT = `
  SELECT e.id, e.name, e.exam_type, e.status, e.duration_minutes, e.max_marks, e.pass_marks,
         e.slot_creation_start, e.slot_creation_end, e.booking_start, e.booking_end,
         e.results_published, e.created_at, c.id AS course_id, c.code AS course_code, c.name AS course_name,
         (SELECT count(*)::int FROM exam_examiners ee WHERE ee.exam_id = e.id) AS examiner_count,
         (SELECT count(*)::int FROM slots s WHERE s.exam_id = e.id AND s.status <> 'Cancelled') AS slot_count,
         (SELECT count(*)::int FROM bookings b WHERE b.exam_id = e.id AND b.status <> 'Cancelled') AS booking_count,
         (SELECT COALESCE(sum(weightage), 0)::float FROM rubric_criteria r WHERE r.exam_id = e.id) AS rubric_weightage
    FROM examinations e JOIN courses c ON c.id = e.course_id`;

router.get('/exams', validate({
  query: z.object({ ...pageQuery, course_id: id.optional(), status: z.enum(EXAM_STATUSES).optional(), exam_type: z.enum(EXAM_TYPES).optional() }),
}), async (req, res) => {
  const qp = req.valid.query;
  const w = whereBuilder();
  if (qp.q) w.add('(e.name ILIKE ? OR c.code ILIKE ? OR c.name ILIKE ?)', likeTerm(qp.q), likeTerm(qp.q), likeTerm(qp.q));
  if (qp.course_id) w.add('e.course_id = ?', qp.course_id);
  if (qp.status) w.add('e.status = ?', qp.status);
  if (qp.exam_type) w.add('e.exam_type = ?', qp.exam_type);
  res.json(await paginate({ query }, {
    listSql: `${EXAM_LIST_SELECT} ${w.sql()} ORDER BY e.id DESC`,
    countSql: `SELECT count(*)::int AS total FROM examinations e JOIN courses c ON c.id = e.course_id ${w.sql()}`,
    params: w.params, page: qp.page, perPage: qp.per_page,
  }));
});

router.get('/exams/:id', validate({ params: idParam }), async (req, res) => {
  const examId = req.valid.params.id;
  const { rows: [exam] } = await query(`${EXAM_LIST_SELECT} WHERE e.id = $1`, [examId]);
  if (!exam) throw notFound('Examination');
  const { rows: [full] } = await query('SELECT description, instructions FROM examinations WHERE id = $1', [examId]);
  const [examiners, rubric, history, stats] = await Promise.all([
    query(`SELECT u.id, u.full_name, u.email, ep.department, ep.status,
                  (SELECT count(*)::int FROM slots s WHERE s.exam_id = $1 AND s.examiner_id = u.id AND s.status <> 'Cancelled') AS slots
             FROM exam_examiners ee JOIN users u ON u.id = ee.examiner_id JOIN examiner_profiles ep ON ep.user_id = u.id
            WHERE ee.exam_id = $1 ORDER BY u.full_name`, [examId]),
    query('SELECT * FROM rubric_criteria WHERE exam_id = $1 ORDER BY position, id', [examId]),
    query(`SELECT h.*, u.full_name AS actor_name FROM exam_status_history h LEFT JOIN users u ON u.id = h.actor_id
            WHERE h.exam_id = $1 ORDER BY h.created_at DESC, h.id DESC`, [examId]),
    query(`SELECT count(*) FILTER (WHERE b.status = 'Booked')::int AS booked,
                  count(*) FILTER (WHERE b.status = 'Completed')::int AS completed,
                  count(*) FILTER (WHERE b.status = 'Cancelled')::int AS cancelled,
                  count(ev.id) FILTER (WHERE ev.status = 'Submitted')::int AS evaluated,
                  count(ev.id) FILTER (WHERE ev.status = 'Absent')::int AS absent,
                  count(ev.id) FILTER (WHERE ev.status = 'Draft')::int AS drafts,
                  round(avg(ev.total_marks) FILTER (WHERE ev.status = 'Submitted'), 2)::float AS average,
                  max(ev.total_marks) FILTER (WHERE ev.status = 'Submitted')::float AS highest,
                  min(ev.total_marks) FILTER (WHERE ev.status = 'Submitted')::float AS lowest
             FROM bookings b LEFT JOIN evaluations ev ON ev.booking_id = b.id WHERE b.exam_id = $1`, [examId]),
  ]);
  const transitions = Object.entries(examsSvc.TRANSITIONS[exam.status] || {}).map(([to, label]) => ({ to, label }));
  res.json({ exam: { ...exam, ...full }, examiners: examiners.rows, rubric: rubric.rows, history: history.rows, stats: stats.rows[0], transitions });
});

router.post('/exams', validate({ body: examCreate }), async (req, res) => {
  const b = req.valid.body;
  const exam = await withTransaction(async (c) => {
    const { rows: [course] } = await c.query('SELECT status FROM courses WHERE id = $1', [b.course_id]);
    if (!course) throw badRequest('Course does not exist');
    if (course.status !== 'Active') throw conflict('Examinations can only be created for active courses');
    const { rows: [e] } = await c.query(
      `INSERT INTO examinations (course_id, name, exam_type, description, instructions, duration_minutes, max_marks, pass_marks,
                                 slot_creation_start, slot_creation_end, booking_start, booking_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [b.course_id, b.name, b.exam_type, b.description ?? null, b.instructions ?? null, b.duration_minutes, b.max_marks,
        b.pass_marks, b.slot_creation_start ?? null, b.slot_creation_end ?? null, b.booking_start ?? null, b.booking_end ?? null],
    );
    await c.query("INSERT INTO exam_status_history (exam_id, to_status, actor_id, note) VALUES ($1, 'Draft', $2, 'Created')", [e.id, req.user.id]);
    return e;
  });
  await invalidate('exams');
  res.status(201).json({ exam });
});

router.put('/exams/:id', validate({ params: idParam, body: examUpdate }), async (req, res) => {
  const b = req.valid.body;
  const fields = Object.keys(b);
  if (!fields.length) throw badRequest('Nothing to update');
  const exam = await withTransaction(async (c) => {
    const current = await examsSvc.lockExam(c, req.valid.params.id);
    const { rows: [usage] } = await c.query(
      `SELECT (SELECT count(*)::int FROM slots WHERE exam_id = $1) AS slots,
              (SELECT count(*)::int FROM evaluations WHERE exam_id = $1) AS evaluations`,
      [current.id],
    );
    if (b.course_id !== undefined && b.course_id !== current.course_id && current.status !== 'Draft') {
      throw conflict('The course can only be changed while the examination is a draft');
    }
    if (b.max_marks !== undefined && b.max_marks !== current.max_marks && usage.evaluations > 0) {
      throw conflict('Maximum marks cannot change after evaluations have been recorded');
    }
    if (b.duration_minutes !== undefined && b.duration_minutes !== current.duration_minutes && usage.slots > 0) {
      throw conflict('Duration cannot change after slots have been created');
    }
    if (current.status === 'Completed') throw conflict('A completed examination cannot be edited; re-open it first');
    // re-validate the merged timeline (partial updates can break ordering)
    const merged = { ...current, ...b };
    const issues = [];
    checkTimeline(
      Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])),
      { addIssue: (i) => issues.push({ field: i.path.join('.'), message: i.message }) },
    );
    if (issues.length) throw badRequest('Validation failed', issues);
    const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const { rows: [e] } = await c.query(`UPDATE examinations SET ${sets} WHERE id = $1 RETURNING *`, [current.id, ...fields.map((f) => b[f])]);
    return e;
  });
  await invalidate('exams', 'slots');
  res.json({ exam });
});

router.delete('/exams/:id', validate({ params: idParam }), async (req, res) => {
  await withTransaction(async (c) => {
    const exam = await examsSvc.lockExam(c, req.valid.params.id);
    if (exam.status !== 'Draft') throw conflict('Only draft examinations can be deleted');
    const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM slots WHERE exam_id = $1', [exam.id]);
    if (n.n > 0) throw conflict('This examination has slots and cannot be deleted');
    await c.query('DELETE FROM examinations WHERE id = $1', [exam.id]);
  });
  await invalidate('exams', 'rubrics');
  res.status(204).end();
});

router.post('/exams/:id/status', validate({
  params: idParam, body: z.object({ status: z.enum(EXAM_STATUSES), note: optionalText(500) }).strict(),
}), async (req, res) => {
  const exam = await examsSvc.transitionStatus({ examId: req.valid.params.id, to: req.valid.body.status, actorId: req.user.id, note: req.valid.body.note });
  res.json({ exam });
});

router.put('/exams/:id/examiners', validate({
  params: idParam, body: z.object({ examiner_ids: z.array(id).max(100) }).strict(),
}), async (req, res) => {
  const examId = req.valid.params.id;
  const wanted = [...new Set(req.valid.body.examiner_ids)];
  const result = await withTransaction(async (c) => {
    const exam = await examsSvc.lockExam(c, examId);
    if (exam.status === 'Completed') throw conflict('Examiners of a completed examination cannot change');
    if (wanted.length) {
      const { rows } = await c.query(
        "SELECT id FROM users WHERE id = ANY($1) AND role = 'examiner' AND is_active", [wanted],
      );
      if (rows.length !== wanted.length) throw badRequest('One or more examiners do not exist or are inactive');
    }
    // removing an examiner who already owns slots fails on the FK -> 409 with a clear message
    const { rows: removed } = await c.query(
      'DELETE FROM exam_examiners WHERE exam_id = $1 AND NOT (examiner_id = ANY($2)) RETURNING examiner_id', [examId, wanted],
    );
    const { rows: added } = await c.query(
      `INSERT INTO exam_examiners (exam_id, examiner_id)
       SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING RETURNING examiner_id`,
      [examId, wanted],
    );
    for (const a of added) {
      await c.query(
        "INSERT INTO notifications (user_id, title, message, link) VALUES ($1, 'Assigned to an examination', $2, $3)",
        [a.examiner_id, `You have been assigned to "${exam.name}".`, `/examiner/exams/${examId}`],
      );
    }
    return { added: added.length, removed: removed.length };
  });
  await invalidate('exams');
  res.json(result);
});

router.post('/exams/:id/publish', validate({ params: idParam }), async (req, res) => {
  res.json({ exam: await examsSvc.setPublished({ examId: req.valid.params.id, publish: true, actorId: req.user.id }) });
});

router.post('/exams/:id/unpublish', validate({ params: idParam }), async (req, res) => {
  res.json({ exam: await examsSvc.setPublished({ examId: req.valid.params.id, publish: false, actorId: req.user.id }) });
});

router.get('/exams/:id/results', validate({ params: idParam }), async (req, res) => {
  const { rows } = await query(
    `SELECT b.id AS booking_id, b.status AS booking_status, b.attendance, u.full_name AS student_name, sp.roll_number,
            x.full_name AS examiner_name, s.slot_date, s.start_time, ev.id AS evaluation_id, ev.status AS evaluation_status,
            ev.total_marks, ev.remarks, ev.version, ev.evaluated_at
       FROM bookings b JOIN users u ON u.id = b.student_id JOIN student_profiles sp ON sp.user_id = u.id
       JOIN slots s ON s.id = b.slot_id JOIN users x ON x.id = s.examiner_id
       LEFT JOIN evaluations ev ON ev.booking_id = b.id
      WHERE b.exam_id = $1 AND b.status <> 'Cancelled'
      ORDER BY u.full_name`,
    [req.valid.params.id],
  );
  res.json({ items: rows });
});

// ---------------------------------------------------------------- rubric
const rubricBody = z.object({
  criterion_name: z.string().trim().min(2).max(120),
  max_marks: z.coerce.number().positive().max(1000),
  weightage: z.coerce.number().positive().max(100),
  description: optionalText(1000),
  position: z.coerce.number().int().min(0).max(1000).optional(),
}).strict();

router.get('/exams/:id/rubrics', validate({ params: idParam }), async (req, res) => {
  const { rows } = await query('SELECT * FROM rubric_criteria WHERE exam_id = $1 ORDER BY position, id', [req.valid.params.id]);
  res.json({ items: rows, total_weightage: rows.reduce((s, r) => s + r.weightage, 0) });
});

router.post('/exams/:id/rubrics', validate({ params: idParam, body: rubricBody }), async (req, res) => {
  res.status(201).json({ criterion: await examsSvc.rubricWrite({ examId: req.valid.params.id, data: req.valid.body }) });
});

router.put('/rubrics/:id', validate({ params: idParam, body: rubricBody.partial() }), async (req, res) => {
  res.json({ criterion: await examsSvc.rubricWrite({ criterionId: req.valid.params.id, data: req.valid.body }) });
});

router.delete('/rubrics/:id', validate({ params: idParam }), async (req, res) => {
  await examsSvc.rubricWrite({ criterionId: req.valid.params.id, remove: true });
  res.status(204).end();
});

// ================================================================ examiners
const examinerCreate = z.object({
  full_name: z.string().trim().min(2).max(120),
  email,
  password,
  employee_code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/, '2-20 letters, digits or hyphens'),
  department: z.string().trim().min(2).max(100),
  phone: phone.optional().nullable().or(z.literal('').transform(() => null)),
  designation: optionalText(100),
  specialization: optionalText(200),
}).strict();

const examinerUpdate = z.object({
  full_name: z.string().trim().min(2).max(120).optional(),
  email: email.optional(),
  password: password.optional(),
  department: z.string().trim().min(2).max(100).optional(),
  phone: phone.optional().nullable().or(z.literal('').transform(() => null)),
  designation: optionalText(100),
  specialization: optionalText(200),
  status: z.enum(['Active', 'On Leave', 'Inactive']).optional(),
  is_active: z.boolean().optional(),
}).strict();

const EXAMINER_SELECT = `
  SELECT u.id, u.email, u.full_name, u.is_active, u.last_login_at, u.created_at,
         ep.employee_code, ep.phone, ep.department, ep.designation, ep.specialization, ep.status,
         (SELECT count(*)::int FROM exam_examiners ee WHERE ee.examiner_id = u.id) AS assigned_exams,
         (SELECT count(*)::int FROM slots s WHERE s.examiner_id = u.id AND s.status <> 'Cancelled') AS slots,
         (SELECT count(*)::int FROM evaluations ev WHERE ev.examiner_id = u.id AND ev.status <> 'Draft') AS evaluations
    FROM users u JOIN examiner_profiles ep ON ep.user_id = u.id`;

router.get('/examiners', validate({
  query: z.object({ ...pageQuery, department: z.string().max(100).optional(), status: z.enum(['Active', 'On Leave', 'Inactive']).optional(), all: z.enum(['true', 'false']).optional() }),
}), async (req, res) => {
  const qp = req.valid.query;
  const w = whereBuilder();
  if (qp.q) w.add('(u.full_name ILIKE ? OR u.email ILIKE ? OR ep.employee_code ILIKE ?)', likeTerm(qp.q), likeTerm(qp.q), likeTerm(qp.q));
  if (qp.department) w.add('ep.department = ?', qp.department);
  if (qp.status) w.add('ep.status = ?', qp.status);
  res.json(await paginate({ query }, {
    listSql: `${EXAMINER_SELECT} ${w.sql()} ORDER BY u.full_name`,
    countSql: `SELECT count(*)::int AS total FROM users u JOIN examiner_profiles ep ON ep.user_id = u.id ${w.sql()}`,
    params: w.params, page: qp.page, perPage: qp.all === 'true' ? 100 : qp.per_page,
  }));
});

router.get('/examiners/:id', validate({ params: idParam }), async (req, res) => {
  const { rows: [examiner] } = await query(`${EXAMINER_SELECT} WHERE u.id = $1`, [req.valid.params.id]);
  if (!examiner) throw notFound('Examiner');
  const { rows: exams } = await query(
    `SELECT e.id, e.name, e.status, c.code AS course_code,
            (SELECT count(*)::int FROM slots s WHERE s.exam_id = e.id AND s.examiner_id = $1 AND s.status <> 'Cancelled') AS slots
       FROM exam_examiners ee JOIN examinations e ON e.id = ee.exam_id JOIN courses c ON c.id = e.course_id
      WHERE ee.examiner_id = $1 ORDER BY e.id DESC`,
    [examiner.id],
  );
  res.json({ examiner, exams });
});

router.post('/examiners', validate({ body: examinerCreate }), async (req, res) => {
  const b = req.valid.body;
  const hash = await bcrypt.hash(b.password, BCRYPT_ROUNDS);
  const newId = await withTransaction(async (c) => {
    const { rows: [u] } = await c.query(
      "INSERT INTO users (email, password_hash, full_name, role) VALUES ($1, $2, $3, 'examiner') RETURNING id",
      [b.email, hash, b.full_name],
    );
    await c.query(
      `INSERT INTO examiner_profiles (user_id, employee_code, phone, department, designation, specialization)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [u.id, b.employee_code, b.phone ?? null, b.department, b.designation ?? null, b.specialization ?? null],
    );
    return u.id;
  });
  const { rows: [examiner] } = await query(`${EXAMINER_SELECT} WHERE u.id = $1`, [newId]);
  res.status(201).json({ examiner });
});

router.put('/examiners/:id', validate({ params: idParam, body: examinerUpdate }), async (req, res) => {
  const b = req.valid.body;
  const xid = req.valid.params.id;
  await withTransaction(async (c) => {
    const { rows: [u] } = await c.query("SELECT id FROM users WHERE id = $1 AND role = 'examiner' FOR NO KEY UPDATE", [xid]);
    if (!u) throw notFound('Examiner');
    const userSets = [];
    const userVals = [];
    if (b.full_name) { userVals.push(b.full_name); userSets.push(`full_name = $${userVals.length + 1}`); }
    if (b.email) { userVals.push(b.email); userSets.push(`email = $${userVals.length + 1}`); }
    if (b.password) { userVals.push(await bcrypt.hash(b.password, BCRYPT_ROUNDS)); userSets.push(`password_hash = $${userVals.length + 1}`); }
    if (b.is_active !== undefined) { userVals.push(b.is_active); userSets.push(`is_active = $${userVals.length + 1}`); }
    if (userSets.length) await c.query(`UPDATE users SET ${userSets.join(', ')} WHERE id = $1`, [xid, ...userVals]);
    const pf = ['department', 'phone', 'designation', 'specialization', 'status'].filter((f) => b[f] !== undefined);
    if (pf.length) {
      await c.query(`UPDATE examiner_profiles SET ${pf.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE user_id = $1`, [xid, ...pf.map((f) => b[f])]);
    }
  });
  const { rows: [examiner] } = await query(`${EXAMINER_SELECT} WHERE u.id = $1`, [xid]);
  res.json({ examiner });
});

router.delete('/examiners/:id', validate({ params: idParam }), async (req, res) => {
  const xid = req.valid.params.id;
  const { rows: [use] } = await query(
    `SELECT (SELECT count(*)::int FROM exam_examiners WHERE examiner_id = $1) AS assigned,
            (SELECT count(*)::int FROM evaluations WHERE examiner_id = $1) AS evaluations`, [xid],
  );
  if (use.assigned || use.evaluations) throw conflict('This examiner has examination history. Deactivate the account instead.');
  const { rowCount } = await query("DELETE FROM users WHERE id = $1 AND role = 'examiner'", [xid]);
  if (!rowCount) throw notFound('Examiner');
  res.status(204).end();
});

// ================================================================ students
router.get('/students', validate({
  query: z.object({ ...pageQuery, department: z.string().max(100).optional(), active: z.enum(['true', 'false']).optional() }),
}), async (req, res) => {
  const qp = req.valid.query;
  const w = whereBuilder();
  if (qp.q) w.add('(u.full_name ILIKE ? OR u.email ILIKE ? OR sp.roll_number ILIKE ?)', likeTerm(qp.q), likeTerm(qp.q), likeTerm(qp.q));
  if (qp.department) w.add('sp.department = ?', qp.department);
  if (qp.active) w.add('u.is_active = ?', qp.active === 'true');
  res.json(await paginate({ query }, {
    listSql: `SELECT u.id, u.email, u.full_name, u.is_active, u.created_at, u.last_login_at,
                     sp.roll_number, sp.department, sp.program, sp.year_of_study,
                     (SELECT count(*)::int FROM bookings b WHERE b.student_id = u.id AND b.status <> 'Cancelled') AS bookings
                FROM users u JOIN student_profiles sp ON sp.user_id = u.id ${w.sql()} ORDER BY u.full_name, u.id`,
    countSql: `SELECT count(*)::int AS total FROM users u JOIN student_profiles sp ON sp.user_id = u.id ${w.sql()}`,
    params: w.params, page: qp.page, perPage: qp.per_page,
  }));
});

router.get('/students/:id', validate({ params: idParam }), async (req, res) => {
  const { rows: [student] } = await query(
    `SELECT u.id, u.email, u.full_name, u.is_active, u.created_at, u.last_login_at, sp.*
       FROM users u JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = $1`,
    [req.valid.params.id],
  );
  if (!student) throw notFound('Student');
  const { rows: bookings } = await query(
    `SELECT b.id, b.status, b.attendance, b.booked_at, e.name AS exam_name, c.code AS course_code,
            s.slot_date, s.start_time, x.full_name AS examiner_name, ev.status AS evaluation_status, ev.total_marks, e.max_marks
       FROM bookings b JOIN examinations e ON e.id = b.exam_id JOIN courses c ON c.id = e.course_id
       JOIN slots s ON s.id = b.slot_id JOIN users x ON x.id = s.examiner_id
       LEFT JOIN evaluations ev ON ev.booking_id = b.id
      WHERE b.student_id = $1 ORDER BY s.slot_date DESC`,
    [student.id],
  );
  delete student.user_role;
  res.json({ student, bookings });
});

router.put('/students/:id/status', validate({ params: idParam, body: z.object({ is_active: z.boolean() }).strict() }), async (req, res) => {
  const { rows: [u] } = await query(
    "UPDATE users SET is_active = $2 WHERE id = $1 AND role = 'student' RETURNING id, is_active", [req.valid.params.id, req.valid.body.is_active],
  );
  if (!u) throw notFound('Student');
  res.json({ student: u });
});

// ================================================================ slots
router.get('/slots', validate({
  query: z.object({
    ...pageQuery,
    exam_id: id.optional(),
    examiner_id: id.optional(),
    status: z.enum(['Available', 'Full', 'Cancelled', 'Completed']).optional(),
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
  }),
}), async (req, res) => {
  const qp = req.valid.query;
  const w = whereBuilder();
  if (qp.exam_id) w.add('s.exam_id = ?', qp.exam_id);
  if (qp.examiner_id) w.add('s.examiner_id = ?', qp.examiner_id);
  if (qp.status) w.add('s.status = ?', qp.status);
  if (qp.date_from) w.add('s.slot_date >= ?', qp.date_from);
  if (qp.date_to) w.add('s.slot_date <= ?', qp.date_to);
  if (qp.q) w.add('(e.name ILIKE ? OR c.code ILIKE ? OR x.full_name ILIKE ?)', likeTerm(qp.q), likeTerm(qp.q), likeTerm(qp.q));
  const from = 'FROM slots s JOIN examinations e ON e.id = s.exam_id JOIN courses c ON c.id = e.course_id JOIN users x ON x.id = s.examiner_id';
  res.json(await paginate({ query }, {
    listSql: `SELECT s.*, e.name AS exam_name, e.status AS exam_status, c.code AS course_code, x.full_name AS examiner_name,
                     (s.slot_date + s.start_time) <= LOCALTIMESTAMP AS has_started
                ${from} ${w.sql()} ORDER BY s.slot_date DESC, s.start_time, s.id`,
    countSql: `SELECT count(*)::int AS total ${from} ${w.sql()}`,
    params: w.params, page: qp.page, perPage: qp.per_page,
  }));
});

router.get('/slots/:id', validate({ params: idParam }), async (req, res) => {
  const { rows: [slot] } = await query(
    `SELECT s.*, e.name AS exam_name, e.status AS exam_status, e.duration_minutes, c.code AS course_code,
            x.full_name AS examiner_name, (s.slot_date + s.start_time) <= LOCALTIMESTAMP AS has_started
       FROM slots s JOIN examinations e ON e.id = s.exam_id JOIN courses c ON c.id = e.course_id
       JOIN users x ON x.id = s.examiner_id WHERE s.id = $1`,
    [req.valid.params.id],
  );
  if (!slot) throw notFound('Slot');
  const [bookings, changes] = await Promise.all([
    query(`SELECT b.id, b.status, b.attendance, u.full_name AS student_name, sp.roll_number, ev.status AS evaluation_status
             FROM bookings b JOIN users u ON u.id = b.student_id JOIN student_profiles sp ON sp.user_id = u.id
             LEFT JOIN evaluations ev ON ev.booking_id = b.id WHERE b.slot_id = $1 ORDER BY b.status, u.full_name`, [slot.id]),
    query(`SELECT sc.*, a.full_name AS actor_name, ox.full_name AS old_examiner, nx.full_name AS new_examiner
             FROM slot_changes sc LEFT JOIN users a ON a.id = sc.actor_id
             LEFT JOIN users ox ON ox.id = sc.old_examiner_id LEFT JOIN users nx ON nx.id = sc.new_examiner_id
            WHERE sc.slot_id = $1 ORDER BY sc.created_at DESC, sc.id DESC`, [slot.id]),
  ]);
  res.json({ slot, bookings: bookings.rows, changes: changes.rows });
});

router.put('/slots/:id', validate({
  params: idParam,
  body: z.object({
    slot_date: isoDate.optional(),
    start_time: hhmm.optional(),
    end_time: hhmm.optional(),
    capacity: z.coerce.number().int().min(1).max(200).optional(),
    venue: optionalText(200),
    meeting_link: httpUrl.optional().nullable().or(z.literal('').transform(() => null)),
    reason: z.string().trim().min(3, 'Give a reason for the change').max(500),
  }).strict(),
}), async (req, res) => {
  res.json({ slot: await slotsSvc.adminUpdateSlot({ actorId: req.user.id, slotId: req.valid.params.id, data: req.valid.body }) });
});

router.put('/slots/:id/examiner', validate({
  params: idParam, body: z.object({ examiner_id: id, reason: z.string().trim().min(3).max(500) }).strict(),
}), async (req, res) => {
  res.json(await slotsSvc.changeSlotExaminer({
    actorId: req.user.id, slotId: req.valid.params.id, examinerId: req.valid.body.examiner_id, reason: req.valid.body.reason,
  }));
});

router.post('/slots/:id/cancel', validate({
  params: idParam, body: z.object({ reason: z.string().trim().min(3).max(500) }).strict(),
}), async (req, res) => {
  res.json({ slot: await slotsSvc.adminCancelSlot({ actorId: req.user.id, slotId: req.valid.params.id, reason: req.valid.body.reason }) });
});

// ================================================================ bookings
router.get('/bookings', validate({
  query: z.object({
    ...pageQuery,
    exam_id: id.optional(),
    examiner_id: id.optional(),
    student_id: id.optional(),
    status: z.enum(['Booked', 'Cancelled', 'Completed']).optional(),
  }),
}), async (req, res) => {
  const qp = req.valid.query;
  const w = whereBuilder();
  if (qp.exam_id) w.add('b.exam_id = ?', qp.exam_id);
  if (qp.examiner_id) w.add('s.examiner_id = ?', qp.examiner_id);
  if (qp.student_id) w.add('b.student_id = ?', qp.student_id);
  if (qp.status) w.add('b.status = ?', qp.status);
  if (qp.q) w.add('(u.full_name ILIKE ? OR sp.roll_number ILIKE ? OR u.email ILIKE ? OR e.name ILIKE ?)', likeTerm(qp.q), likeTerm(qp.q), likeTerm(qp.q), likeTerm(qp.q));
  const from = `FROM bookings b JOIN users u ON u.id = b.student_id JOIN student_profiles sp ON sp.user_id = u.id
                JOIN slots s ON s.id = b.slot_id JOIN examinations e ON e.id = b.exam_id JOIN courses c ON c.id = e.course_id
                JOIN users x ON x.id = s.examiner_id LEFT JOIN evaluations ev ON ev.booking_id = b.id`;
  res.json(await paginate({ query }, {
    listSql: `SELECT b.id, b.status, b.attendance, b.booked_at, b.cancelled_at, u.id AS student_id, u.full_name AS student_name,
                     sp.roll_number, e.id AS exam_id, e.name AS exam_name, c.code AS course_code, s.id AS slot_id,
                     s.slot_date, s.start_time, s.end_time, x.id AS examiner_id, x.full_name AS examiner_name,
                     ev.status AS evaluation_status, ev.total_marks
                ${from} ${w.sql()} ORDER BY b.booked_at DESC, b.id DESC`,
    countSql: `SELECT count(*)::int AS total ${from} ${w.sql()}`,
    params: w.params, page: qp.page, perPage: qp.per_page,
  }));
});

router.get('/bookings/:id', validate({ params: idParam }), async (req, res) => {
  const { rows: [booking] } = await query(
    `SELECT b.*, u.full_name AS student_name, u.email AS student_email, sp.roll_number, e.name AS exam_name, e.status AS exam_status,
            c.code AS course_code, s.slot_date, s.start_time, s.end_time, x.id AS examiner_id, x.full_name AS examiner_name,
            ev.id AS evaluation_id, ev.status AS evaluation_status, ev.total_marks, ev.remarks, ev.version
       FROM bookings b JOIN users u ON u.id = b.student_id JOIN student_profiles sp ON sp.user_id = u.id
       JOIN slots s ON s.id = b.slot_id JOIN examinations e ON e.id = b.exam_id JOIN courses c ON c.id = e.course_id
       JOIN users x ON x.id = s.examiner_id LEFT JOIN evaluations ev ON ev.booking_id = b.id
      WHERE b.id = $1`,
    [req.valid.params.id],
  );
  if (!booking) throw notFound('Booking');
  const [events, alternatives, versions] = await Promise.all([
    query(`SELECT be.*, a.full_name AS actor_name, fx.full_name AS from_examiner, tx.full_name AS to_examiner,
                  fs.slot_date AS from_date, fs.start_time AS from_start, ts.slot_date AS to_date, ts.start_time AS to_start
             FROM booking_events be LEFT JOIN users a ON a.id = be.actor_id
             LEFT JOIN users fx ON fx.id = be.from_examiner_id LEFT JOIN users tx ON tx.id = be.to_examiner_id
             LEFT JOIN slots fs ON fs.id = be.from_slot_id LEFT JOIN slots ts ON ts.id = be.to_slot_id
            WHERE be.booking_id = $1 ORDER BY be.created_at, be.id`, [booking.id]),
    // other slots of the same exam the booking could be moved to
    query(`SELECT s.id, s.slot_date, s.start_time, s.end_time, s.available_seats, x.full_name AS examiner_name
             FROM slots s JOIN users x ON x.id = s.examiner_id
            WHERE s.exam_id = $1 AND s.id <> $2 AND s.status = 'Available' AND (s.slot_date + s.start_time) > LOCALTIMESTAMP
            ORDER BY s.slot_date, s.start_time`, [booking.exam_id, booking.slot_id]),
    booking.evaluation_id
      ? query(`SELECT v.version, v.status, v.total_marks, v.remarks, v.created_at, u.full_name AS actor_name
                 FROM evaluation_versions v LEFT JOIN users u ON u.id = v.actor_id
                WHERE v.evaluation_id = $1 ORDER BY v.version DESC`, [booking.evaluation_id])
      : Promise.resolve({ rows: [] }),
  ]);
  res.json({ booking, events: events.rows, alternatives: alternatives.rows, evaluation_versions: versions.rows });
});

router.post('/bookings/:id/reschedule', validate({
  params: idParam, body: z.object({ slot_id: id, reason: z.string().trim().min(3, 'Give a reason').max(500) }).strict(),
}), async (req, res) => {
  res.json(await bookingsSvc.rescheduleBooking({
    bookingId: req.valid.params.id, targetSlotId: req.valid.body.slot_id, actorId: req.user.id, reason: req.valid.body.reason,
  }));
});

router.post('/bookings/:id/cancel', validate({
  params: idParam, body: z.object({ reason: z.string().trim().min(3).max(500) }).strict(),
}), async (req, res) => {
  res.json(await bookingsSvc.cancelBooking({ bookingId: req.valid.params.id, actor: req.user, reason: req.valid.body.reason }));
});

// ================================================================ reports & jobs
router.get('/reports/overview', validate({ query: z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }) }), async (req, res) => {
  res.json(await buildOverview({ months: req.valid.query.months }));
});

router.get('/reports/monthly', async (_req, res) => {
  const { rows } = await query("SELECT to_char(report_month, 'YYYY-MM') AS month, sent_to, created_at FROM monthly_reports ORDER BY report_month DESC");
  res.json({ items: rows });
});

router.get('/reports/monthly/:month', validate({ params: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }) }), async (req, res) => {
  const { rows: [r] } = await query('SELECT html FROM monthly_reports WHERE report_month = $1::date', [`${req.valid.params.month}-01`]);
  if (!r) throw notFound('Report');
  res.type('html').send(r.html);
});

router.post('/jobs/monthly-report', validate({
  body: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), force: boolish.optional() }).strict(),
}), async (req, res) => {
  const mode = await enqueueOrRun('monthly-report', { month: req.valid.body.month, force: req.valid.body.force ?? true });
  res.status(202).json({ message: 'Monthly report job started', mode });
});

router.post('/jobs/daily-reminders', async (_req, res) => {
  const mode = await enqueueOrRun('daily-reminders', {});
  res.status(202).json({ message: 'Reminder job started', mode });
});

module.exports = router;

const { withTransaction } = require('../db');
const { badRequest, conflict, notFound } = require('../lib/errors');
const { invalidate } = require('../lib/cache');

/** Allowed status transitions and the button label the UI shows for each. */
const TRANSITIONS = {
  Draft: { 'Slot Creation': 'Open slot creation' },
  'Slot Creation': { Draft: 'Close slot creation', 'Booking Open': 'Open student booking' },
  'Booking Open': { Closed: 'Close student booking' },
  Closed: { 'Booking Open': 'Re-open booking', Completed: 'Mark examination completed' },
  Completed: { Closed: 'Re-open (undo completion)' },
};

async function lockExam(c, examId) {
  const { rows: [exam] } = await c.query('SELECT * FROM examinations WHERE id = $1 FOR NO KEY UPDATE', [examId]);
  if (!exam) throw notFound('Examination');
  return exam;
}

async function transitionStatus({ examId, to, actorId, note }) {
  const result = await withTransaction(async (c) => {
    const exam = await lockExam(c, examId);
    if (!TRANSITIONS[exam.status] || !TRANSITIONS[exam.status][to]) {
      throw conflict(`An examination cannot move from "${exam.status}" to "${to}"`);
    }
    const now = new Date();

    if (to === 'Slot Creation') {
      const { rows: [r] } = await c.query(
        `SELECT (SELECT status FROM courses WHERE id = $2) AS course_status,
                (SELECT count(*)::int FROM exam_examiners WHERE exam_id = $1) AS examiners`,
        [examId, exam.course_id],
      );
      if (r.course_status !== 'Active') throw conflict('The course is not active');
      if (r.examiners === 0) throw conflict('Assign at least one examiner before opening slot creation');
      if (exam.slot_creation_end && new Date(exam.slot_creation_end) < now) {
        throw conflict('The slot creation end date has passed; update the timeline first');
      }
    }

    if (to === 'Booking Open') {
      const { rows: [r] } = await c.query(
        `SELECT COALESCE((SELECT sum(weightage) FROM rubric_criteria WHERE exam_id = $1), 0)::float AS weight,
                (SELECT count(*)::int FROM slots WHERE exam_id = $1 AND status = 'Available'
                   AND (slot_date + start_time) > LOCALTIMESTAMP) AS open_slots`,
        [examId],
      );
      if (Math.abs(r.weight - 100) > 0.001) throw conflict(`Rubric weightages must total 100 before booking opens (currently ${r.weight})`);
      if (r.open_slots === 0) throw conflict('There are no available future slots to book');
      if (exam.booking_end && new Date(exam.booking_end) < now) {
        throw conflict('The booking end date has passed; update the timeline first');
      }
    }

    if (to === 'Completed') {
      const { rows: [r] } = await c.query(
        "SELECT count(*)::int AS pending FROM bookings WHERE exam_id = $1 AND status = 'Booked'", [examId],
      );
      if (r.pending > 0) throw conflict(`${r.pending} booking(s) are still awaiting evaluation`);
      await c.query(
        "UPDATE slots SET status = 'Completed' WHERE exam_id = $1 AND status IN ('Available', 'Full')", [examId],
      );
    }

    if (exam.status === 'Completed' && to === 'Closed' && exam.results_published) {
      throw conflict('Unpublish the results before re-opening a completed examination');
    }

    const { rows: [updated] } = await c.query(
      'UPDATE examinations SET status = $2 WHERE id = $1 RETURNING *', [examId, to],
    );
    await c.query(
      'INSERT INTO exam_status_history (exam_id, from_status, to_status, actor_id, note) VALUES ($1, $2, $3, $4, $5)',
      [examId, exam.status, to, actorId, note || null],
    );

    if (to === 'Slot Creation') {
      await c.query(
        `INSERT INTO notifications (user_id, title, message, link)
         SELECT examiner_id, 'Slot creation is open', $2, '/examiner/exams/' || $1::bigint
           FROM exam_examiners WHERE exam_id = $1`,
        [examId, `You can now create slots for "${exam.name}".`],
      );
    }
    return updated;
  });
  await invalidate('exams', 'slots');
  return result;
}

async function setPublished({ examId, publish, actorId }) {
  const result = await withTransaction(async (c) => {
    const exam = await lockExam(c, examId);
    if (publish) {
      if (exam.results_published) throw conflict('Results are already published');
      if (!['Closed', 'Completed'].includes(exam.status)) throw conflict('Close booking before publishing results');
      const { rows: [r] } = await c.query(
        `SELECT
           (SELECT count(*)::int FROM bookings WHERE exam_id = $1 AND status = 'Booked') AS pending,
           (SELECT count(*)::int FROM evaluations WHERE exam_id = $1 AND status = 'Draft') AS drafts,
           (SELECT count(*)::int FROM evaluations WHERE exam_id = $1 AND status <> 'Draft') AS evaluated`,
        [examId],
      );
      if (r.pending > 0 || r.drafts > 0) {
        throw conflict(`Cannot publish: ${r.pending} booking(s) not yet evaluated, ${r.drafts} evaluation(s) still in draft`);
      }
      if (r.evaluated === 0) throw conflict('There are no evaluations to publish');
    } else if (!exam.results_published) {
      throw conflict('Results are not published');
    }

    const { rows: [updated] } = await c.query(
      `UPDATE examinations SET results_published = $2, results_published_at = CASE WHEN $2 THEN now() END
        WHERE id = $1 RETURNING *`,
      [examId, publish],
    );
    await c.query(
      'INSERT INTO exam_status_history (exam_id, from_status, to_status, actor_id, note) VALUES ($1, $2, $2, $3, $4)',
      [examId, exam.status, actorId, publish ? 'Results published' : 'Results unpublished'],
    );
    if (publish) {
      await c.query(
        `INSERT INTO notifications (user_id, title, message, link)
         SELECT student_id, 'Results published', $2, '/student/results'
           FROM evaluations WHERE exam_id = $1 AND status <> 'Draft'`,
        [examId, `Results for "${exam.name}" are now available.`],
      );
    }
    return updated;
  });
  await invalidate('exams');
  return result;
}

/** Rubric edits are serialised on the exam row so concurrent edits cannot push weightage past 100. */
async function rubricWrite({ examId, criterionId, data, remove = false }) {
  const result = await withTransaction(async (c) => {
    let targetExamId = examId;
    if (criterionId) {
      const { rows: [cr] } = await c.query('SELECT exam_id FROM rubric_criteria WHERE id = $1', [criterionId]);
      if (!cr) throw notFound('Rubric criterion');
      targetExamId = cr.exam_id;
    }
    const exam = await lockExam(c, targetExamId);
    if (exam.status === 'Completed') throw conflict('The rubric of a completed examination cannot be changed');
    const { rows: [ev] } = await c.query('SELECT count(*)::int AS n FROM evaluations WHERE exam_id = $1', [targetExamId]);
    if (ev.n > 0) throw conflict('The rubric is locked because evaluations have already been recorded');

    if (remove) {
      await c.query('DELETE FROM rubric_criteria WHERE id = $1', [criterionId]);
      return null;
    }

    const { rows: [w] } = await c.query(
      'SELECT COALESCE(sum(weightage), 0)::float AS total FROM rubric_criteria WHERE exam_id = $1 AND id <> $2',
      [targetExamId, criterionId || 0],
    );
    let current = null;
    if (criterionId) {
      current = (await c.query('SELECT * FROM rubric_criteria WHERE id = $1', [criterionId])).rows[0];
    }
    const next = { ...(current || {}), ...data };
    if (w.total + Number(next.weightage) > 100.001) {
      throw badRequest(`Total weightage would be ${w.total + Number(next.weightage)}; it cannot exceed 100`);
    }
    if (criterionId) {
      const { rows: [r] } = await c.query(
        `UPDATE rubric_criteria SET criterion_name = $2, max_marks = $3, weightage = $4, description = $5, position = $6
          WHERE id = $1 RETURNING *`,
        [criterionId, next.criterion_name, next.max_marks, next.weightage, next.description ?? null, next.position ?? 0],
      );
      return r;
    }
    const { rows: [r] } = await c.query(
      `INSERT INTO rubric_criteria (exam_id, criterion_name, max_marks, weightage, description, position)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, (SELECT COALESCE(max(position), 0) + 1 FROM rubric_criteria WHERE exam_id = $1)))
       RETURNING *`,
      [targetExamId, next.criterion_name, next.max_marks, next.weightage, next.description ?? null, next.position ?? null],
    );
    return r;
  });
  await invalidate('rubrics', 'exams');
  return result;
}

module.exports = { TRANSITIONS, transitionStatus, setPublished, rubricWrite, lockExam };

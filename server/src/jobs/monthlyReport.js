/**
 * Scheduled job — monthly examination report (HTML email to the admin),
 * plus the queries behind the admin "Reports" screen.
 * The report for a month is stored once in monthly_reports (PRIMARY KEY on the
 * month), so the scheduled run is idempotent; an admin can force a re-run.
 */
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const config = require('../config');
const { sendEmail, escapeHtml } = require('../lib/messaging');

async function monthStart(month) {
  if (month) return `${month}-01`;
  const { rows: [r] } = await query("SELECT to_char(date_trunc('month', CURRENT_DATE) - interval '1 month', 'YYYY-MM-DD') AS d");
  return r.d;
}

async function monthlyStats(start) {
  const p = [start];
  const M = "$1::date AS start, ($1::date + interval '1 month')::date AS stop";
  const [summary, examiners, exams] = await Promise.all([
    query(
      `WITH m AS (SELECT ${M})
       SELECT
        (SELECT count(DISTINCT b.exam_id)::int FROM bookings b JOIN slots s ON s.id = b.slot_id, m
          WHERE b.status = 'Completed' AND s.slot_date >= m.start AND s.slot_date < m.stop) AS exams_conducted,
        (SELECT count(DISTINCT ev.student_id)::int FROM evaluations ev, m
          WHERE ev.status = 'Submitted' AND ev.evaluated_at >= m.start AND ev.evaluated_at < m.stop) AS students_evaluated,
        (SELECT count(*)::int FROM evaluations ev, m
          WHERE ev.status IN ('Submitted', 'Absent') AND ev.evaluated_at >= m.start AND ev.evaluated_at < m.stop) AS evaluations_recorded,
        (SELECT count(*)::int FROM bookings b JOIN slots s ON s.id = b.slot_id, m
          WHERE b.status = 'Completed' AND s.slot_date >= m.start AND s.slot_date < m.stop) AS completed_bookings,
        (SELECT count(*)::int FROM bookings b, m WHERE b.booked_at >= m.start AND b.booked_at < m.stop) AS new_bookings,
        (SELECT count(*)::int FROM bookings b, m
          WHERE b.status = 'Cancelled' AND b.cancelled_at >= m.start AND b.cancelled_at < m.stop) AS cancellations,
        (SELECT count(*)::int FROM bookings b JOIN slots s ON s.id = b.slot_id
          LEFT JOIN evaluations ev ON ev.booking_id = b.id, m
          WHERE b.status = 'Booked' AND (ev.id IS NULL OR ev.status = 'Draft')
            AND s.slot_date < m.stop AND (s.slot_date + s.start_time) <= LOCALTIMESTAMP) AS pending_evaluations,
        (SELECT count(*)::int FROM users u, m WHERE u.role = 'student' AND u.created_at >= m.start AND u.created_at < m.stop) AS new_students,
        (SELECT round(avg(ev.total_marks), 2)::float FROM evaluations ev, m
          WHERE ev.status = 'Submitted' AND ev.evaluated_at >= m.start AND ev.evaluated_at < m.stop) AS average_marks`,
      p,
    ),
    query(
      `WITH m AS (SELECT ${M})
       SELECT u.full_name, ep.department,
              count(*) FILTER (WHERE ev.status = 'Submitted')::int AS evaluations,
              count(*) FILTER (WHERE ev.status = 'Absent')::int AS absences,
              count(DISTINCT b.slot_id)::int AS slots,
              round(avg(ev.total_marks) FILTER (WHERE ev.status = 'Submitted'), 1)::float AS average_marks
         FROM evaluations ev
         JOIN users u ON u.id = ev.examiner_id
         JOIN examiner_profiles ep ON ep.user_id = u.id
         JOIN bookings b ON b.id = ev.booking_id, m
        WHERE ev.status <> 'Draft' AND ev.evaluated_at >= m.start AND ev.evaluated_at < m.stop
        GROUP BY u.id, u.full_name, ep.department
        ORDER BY evaluations DESC, slots DESC
        LIMIT 5`,
      p,
    ),
    query(
      `WITH m AS (SELECT ${M})
       SELECT e.name, c.code,
              count(b.id) FILTER (WHERE b.status <> 'Cancelled')::int AS bookings,
              count(ev.id) FILTER (WHERE ev.status = 'Submitted')::int AS evaluated,
              count(ev.id) FILTER (WHERE ev.status = 'Absent')::int AS absent,
              round(avg(ev.total_marks) FILTER (WHERE ev.status = 'Submitted'), 1)::float AS average_marks,
              count(ev.id) FILTER (WHERE ev.status = 'Submitted' AND ev.total_marks >= e.pass_marks)::int AS passed
         FROM bookings b
         JOIN slots s ON s.id = b.slot_id
         JOIN examinations e ON e.id = b.exam_id
         JOIN courses c ON c.id = e.course_id
         LEFT JOIN evaluations ev ON ev.booking_id = b.id, m
        WHERE s.slot_date >= m.start AND s.slot_date < m.stop
        GROUP BY e.id, e.name, c.code
        ORDER BY bookings DESC
        LIMIT 25`,
      p,
    ),
  ]);
  return { summary: summary.rows[0], examiners: examiners.rows, exams: exams.rows };
}

function renderReport(start, stats) {
  const monthLabel = new Date(`${start}T00:00:00Z`).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const s = stats.summary;
  const card = (label, value) => `<td style="padding:14px;background:#f2f5fa;border-radius:6px;text-align:center;width:25%">
      <div style="font-size:24px;font-weight:bold;color:#1f3a5f">${value ?? '—'}</div><div style="color:#555;font-size:12px">${label}</div></td>`;
  const th = (h) => `<th style="text-align:left;padding:8px;border-bottom:2px solid #1f3a5f">${h}</th>`;
  const td = (v) => `<td style="padding:8px;border-bottom:1px solid #e3e7ee">${escapeHtml(v ?? '—')}</td>`;
  const examinerRows = stats.examiners.map((x, i) => `<tr>${td(i + 1)}${td(x.full_name)}${td(x.department)}${td(x.evaluations)}${td(x.slots)}${td(x.average_marks)}</tr>`).join('');
  const examRows = stats.exams.map((x) => `<tr>${td(`${x.code} — ${x.name}`)}${td(x.bookings)}${td(x.evaluated)}${td(x.absent)}${td(x.average_marks)}${td(x.evaluated ? `${Math.round((x.passed / x.evaluated) * 100)}%` : '—')}</tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>EMP monthly report — ${monthLabel}</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:820px;margin:auto;padding:16px">
  <h1 style="color:#1f3a5f;margin-bottom:4px">Monthly examination report</h1>
  <div style="color:#666;margin-bottom:20px">${monthLabel} · generated ${new Date().toLocaleString('en-IN', { timeZone: config.tz })}</div>
  <table style="width:100%;border-spacing:8px"><tr>
    ${card('Examinations conducted', s.exams_conducted)}${card('Students evaluated', s.students_evaluated)}
    ${card('Completed bookings', s.completed_bookings)}${card('Pending evaluations', s.pending_evaluations)}
  </tr><tr>
    ${card('New bookings', s.new_bookings)}${card('Cancellations', s.cancellations)}
    ${card('Average marks', s.average_marks)}${card('New students', s.new_students)}
  </tr></table>
  <h2 style="color:#1f3a5f">Most active examiners</h2>
  <table style="width:100%;border-collapse:collapse"><tr>${th('#')}${th('Examiner')}${th('Department')}${th('Evaluations')}${th('Slots')}${th('Avg marks')}</tr>
  ${examinerRows || `<tr>${td('No evaluations this month')}</tr>`}</table>
  <h2 style="color:#1f3a5f">Examinations this month</h2>
  <table style="width:100%;border-collapse:collapse"><tr>${th('Examination')}${th('Bookings')}${th('Evaluated')}${th('Absent')}${th('Avg')}${th('Pass rate')}</tr>
  ${examRows || `<tr>${td('No examinations held this month')}</tr>`}</table>
  <p style="color:#888;font-size:12px;margin-top:24px">Examination Management Portal — automated report</p>
</body></html>`;
}

async function sendMonthlyReport({ month, force = false } = {}) {
  const start = await monthStart(month);
  const stats = await monthlyStats(start);
  const html = renderReport(start, stats);
  const { rows: [admin] } = await query("SELECT email FROM users WHERE role = 'admin'");

  const sql = force
    ? `INSERT INTO monthly_reports (report_month, sent_to, html) VALUES ($1, $2, $3)
       ON CONFLICT (report_month) DO UPDATE SET html = EXCLUDED.html, sent_to = EXCLUDED.sent_to, created_at = now()
       RETURNING report_month`
    : `INSERT INTO monthly_reports (report_month, sent_to, html) VALUES ($1, $2, $3)
       ON CONFLICT (report_month) DO NOTHING RETURNING report_month`;
  const { rows } = await query(sql, [start, admin ? admin.email : null, html]);
  if (!rows.length) return { skipped: true, month: start.slice(0, 7) };

  const dir = path.join(path.dirname(config.exportDir), 'reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `monthly-report-${start.slice(0, 7)}.html`), html, 'utf8');

  if (admin) {
    await sendEmail({ to: admin.email, subject: `EMP monthly examination report — ${start.slice(0, 7)}`, html });
  }
  if (!config.isTest) console.log('[job:monthly-report] sent for', start.slice(0, 7));
  return { month: start.slice(0, 7), summary: stats.summary };
}

/** Data for the admin Reports screen. */
async function buildOverview({ months = 6 } = {}) {
  const [trend, exams, examiners, bookingStatus, examTypes] = await Promise.all([
    // one GROUP BY per table instead of a correlated sub-query per month
    query(
      `WITH months AS (
         SELECT generate_series(date_trunc('month', CURRENT_DATE) - ($1::int - 1) * interval '1 month',
                                date_trunc('month', CURRENT_DATE), interval '1 month') AS m
       ), since AS (SELECT min(m) AS m FROM months),
       b AS (SELECT date_trunc('month', booked_at) AS m, count(*) AS n FROM bookings, since
              WHERE booked_at >= since.m GROUP BY 1),
       ev AS (SELECT date_trunc('month', evaluated_at) AS m, count(*) AS n FROM evaluations, since
              WHERE status = 'Submitted' AND evaluated_at >= since.m GROUP BY 1),
       c AS (SELECT date_trunc('month', cancelled_at) AS m, count(*) AS n FROM bookings, since
              WHERE status = 'Cancelled' AND cancelled_at >= since.m GROUP BY 1)
       SELECT to_char(months.m, 'YYYY-MM') AS month, COALESCE(b.n, 0)::int AS bookings,
              COALESCE(ev.n, 0)::int AS evaluations, COALESCE(c.n, 0)::int AS cancellations
         FROM months LEFT JOIN b USING (m) LEFT JOIN ev USING (m) LEFT JOIN c USING (m)
        ORDER BY months.m`,
      [months],
    ),
    query(
      `SELECT e.id, e.name, e.exam_type, e.status, e.results_published, c.code AS course_code,
              count(b.id) FILTER (WHERE b.status <> 'Cancelled')::int AS bookings,
              count(ev.id) FILTER (WHERE ev.status = 'Submitted')::int AS evaluated,
              count(b.id) FILTER (WHERE b.status = 'Booked')::int AS pending,
              round(avg(ev.total_marks) FILTER (WHERE ev.status = 'Submitted'), 1)::float AS average_marks,
              round(100.0 * count(ev.id) FILTER (WHERE ev.status = 'Submitted' AND ev.total_marks >= e.pass_marks)
                    / NULLIF(count(ev.id) FILTER (WHERE ev.status = 'Submitted'), 0), 1)::float AS pass_rate
         FROM examinations e JOIN courses c ON c.id = e.course_id
         LEFT JOIN bookings b ON b.exam_id = e.id
         LEFT JOIN evaluations ev ON ev.booking_id = b.id
        GROUP BY e.id, c.code
        HAVING count(b.id) > 0
        ORDER BY e.id DESC
        LIMIT 60`,
    ),
    query(
      `SELECT u.id, u.full_name, ep.department,
              (SELECT count(*)::int FROM slots s WHERE s.examiner_id = u.id AND s.status <> 'Cancelled') AS slots,
              (SELECT count(*)::int FROM evaluations ev WHERE ev.examiner_id = u.id AND ev.status = 'Submitted') AS evaluations,
              (SELECT count(*)::int FROM bookings b JOIN slots s ON s.id = b.slot_id LEFT JOIN evaluations ev ON ev.booking_id = b.id
                WHERE s.examiner_id = u.id AND b.status = 'Booked' AND (ev.id IS NULL OR ev.status = 'Draft')
                  AND (s.slot_date + s.start_time) <= LOCALTIMESTAMP) AS pending
         FROM users u JOIN examiner_profiles ep ON ep.user_id = u.id
        ORDER BY evaluations DESC LIMIT 10`,
    ),
    query('SELECT status, count(*)::int AS count FROM bookings GROUP BY status ORDER BY status'),
    query('SELECT exam_type, count(*)::int AS count FROM examinations GROUP BY exam_type ORDER BY exam_type'),
  ]);
  return {
    trend: trend.rows, exams: exams.rows, examiners: examiners.rows,
    booking_status: bookingStatus.rows, exam_types: examTypes.rows,
  };
}

module.exports = { sendMonthlyReport, monthlyStats, renderReport, buildOverview };

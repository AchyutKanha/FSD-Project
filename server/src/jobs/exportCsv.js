/**
 * User-triggered async job — export a student's examination history as CSV.
 * The job row is claimed with a conditional UPDATE, so a retried or duplicated
 * job never processes the same export twice.
 */
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const config = require('../config');
const { sendEmail } = require('../lib/messaging');
const { notify } = require('../lib/notify');

const HEADERS = [
  'Student ID', 'Roll Number', 'Student Name', 'Examination Name', 'Examination Type', 'Course Code', 'Course',
  'Examination Date', 'Start Time', 'End Time', 'Examiner', 'Booking Status', 'Attendance',
  'Marks Obtained', 'Maximum Marks', 'Result', 'Remarks',
];

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;           // defuse spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => [HEADERS, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

async function historyRows(studentId) {
  const { rows } = await query(
    `SELECT u.id, sp.roll_number, u.full_name, e.name, e.exam_type, c.code, c.name AS course_name,
            s.slot_date, to_char(s.start_time, 'HH24:MI') AS start_time, to_char(s.end_time, 'HH24:MI') AS end_time,
            x.full_name AS examiner, b.status, b.attendance, e.results_published, e.max_marks, e.pass_marks,
            ev.status AS ev_status, ev.total_marks, ev.remarks
       FROM bookings b
       JOIN users u ON u.id = b.student_id
       JOIN student_profiles sp ON sp.user_id = u.id
       JOIN examinations e ON e.id = b.exam_id
       JOIN courses c ON c.id = e.course_id
       JOIN slots s ON s.id = b.slot_id
       JOIN users x ON x.id = s.examiner_id
       LEFT JOIN evaluations ev ON ev.booking_id = b.id
      WHERE b.student_id = $1
      ORDER BY s.slot_date, s.start_time`,
    [studentId],
  );
  return rows.map((r) => {
    const published = r.results_published && r.ev_status && r.ev_status !== 'Draft';
    let result = 'Pending';
    if (published) result = r.ev_status === 'Absent' ? 'Absent' : (r.total_marks >= r.pass_marks ? 'Pass' : 'Fail');
    if (r.status === 'Cancelled') result = 'Cancelled';
    return [
      r.id, r.roll_number, r.full_name, r.name, r.exam_type, r.code, r.course_name, r.slot_date, r.start_time, r.end_time,
      r.examiner, r.status, r.attendance, published ? r.total_marks : (r.status === 'Cancelled' ? '' : 'Not published'),
      r.max_marks, result, published ? r.remarks : '',
    ];
  });
}

async function runExportJob(exportJobId) {
  const { rows: [job] } = await query(
    "UPDATE export_jobs SET status = 'Processing', error = NULL WHERE id = $1 AND status IN ('Queued', 'Failed') RETURNING *",
    [exportJobId],
  );
  if (!job) return { skipped: true };   // already processed by another attempt

  try {
    const rows = await historyRows(job.user_id);
    fs.mkdirSync(config.exportDir, { recursive: true });
    const fileName = `exam-history-${job.user_id}-${job.id}.csv`;
    const csv = `﻿${toCsv(rows)}\r\n`;    // BOM so Excel opens UTF-8 correctly
    fs.writeFileSync(path.join(config.exportDir, fileName), csv, 'utf8');

    await query(
      "UPDATE export_jobs SET status = 'Completed', file_name = $2, row_count = $3, completed_at = now() WHERE id = $1",
      [job.id, fileName, rows.length],
    );
    await notify({ query }, job.user_id, 'Your export is ready',
      `Examination history CSV with ${rows.length} record(s) is ready to download.`, '/student/history');

    const { rows: [u] } = await query('SELECT email, full_name FROM users WHERE id = $1', [job.user_id]);
    await sendEmail({
      to: u.email,
      subject: 'Your examination history export is ready',
      html: `<p>Dear ${u.full_name},</p><p>Your examination history export (${rows.length} records) is attached and also available on your dashboard.</p>`,
      attachments: [{ filename: fileName, content: csv }],
    }).catch((e) => console.warn('[export] email failed:', e.message));

    return { fileName, rows: rows.length };
  } catch (err) {
    await query("UPDATE export_jobs SET status = 'Failed', error = $2 WHERE id = $1", [job.id, String(err.message).slice(0, 500)]);
    await notify({ query }, job.user_id, 'Export failed', 'Your examination history export failed. Please try again.', '/student/history');
    throw err;
  }
}

module.exports = { runExportJob, toCsv, HEADERS, historyRows };

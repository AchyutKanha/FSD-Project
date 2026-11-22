/**
 * Scheduled job — daily examination reminders (Google Chat webhook + email).
 *
 * Idempotent: before sending on a channel, the job claims
 * (booking, channel, today) in reminder_log with INSERT ... ON CONFLICT DO NOTHING.
 * A retried job, or two workers running at once, can never send twice.
 * If sending fails the claim is released so the retry can try again.
 */
const { query } = require('../db');
const config = require('../config');
const { sendEmail, sendGoogleChat, escapeHtml } = require('../lib/messaging');

async function claim(bookingId, channel) {
  const { rows } = await query(
    `INSERT INTO reminder_log (booking_id, channel, sent_on) VALUES ($1, $2, CURRENT_DATE)
     ON CONFLICT DO NOTHING RETURNING booking_id`,
    [bookingId, channel],
  );
  return rows.length === 1;
}
const release = (bookingId, channel) => query(
  'DELETE FROM reminder_log WHERE booking_id = $1 AND channel = $2 AND sent_on = CURRENT_DATE', [bookingId, channel],
);

function textMessage(r) {
  const where = r.meeting_link ? `Online: ${r.meeting_link}` : (r.venue ? `Venue: ${r.venue}` : '');
  return [
    `*Examination reminder* for ${r.full_name} (${r.roll_number})`,
    `Examination: ${r.exam_name} (${r.exam_type}) — ${r.course_code} ${r.course_name}`,
    `Date & time: ${r.slot_date}, ${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`,
    `Examiner: ${r.examiner_name}`,
    where,
    r.instructions ? `Instructions: ${r.instructions}` : '',
  ].filter(Boolean).join('\n');
}

function htmlMessage(r) {
  const row = (k, v) => `<tr><td style="padding:6px 12px;color:#555">${k}</td><td style="padding:6px 12px"><b>${escapeHtml(v)}</b></td></tr>`;
  return `<div style="font-family:Arial,sans-serif;max-width:560px">
    <h2 style="color:#1f3a5f">Upcoming examination</h2>
    <p>Dear ${escapeHtml(r.full_name)}, this is a reminder of your examination.</p>
    <table style="border-collapse:collapse;background:#f6f8fb">
      ${row('Examination', `${r.exam_name} (${r.exam_type})`)}
      ${row('Course', `${r.course_code} — ${r.course_name}`)}
      ${row('Date', r.slot_date)}
      ${row('Time', `${r.start_time.slice(0, 5)} – ${r.end_time.slice(0, 5)}`)}
      ${row('Examiner', r.examiner_name)}
      ${r.venue ? row('Venue', r.venue) : ''}
      ${r.meeting_link ? row('Meeting link', r.meeting_link) : ''}
    </table>
    ${r.instructions ? `<h3>Instructions</h3><p>${escapeHtml(r.instructions)}</p>` : ''}
    <p style="color:#888;font-size:12px">Examination Management Portal</p></div>`;
}

async function sendDailyReminders() {
  const { rows } = await query(
    `SELECT b.id AS booking_id, u.full_name, u.email, sp.roll_number, sp.gchat_webhook_url, sp.email_reminders,
            e.name AS exam_name, e.exam_type, e.instructions, c.code AS course_code, c.name AS course_name,
            s.slot_date, s.start_time::text, s.end_time::text, s.meeting_link, s.venue, x.full_name AS examiner_name
       FROM bookings b
       JOIN users u ON u.id = b.student_id
       JOIN student_profiles sp ON sp.user_id = u.id
       JOIN slots s ON s.id = b.slot_id
       JOIN examinations e ON e.id = b.exam_id
       JOIN courses c ON c.id = e.course_id
       JOIN users x ON x.id = s.examiner_id
      WHERE b.status = 'Booked' AND u.is_active AND s.status IN ('Available', 'Full')
        AND s.slot_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int
        AND (s.slot_date + s.start_time) > LOCALTIMESTAMP
      ORDER BY s.slot_date, s.start_time`,
    [config.reminderDaysAhead],
  );

  const result = { bookings: rows.length, email: 0, gchat: 0, skipped: 0, failed: 0 };
  for (const r of rows) {
    const webhook = r.gchat_webhook_url || config.gchatWebhookUrl;
    if (webhook) {
      if (await claim(r.booking_id, 'gchat')) {
        try { await sendGoogleChat(webhook, textMessage(r)); result.gchat += 1; } catch (e) {
          result.failed += 1; await release(r.booking_id, 'gchat');
        }
      } else result.skipped += 1;
    }
    if (r.email_reminders) {
      if (await claim(r.booking_id, 'email')) {
        try {
          await sendEmail({ to: r.email, subject: `Reminder: ${r.exam_name} on ${r.slot_date}`, html: htmlMessage(r), text: textMessage(r) });
          result.email += 1;
        } catch (e) {
          result.failed += 1; await release(r.booking_id, 'email');
        }
      } else result.skipped += 1;
    }
  }
  if (!config.isTest) console.log('[job:daily-reminders]', result);
  return result;
}

module.exports = { sendDailyReminders, textMessage };

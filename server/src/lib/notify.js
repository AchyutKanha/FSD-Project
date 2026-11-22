/** Insert an in-app notification using the caller's transaction client (or the pool). */
async function notify(db, userId, title, message, link = null) {
  await db.query(
    'INSERT INTO notifications (user_id, title, message, link) VALUES ($1, $2, $3, $4)',
    [userId, title, message, link],
  );
}

const fmtSlot = (s) => `${s.slot_date} ${String(s.start_time).slice(0, 5)}–${String(s.end_time).slice(0, 5)}`;

module.exports = { notify, fmtSlot };

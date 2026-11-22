const express = require('express');
const { query } = require('../db');
const { validate } = require('../middleware/validate');
const { notFound } = require('../lib/errors');
const { z, idParam } = require('../lib/http');
const { remember } = require('../lib/cache');
const config = require('../config');

const router = express.Router();

// Lists used by filter dropdowns on every role's screens
router.get('/options', async (_req, res) => {
  const data = await remember('exams', 'options', config.cacheTtl.exams, async () => {
    const { rows: courses } = await query(
      "SELECT id, code, name, status FROM courses ORDER BY code",
    );
    return {
      courses,
      exam_types: ['Viva', 'Practical', 'Project Demo', 'Assessment'],
      exam_statuses: ['Draft', 'Slot Creation', 'Booking Open', 'Closed', 'Completed'],
      slot_statuses: ['Available', 'Full', 'Cancelled', 'Completed'],
      booking_statuses: ['Booked', 'Cancelled', 'Completed'],
    };
  });
  res.json(data);
});

router.get('/notifications', validate({ query: z.object({ unread: z.enum(['true', 'false']).optional() }) }), async (req, res) => {
  const unreadOnly = req.valid.query.unread === 'true';
  const { rows } = await query(
    `SELECT id, title, message, link, is_read, created_at FROM notifications
      WHERE user_id = $1 ${unreadOnly ? 'AND NOT is_read' : ''}
      ORDER BY created_at DESC LIMIT 50`,
    [req.user.id],
  );
  const { rows: [c] } = await query('SELECT count(*)::int AS unread FROM notifications WHERE user_id = $1 AND NOT is_read', [req.user.id]);
  res.json({ items: rows, unread: c.unread });
});

router.post('/notifications/:id/read', validate({ params: idParam }), async (req, res) => {
  const { rowCount } = await query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [req.valid.params.id, req.user.id]);
  if (!rowCount) throw notFound('Notification');
  res.status(204).end();
});

router.post('/notifications/read-all', async (req, res) => {
  await query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND NOT is_read', [req.user.id]);
  res.status(204).end();
});

module.exports = router;

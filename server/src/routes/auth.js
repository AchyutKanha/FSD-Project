const express = require('express');
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../db');
const { validate } = require('../middleware/validate');
const { authenticate, signToken } = require('../middleware/auth');
const { unauthorized, forbidden, badRequest } = require('../lib/errors');
const { z, email, password, phone, optionalText } = require('../lib/http');

const router = express.Router();
const BCRYPT_ROUNDS = 10;

async function loadUser(id) {
  const { rows: [u] } = await query(
    `SELECT u.id, u.email, u.full_name, u.role, u.is_active, u.created_at, u.last_login_at,
            CASE u.role
              WHEN 'student' THEN (SELECT to_jsonb(sp) - 'user_id' - 'user_role' FROM student_profiles sp WHERE sp.user_id = u.id)
              WHEN 'examiner' THEN (SELECT to_jsonb(ep) - 'user_id' - 'user_role' FROM examiner_profiles ep WHERE ep.user_id = u.id)
            END AS profile
       FROM users u WHERE u.id = $1`,
    [id],
  );
  return u;
}

// Students self-register. There is no way to choose a role: the schema is strict,
// so a body containing "role" is rejected with 400.
const registerSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  email,
  password,
  roll_number: z.string().trim().regex(/^[A-Za-z0-9-]{3,20}$/, '3-20 letters, digits or hyphens'),
  phone: phone.optional(),
  department: optionalText(100),
  program: optionalText(100),
  year_of_study: z.coerce.number().int().min(1).max(6).optional(),
}).strict();

router.post('/register', validate({ body: registerSchema }), async (req, res) => {
  const b = req.valid.body;
  const hash = await bcrypt.hash(b.password, BCRYPT_ROUNDS);
  const userId = await withTransaction(async (c) => {
    const { rows: [u] } = await c.query(
      "INSERT INTO users (email, password_hash, full_name, role) VALUES ($1, $2, $3, 'student') RETURNING id",
      [b.email, hash, b.full_name],
    );
    await c.query(
      `INSERT INTO student_profiles (user_id, roll_number, phone, department, program, year_of_study)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [u.id, b.roll_number.toUpperCase(), b.phone || null, b.department || null, b.program || null, b.year_of_study || null],
    );
    return u.id;
  });
  const user = await loadUser(userId);
  res.status(201).json({ token: signToken(user), user });
});

const loginSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();

router.post('/login', validate({ body: loginSchema }), async (req, res) => {
  const { email: em, password: pw } = req.valid.body;
  const { rows: [u] } = await query('SELECT id, role, password_hash, is_active FROM users WHERE lower(email) = $1', [em]);
  // Same message for unknown email and wrong password, so accounts cannot be enumerated.
  if (!u || !(await bcrypt.compare(pw, u.password_hash))) throw unauthorized('Invalid email or password');
  if (!u.is_active) throw forbidden('Your account has been deactivated. Contact the administrator.');
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
  const user = await loadUser(u.id);
  res.json({ token: signToken(user), user });
});

router.get('/me', authenticate, async (req, res) => {
  res.json({ user: await loadUser(req.user.id) });
});

const changePasswordSchema = z.object({ current_password: z.string().min(1), new_password: password }).strict();

router.post('/change-password', authenticate, validate({ body: changePasswordSchema }), async (req, res) => {
  const { current_password: cur, new_password: next } = req.valid.body;
  const { rows: [u] } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(cur, u.password_hash))) throw badRequest('Current password is incorrect');
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await bcrypt.hash(next, BCRYPT_ROUNDS)]);
  res.json({ message: 'Password changed' });
});

module.exports = { router, loadUser, BCRYPT_ROUNDS };

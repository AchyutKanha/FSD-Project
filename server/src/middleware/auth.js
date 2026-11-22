const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');
const { unauthorized, forbidden } = require('../lib/errors');

function signToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

/**
 * Verifies the Bearer token AND re-reads the user, so a deactivated account
 * or a changed role stops working immediately rather than when the token expires.
 */
async function authenticate(req, _res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized());

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return next(unauthorized('Your session is invalid or has expired. Please log in again.'));
  }

  const { rows } = await query(
    'SELECT id, email, full_name, role, is_active FROM users WHERE id = $1',
    [Number(payload.sub)],
  );
  const user = rows[0];
  if (!user || user.role !== payload.role) return next(unauthorized('Account not found'));
  if (!user.is_active) return next(forbidden('Your account has been deactivated'));
  req.user = user;
  return next();
}

const requireRole = (...roles) => (req, _res, next) => (
  req.user && roles.includes(req.user.role) ? next() : next(forbidden())
);

module.exports = { signToken, authenticate, requireRole };

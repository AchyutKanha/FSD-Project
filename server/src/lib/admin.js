const bcrypt = require('bcryptjs');
const config = require('../config');
const { query } = require('../db');

/**
 * Create the single admin if it does not exist. Safe to call on every start:
 * the unique index users_single_admin_uq makes a second admin impossible,
 * even if two server processes start at the same moment.
 */
async function ensureAdmin() {
  const { rows: [existing] } = await query("SELECT id, email FROM users WHERE role = 'admin'");
  if (existing) return { created: false, email: existing.email };
  const hash = await bcrypt.hash(config.admin.password, 10);
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, role) VALUES ($1, $2, $3, 'admin')
     ON CONFLICT DO NOTHING RETURNING id`,
    [config.admin.email.toLowerCase(), hash, config.admin.name],
  );
  return { created: rows.length === 1, email: config.admin.email };
}

module.exports = { ensureAdmin };

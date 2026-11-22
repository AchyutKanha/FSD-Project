/**
 * npm run db:seed  -> creates the admin, then loads the volume seed (db/seed.sql).
 * Refuses to run twice; use `npm run db:reset` first to start over.
 */
const fs = require('fs');
const path = require('path');
const { pool, query } = require('../src/db');
const { ensureAdmin } = require('../src/lib/admin');

async function main() {
  const admin = await ensureAdmin();
  console.log(admin.created ? `Admin created: ${admin.email}` : `Admin exists: ${admin.email}`);

  const { rows: [c] } = await query('SELECT count(*)::int AS n FROM courses');
  if (c.n > 0) {
    console.log('Seed data already present — nothing to do. (npm run db:reset && npm run db:seed to reload)');
    return;
  }
  const started = Date.now();
  const sql = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
  const results = await pool.query(sql);       // multi-statement, runs in the BEGIN/COMMIT inside the file
  const last = Array.isArray(results) ? results[results.length - 1] : results;
  console.table(last.rows);
  console.log(`Seed loaded in ${((Date.now() - started) / 1000).toFixed(1)}s. Every seeded user's password: Password@123`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => { console.error('Seed failed:', err.message); await pool.end(); process.exit(1); });

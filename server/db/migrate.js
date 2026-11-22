/**
 * npm run db:migrate          -> create all tables (fails if they already exist)
 * npm run db:reset            -> DROP everything and recreate (development only!)
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');
const config = require('../src/config');

async function applySchema({ reset = false } = {}) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    if (reset) {
      if (config.env === 'production') throw new Error('Refusing to reset a production database');
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
    await client.query(sql);
  } finally {
    client.release();
  }
}

if (require.main === module) {
  const reset = process.argv.includes('--reset');
  applySchema({ reset })
    .then(() => { console.log(reset ? 'Database reset and schema applied.' : 'Schema applied.'); return pool.end(); })
    .catch(async (err) => {
      console.error('Migration failed:', err.message);
      if (err.code === '42P07') console.error('Tables already exist. Use `npm run db:reset` to start over.');
      await pool.end();
      process.exit(1);
    });
}

module.exports = { applySchema };

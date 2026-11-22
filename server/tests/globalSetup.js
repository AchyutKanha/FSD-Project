// Jest global setup: wipe and recreate the TEST database schema once per run.
module.exports = async () => {
  process.env.NODE_ENV = 'test';
  // eslint-disable-next-line global-require
  const { applySchema } = require('../db/migrate');
  // eslint-disable-next-line global-require
  const { pool } = require('../src/db');
  await applySchema({ reset: true });
  await pool.end();
};

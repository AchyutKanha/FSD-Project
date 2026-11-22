const { Pool, types } = require('pg');
const config = require('./config');

// Type parsers: NUMERIC -> number, BIGINT -> number (ids stay well below 2^53),
// DATE -> 'YYYY-MM-DD' string (avoids JavaScript shifting dates across time zones).
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
types.setTypeParser(1082, (v) => v);

const pool = new Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });

// Every connection works in the institution's time zone, so CURRENT_DATE and
// LOCALTIMESTAMP line up with slot dates/times stored as local values.
pool.on('connect', (client) => {
  client.query(`SET TIME ZONE '${config.tz.replace(/'/g, '')}'`).catch(() => {});
});

const query = (text, params) => pool.query(text, params);

/**
 * Run `fn(client)` inside BEGIN ... COMMIT on one dedicated connection.
 * Any thrown error rolls the whole transaction back, so either every
 * statement in `fn` takes effect or none does.
 * Deadlocks / serialization failures are retried a couple of times.
 */
async function withTransaction(fn, { retries = 2, isolation } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const retryable = err && (err.code === '40P01' || err.code === '40001');
      if (retryable && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { pool, query, withTransaction };

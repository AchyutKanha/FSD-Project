const config = require('./config');
const app = require('./app');
const { ensureAdmin } = require('./lib/admin');

async function start() {
  const admin = await ensureAdmin();
  if (admin.created) console.log(`[startup] admin account created: ${admin.email}`);
  app.listen(config.port, () => console.log(`[startup] EMP API listening on http://localhost:${config.port}`));
}

start().catch((err) => {
  console.error('[startup] failed:', err.message);
  if (err.code === '42P01') console.error('Tables are missing. Run: npm run db:migrate');
  process.exit(1);
});

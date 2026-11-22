// npm run create-admin  — creates the single admin from ADMIN_* in .env (no-op if one exists)
const { pool } = require('../src/db');
const { ensureAdmin } = require('../src/lib/admin');

ensureAdmin()
  .then((r) => console.log(r.created ? `Admin created: ${r.email}` : `An admin already exists (${r.email}); only one is allowed.`))
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => pool.end());

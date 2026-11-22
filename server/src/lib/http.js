const { z } = require('zod');

// ---------- reusable zod pieces ----------
const id = z.coerce.number().int().positive();
const idParam = z.object({ id });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a real date');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:00)?$/, 'Use HH:MM (24-hour)').transform((s) => s.slice(0, 5));
const dateTime = z.string().datetime({ offset: true, message: 'Use an ISO 8601 date-time, e.g. 2026-12-01T09:00:00+05:30' });
const optionalText = (max = 2000) => z.string().trim().max(max).optional().nullable().transform((v) => (v === '' ? null : v));
const httpUrl = z.string().trim().url().regex(/^https?:\/\//, 'Must start with http:// or https://');
const email = z.string().trim().toLowerCase().email().max(200);
const password = z.string().min(8, 'At least 8 characters').max(128)
  .regex(/[A-Za-z]/, 'Must contain a letter').regex(/\d/, 'Must contain a digit');
const phone = z.string().trim().regex(/^\+?[0-9 -]{7,20}$/, 'Invalid phone number');
const boolish = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
};

// ---------- helpers ----------
/** Build a paginated response. `countSql`/`listSql` share `params`; listSql gets LIMIT/OFFSET appended. */
async function paginate(db, { listSql, countSql, params, page, perPage }) {
  const offset = (page - 1) * perPage;
  const [list, count] = await Promise.all([
    db.query(`${listSql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, perPage, offset]),
    db.query(countSql, params),
  ]);
  const total = count.rows[0].total;
  return { items: list.rows, total, page, per_page: perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
}

/** Tiny WHERE builder: where.add('col = ?', value) with automatic $n numbering. */
function whereBuilder(initialParams = []) {
  const clauses = [];
  const params = [...initialParams];
  return {
    add(sql, ...values) {
      let out = sql;
      for (const v of values) { params.push(v); out = out.replace('?', `$${params.length}`); }
      clauses.push(out);
      return this;
    },
    sql() { return clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''; },
    params,
  };
}

const likeTerm = (q) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

module.exports = {
  z, id, idParam, isoDate, hhmm, dateTime, optionalText, httpUrl, email, password, phone, boolish,
  pageQuery, paginate, whereBuilder, likeTerm,
};

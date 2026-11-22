const { badRequest } = require('../lib/errors');

/**
 * validate({ params, query, body }) — each a zod schema.
 * Parsed (coerced, defaulted) values are placed on req.valid.{params,query,body}.
 * Body schemas are declared .strict(), so unknown fields (e.g. "role") are rejected.
 */
const validate = (schemas) => (req, _res, next) => {
  req.valid = req.valid || {};
  const issues = [];
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue;
    const result = schemas[part].safeParse(req[part] ?? {});
    if (result.success) {
      req.valid[part] = result.data;
    } else {
      for (const i of result.error.issues) {
        issues.push({ location: part, field: i.path.join('.') || (i.keys ? i.keys.join(',') : ''), message: i.message });
      }
    }
  }
  if (issues.length) return next(badRequest('Validation failed', issues));
  return next();
};

module.exports = { validate };

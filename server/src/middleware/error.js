const { ApiError, fromPgError } = require('../lib/errors');
const config = require('../config');

function notFoundHandler(req, res) {
  res.status(404).json({ message: `No route for ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Request body is not valid JSON' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Request body is too large' });
  }
  const apiErr = err instanceof ApiError ? err : fromPgError(err);
  if (apiErr) {
    const body = { message: apiErr.message };
    if (apiErr.details) body.errors = apiErr.details;
    return res.status(apiErr.status).json(body);
  }
  if (!config.isTest) console.error(err);
  return res.status(500).json({ message: 'Internal server error' });
}

module.exports = { notFoundHandler, errorHandler };

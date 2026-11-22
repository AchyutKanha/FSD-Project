const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');
const { query } = require('./db');
const { authenticate, requireRole } = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const { cacheStats } = require('./lib/cache');

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.clientOrigin, credentials: false }));
app.use(express.json({ limit: '200kb' }));
if (!config.isTest) app.use(morgan('dev'));

app.get('/api/health', async (_req, res) => {
  await query('SELECT 1');
  res.json({ status: 'ok', cache: cacheStats() });
});

app.use('/api/auth', require('./routes/auth').router);
app.use('/api/admin', authenticate, requireRole('admin'), require('./routes/admin'));
app.use('/api/examiner', authenticate, requireRole('examiner'), require('./routes/examiner'));
app.use('/api/student', authenticate, requireRole('student'), require('./routes/student'));
app.use('/api', authenticate, require('./routes/common')); // notifications, filter options
app.use('/api', notFoundHandler);

// In production, serve the built React app from client/dist
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.use(errorHandler);

module.exports = app;

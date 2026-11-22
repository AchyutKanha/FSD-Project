const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const env = process.env;
const bool = (v, dflt = false) => (v === undefined || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, dflt) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? dflt : parseInt(v, 10));

const isTest = env.NODE_ENV === 'test';

const config = {
  env: env.NODE_ENV || 'development',
  isTest,
  port: int(env.PORT, 4000),
  tz: env.APP_TZ || 'Asia/Kolkata',
  clientOrigin: env.CLIENT_ORIGIN || 'http://localhost:5173',

  databaseUrl: isTest ? (env.TEST_DATABASE_URL || 'postgres://emp:emp@localhost:5432/emp_test') : (env.DATABASE_URL || 'postgres://emp:emp@localhost:5432/emp'),
  dbPoolMax: int(env.DB_POOL_MAX, 20),

  jwtSecret: env.JWT_SECRET || (isTest ? 'test-secret' : ''),
  jwtExpiresIn: env.JWT_EXPIRES_IN || '12h',

  admin: {
    email: env.ADMIN_EMAIL || 'admin@emp.edu',
    password: env.ADMIN_PASSWORD || 'Admin@12345',
    name: env.ADMIN_NAME || 'Portal Administrator',
  },

  // In tests Redis is optional: the cache passes through and jobs run inline.
  redisUrl: isTest ? (env.TEST_REDIS_URL || '') : (env.REDIS_URL || 'redis://localhost:6379'),
  cacheTtl: {
    exams: int(env.CACHE_TTL_EXAMS, 120),
    slots: int(env.CACHE_TTL_SLOTS, 30),
    rubrics: int(env.CACHE_TTL_RUBRICS, 600),
  },

  smtp: {
    host: env.SMTP_HOST || '',
    port: int(env.SMTP_PORT, 1025),
    secure: bool(env.SMTP_SECURE),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'EMP Portal <no-reply@emp.edu>',
  },
  gchatWebhookUrl: env.GCHAT_WEBHOOK_URL || '',

  reminderCron: env.REMINDER_CRON || '0 8 * * *',
  reminderDaysAhead: int(env.REMINDER_DAYS_AHEAD, 1),
  monthlyReportCron: env.MONTHLY_REPORT_CRON || '0 9 1 * *',

  exportDir: path.resolve(path.join(__dirname, '..'), env.EXPORT_DIR || './storage/exports'),
  allowEarlyEvaluation: bool(env.ALLOW_EARLY_EVALUATION),
  // Viva demo only: switch student booking to the race-prone naive version (never in production)
  naiveBookingDemo: bool(env.NAIVE_BOOKING_DEMO) && env.NODE_ENV !== 'production',
};

if (!config.jwtSecret) {
  throw new Error('JWT_SECRET is not set. Copy server/.env.example to server/.env and set it.');
}

module.exports = config;

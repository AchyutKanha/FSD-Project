/**
 * Redis read-through cache with namespace versioning.
 *
 *   remember('exams', key, ttl, builder)  -> cached JSON or builder() result
 *   invalidate('exams', 'slots')          -> bumps the namespace version, so every
 *                                            key in it is ignored and expires by TTL
 *
 * If Redis is unavailable the cache simply passes through to the database;
 * correctness never depends on the cache (every write path re-checks in SQL).
 */
const Redis = require('ioredis');
const config = require('../config');

let client = null;
let ready = false;
const stats = { hits: 0, misses: 0, bypass: 0 };

function getClient() {
  if (!config.redisUrl) return null;
  if (!client) {
    client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    client.on('ready', () => { ready = true; });
    client.on('error', () => { ready = false; });
    client.on('end', () => { ready = false; });
  }
  return client;
}
getClient();

async function keyFor(c, ns, key) {
  const version = (await c.get(`emp:ns:${ns}`)) || '0';
  return `emp:cache:${ns}:v${version}:${key}`;
}

async function remember(ns, key, ttlSeconds, builder) {
  const c = getClient();
  if (!c || !ready) { stats.bypass += 1; return builder(); }

  let fullKey;
  try {
    fullKey = await keyFor(c, ns, key);
    const hit = await c.get(fullKey);
    if (hit !== null) { stats.hits += 1; return JSON.parse(hit); }
  } catch {
    stats.bypass += 1;
    return builder();
  }

  stats.misses += 1;
  const data = await builder();
  try { await c.set(fullKey, JSON.stringify(data), 'EX', ttlSeconds); } catch { /* ignore */ }
  return data;
}

async function invalidate(...namespaces) {
  const c = getClient();
  if (!c || !ready) return;
  try {
    await Promise.all(namespaces.map((ns) => c.incr(`emp:ns:${ns}`)));
  } catch { /* stale entries still expire via TTL */ }
}

async function closeCache() {
  if (client) { client.disconnect(); client = null; ready = false; }
}

const cacheStats = () => ({ ...stats, connected: ready });

module.exports = { remember, invalidate, closeCache, cacheStats };

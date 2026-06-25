// api/_lib/limits.js
// IP-лимит на Vercel KV.
// При недоступности KV — лимиты не действуют (не критично, клиентский лимит остаётся).

const DAILY_IP_LIMIT = 8;
const TTL_SECONDS = 25 * 60 * 60; // 25 часов — на случай смены TZ

let kvCache = null;
async function getKv() {
  if (kvCache === false) return null;
  if (kvCache) return kvCache;
  try {
    const { kv } = require('@vercel/kv');
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      kvCache = false;
      return null;
    }
    kvCache = kv;
    return kv;
  } catch (e) {
    kvCache = false;
    return null;
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Главная функция. Если dryRun=true — только проверяет, не пишет.
// Возвращает { allowed, count }
async function checkAndRecord(ip, mode, { dryRun = false } = {}) {
  // Считаем только дорогие режимы
  if (mode !== 'idea' && mode !== 'recipe') {
    return { allowed: true, count: 0 };
  }
  const kv = await getKv();
  if (!kv) {
    return { allowed: true, count: 0 }; // без KV — пускаем всех
  }
  const key = `rb:ip:${todayISO()}:${ip}`;
  try {
    const current = await kv.get(key);
    const count = current || 0;
    if (count >= DAILY_IP_LIMIT) {
      return { allowed: false, count };
    }
    if (!dryRun) {
      // INCR + EXPIRE атомарно. В Vercel KV это два вызова, но это ОК для нашего масштаба.
      await kv.incr(key);
      await kv.expire(key, TTL_SECONDS);
    }
    return { allowed: true, count: count + (dryRun ? 0 : 1) };
  } catch (e) {
    console.warn('[limits] check failed:', e.message);
    return { allowed: true, count: 0 };
  }
}

module.exports = { checkAndRecord };

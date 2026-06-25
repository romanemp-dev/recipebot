// api/_lib/cache.js
// Кеш ответов модели на Vercel KV (Redis).
// Если KV не подключен (например, на локалке) — gracefully падаем в no-op:
// без кеша, но всё работает.

const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 дней
const SLOTS_PER_KEY = 4;

let kv = null;
let kvAvailable = null; // null = не пробовали, true/false = знаем

async function getKv() {
  if (kvAvailable === false) return null;
  if (kv) return kv;
  try {
    // Lazy import — если @vercel/kv не установлен или ENV нет, упадёт сюда
    const { kv: vercelKv } = require('@vercel/kv');
    // Простая проверка что переменные есть
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      console.log('[cache] KV env vars not set, running without cache');
      kvAvailable = false;
      return null;
    }
    kv = vercelKv;
    kvAvailable = true;
    return kv;
  } catch (e) {
    console.log('[cache] KV unavailable:', e.message);
    kvAvailable = false;
    return null;
  }
}

const STOPWORDS = new Set([
  'и', 'или', 'с', 'из', 'на', 'в', 'а', 'но',
  'and', 'or', 'with', 'some', 'a', 'an', 'the',
]);

function normalizeIngredients(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s,]/gu, ' ')
    .split(/[,\s]+/)
    .filter(w => w.length > 1)
    .filter(w => !STOPWORDS.has(w))
    .sort()
    .join(' ');
}

function buildKey({ mode, ingredients, dish, rejected, filterModifier, lang }) {
  if (rejected && rejected.length > 0) return null;
  if (filterModifier) return null;

  const l = lang || 'ru';
  if (mode === 'idea') {
    const norm = normalizeIngredients(ingredients);
    if (!norm) return null;
    return `rb:${l}:idea:${norm}`;
  }
  if (mode === 'recipe') {
    const normDish = normalizeIngredients(dish);
    if (!normDish) return null;
    return `rb:${l}:recipe:${normDish}`;
  }
  if (mode === 'nutrition') {
    const normDish = normalizeIngredients(dish);
    if (!normDish) return null;
    return `rb:${l}:nutrition:${normDish}`;
  }
  return null;
}

// Достать случайный слот из кеша
async function get(key) {
  if (!key) return null;
  const kv = await getKv();
  if (!kv) return null;
  try {
    const entry = await kv.get(key);
    if (!entry || !entry.slots || entry.slots.length === 0) return null;
    const slot = entry.slots[Math.floor(Math.random() * entry.slots.length)];
    return { value: slot.value, slot: slot.idx };
  } catch (e) {
    console.warn('[cache] get failed:', e.message);
    return null;
  }
}

// Сохранить новый слот
async function set(key, value) {
  if (!key) return;
  const kv = await getKv();
  if (!kv) return;
  try {
    const existing = await kv.get(key);
    let entry = existing || { slots: [] };
    if (entry.slots.length < SLOTS_PER_KEY) {
      entry.slots.push({ idx: entry.slots.length, ts: Date.now(), value });
    } else {
      // Заменяем самый старый слот
      entry.slots.sort((a, b) => a.ts - b.ts);
      entry.slots[0] = { idx: entry.slots[0].idx, ts: Date.now(), value };
    }
    await kv.set(key, entry, { ex: TTL_SECONDS });
  } catch (e) {
    console.warn('[cache] set failed:', e.message);
  }
}

// Решение: использовать кеш или зайти в API
async function shouldUseCache(key) {
  if (!key) return false;
  const kv = await getKv();
  if (!kv) return false;
  try {
    const entry = await kv.get(key);
    if (!entry || !entry.slots) return false;
    if (entry.slots.length >= SLOTS_PER_KEY) return true;
    // Постепенное заполнение: вероятность брать из кеша растёт с числом слотов
    return Math.random() < entry.slots.length / (entry.slots.length + 1);
  } catch (e) {
    return false;
  }
}

module.exports = { buildKey, get, set, shouldUseCache };

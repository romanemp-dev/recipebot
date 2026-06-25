// backend/cache.js
// LRU-кеш с TTL для ответов Claude.
// Когда дойдём до production-нагрузки (Vercel + Redis) — заменим внутренности,
// интерфейс get/set/normalizeIngredients/buildKey остаётся.

const MAX_ENTRIES = 500;          // LRU размер
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней
const SLOTS_PER_KEY = 4;          // сколько разных ответов храним для разнообразия

// Map сохраняет порядок вставки → используем для LRU
const store = new Map();

function now() { return Date.now(); }

// Нормализация ингредиентов: "Курица, РИС! и помидоры" → "курица помидоры рис"
// Идея: lowercase + удалить пунктуацию + разбить по запятым/союзам + отсортировать.
// Это даёт стабильный ключ независимо от порядка и регистра.
function normalizeIngredients(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s,]/gu, ' ')  // оставить буквы, цифры, пробелы, запятые
    .split(/[,\s]+/)                       // разбить по пробелам и запятым
    .filter(w => w.length > 1)             // отсеять короткие слова и стоп-слова
    .filter(w => !STOPWORDS.has(w))
    .sort()
    .join(' ');
}

const STOPWORDS = new Set([
  'и', 'или', 'с', 'из', 'на', 'в', 'а', 'но',
  'and', 'or', 'with', 'some', 'a', 'an', 'the',
]);

// Построить ключ кеша для разных режимов.
// Возвращает null если запрос НЕ подлежит кешированию (есть rejected/filterModifier).
function buildKey({ mode, ingredients, dish, rejected, filterModifier, lang }) {
  // Не кешируем запросы с контекстом отказов/фильтров - они уникальны для каждого юзера
  if (rejected && rejected.length > 0) return null;
  if (filterModifier) return null;

  const l = lang || 'ru';
  if (mode === 'idea') {
    const norm = normalizeIngredients(ingredients);
    if (!norm) return null;
    return `${l}:idea:${norm}`;
  }
  if (mode === 'recipe') {
    // Для рецепта главное — блюдо. Ингредиенты влияют меньше (рецепт уже стандартный).
    const normDish = normalizeIngredients(dish);
    if (!normDish) return null;
    return `${l}:recipe:${normDish}`;
  }
  if (mode === 'nutrition') {
    const normDish = normalizeIngredients(dish);
    if (!normDish) return null;
    return `${l}:nutrition:${normDish}`;
  }
  return null;
}

// LRU touch: при чтении/записи перемещаем ключ в конец Map (свежий)
function touch(key, value) {
  store.delete(key);
  store.set(key, value);
}

// Эвикция самых старых записей если кеш переполнен
function evictIfNeeded() {
  while (store.size > MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;
    store.delete(oldestKey);
  }
}

// Получить случайный слот из закешированных вариантов
// Возвращает {value, slot} или null если кеша нет / устарел
function get(key) {
  if (!key) return null;
  const entry = store.get(key);
  if (!entry) return null;
  // Чистим устаревшие слоты
  entry.slots = entry.slots.filter(s => now() - s.ts < TTL_MS);
  if (entry.slots.length === 0) {
    store.delete(key);
    return null;
  }
  // Случайный слот из доступных — даём разнообразие
  const slot = entry.slots[Math.floor(Math.random() * entry.slots.length)];
  touch(key, entry); // LRU bump
  return { value: slot.value, slot: slot.idx };
}

// Сохранить новый слот для ключа
function set(key, value) {
  if (!key) return;
  let entry = store.get(key);
  if (!entry) {
    entry = { slots: [] };
  }
  // Если ещё есть свободные слоты — добавляем новый, иначе перезаписываем самый старый
  if (entry.slots.length < SLOTS_PER_KEY) {
    entry.slots.push({ idx: entry.slots.length, ts: now(), value });
  } else {
    // Найти самый старый слот и заменить его
    entry.slots.sort((a, b) => a.ts - b.ts);
    entry.slots[0] = { idx: entry.slots[0].idx, ts: now(), value };
  }
  touch(key, entry);
  evictIfNeeded();
}

// Решает: использовать кеш или сходить в API?
// Если в кеше уже SLOTS_PER_KEY вариантов — всегда из кеша.
// Если меньше — с вероятностью 1/(slots+1) идём в API, чтобы насобирать варианты.
// Это даёт постепенное заполнение слотов на ранней стадии.
function shouldUseCache(key) {
  if (!key) return false;
  const entry = store.get(key);
  if (!entry) return false;
  if (entry.slots.length >= SLOTS_PER_KEY) return true;
  // вероятность взять из кеша = slots / (slots + 1)
  return Math.random() < entry.slots.length / (entry.slots.length + 1);
}

// Статистика — для логирования и отладки
function stats() {
  let totalSlots = 0;
  for (const entry of store.values()) totalSlots += entry.slots.length;
  return {
    keys: store.size,
    totalSlots,
    maxKeys: MAX_ENTRIES,
  };
}

module.exports = {
  buildKey,
  get,
  set,
  shouldUseCache,
  stats,
  normalizeIngredients, // экспортируем для тестов
};

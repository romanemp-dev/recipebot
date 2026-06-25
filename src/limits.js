// src/limits.js
// Клиентский счётчик использования для анонимных пользователей.
// Сервер дублирует эту проверку по IP — здесь только UX-сторона.
//
// Переиспользуется в других приложениях: меняешь только CONFIG.
//
// Хранение в localStorage:
//   recipebot_usage = { date: "2026-06-18", count: 3, weekHistory: [...] }
//   date — это локальная дата пользователя в формате YYYY-MM-DD
//   count обнуляется когда сменилась дата

const STORAGE_KEY = 'recipebot_usage';
const BYPASS_KEY = 'recipebot_unlimited';

const CONFIG = {
  dailyLimit: 5,
  weeklyLimit: 15,
};

// Стоимость каждого действия в "кредитах"
const COSTS = {
  idea: 1,
  recipe: 1,
  nutrition: 0.5,
};

// Dev/owner режим: если в localStorage стоит флаг, лимиты не действуют.
// Включить из консоли браузера (F12):
//   localStorage.setItem('recipebot_unlimited', 'true')
// Выключить:
//   localStorage.removeItem('recipebot_unlimited')
function isUnlimited() {
  try {
    return localStorage.getItem(BYPASS_KEY) === 'true';
  } catch (e) {
    return false;
  }
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function readState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { date: todayStr(), count: 0, weekHistory: [] };
    const parsed = JSON.parse(raw);
    if (parsed.date !== todayStr()) {
      return { date: todayStr(), count: 0, weekHistory: parsed.weekHistory || [] };
    }
    return parsed;
  } catch (e) {
    return { date: todayStr(), count: 0, weekHistory: [] };
  }
}

function writeState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) { /* приватный режим, игнорим */ }
}

// Чистка истории — оставляем только последние 7 дней
function pruneWeekHistory(history) {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  return history.filter(entry => entry.ts > weekAgo);
}

// Вернёт сколько действий можно сделать сегодня (по дневному лимиту)
// В unlimited режиме возвращает Infinity (для UI: показываем '∞')
export function getRemainingToday() {
  if (isUnlimited()) return Infinity;
  const state = readState();
  return Math.max(0, CONFIG.dailyLimit - Math.floor(state.count));
}

// Сколько можно сделать на неделе (по недельному лимиту)
export function getRemainingWeek() {
  if (isUnlimited()) return Infinity;
  const state = readState();
  const recent = pruneWeekHistory(state.weekHistory || []);
  const weekTotal = recent.reduce((sum, e) => sum + e.cost, 0);
  return Math.max(0, CONFIG.weeklyLimit - Math.floor(weekTotal));
}

// Проверка: можно ли сделать действие mode (idea/recipe/nutrition)
// Возвращает { allowed: bool, reason: 'daily' | 'weekly' | null }
export function canDo(mode) {
  if (isUnlimited()) return { allowed: true, reason: null };
  const cost = COSTS[mode] ?? 1;
  if (getRemainingToday() < cost) return { allowed: false, reason: 'daily' };
  if (getRemainingWeek() < cost) return { allowed: false, reason: 'weekly' };
  return { allowed: true, reason: null };
}

// Зафиксировать использование (после успешного ответа от бэка)
export function recordUsage(mode) {
  if (isUnlimited()) return; // в unlimited режиме ничего не пишем
  const cost = COSTS[mode] ?? 1;
  const state = readState();
  state.count = (state.count || 0) + cost;
  state.weekHistory = pruneWeekHistory(state.weekHistory || []);
  state.weekHistory.push({ ts: Date.now(), cost, mode });
  writeState(state);
}

// Для UI: текущее состояние одним объектом
export function getUsageInfo() {
  return {
    dailyRemaining: getRemainingToday(),
    dailyLimit: CONFIG.dailyLimit,
    weeklyRemaining: getRemainingWeek(),
    weeklyLimit: CONFIG.weeklyLimit,
    unlimited: isUnlimited(),
  };
}

// Для тестов / отладки
export function _resetUsage() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
}

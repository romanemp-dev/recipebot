// api/chat.js
// Vercel serverless function. Принимает POST с {mode, ingredients, dish, rejected, filterModifier, lang}.
//
// Отличия от старого server.js:
// - Нет express, используется родной (req, res) API Vercel
// - Кеш и IP-лимит хранятся в Vercel KV (Redis), не в памяти
// - CORS уже не нужен — фронт и бэк на одном домене

const { buildKey, get: cacheGet, set: cacheSet, shouldUseCache } = require('./_lib/cache');
const { checkAndRecord } = require('./_lib/limits');
const { PROMPTS } = require('./_lib/prompts');
const { callClaude } = require('./_lib/claude');

module.exports = async (req, res) => {
  // CORS — на всякий случай (если кто-то будет дёргать API с другого домена)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-dev-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let { mode, ingredients, dish, rejected, filterModifier, lang } = req.body || {};

    // Защита от битых эмодзи (lone surrogates ломают JSON для Anthropic)
    const clean = (s) => typeof s === 'string'
      ? s.replace(/[\uD800-\uDFFF]/g, '').trim()
      : s;
    ingredients = clean(ingredients);
    dish = clean(dish);
    filterModifier = clean(filterModifier);
    rejected = Array.isArray(rejected) ? rejected.map(clean).filter(Boolean) : [];

    // === Dev-режим: пропускаем IP-лимит для разработчика ===
    // На клиенте Reciрebot ставится localStorage.recipebot_unlimited=true.
    // Этот же флаг прокидывается на бэк через заголовок.
    const isDev = req.headers['x-dev-key'] === process.env.DEV_BYPASS_KEY && process.env.DEV_BYPASS_KEY;

    // === Серверная проверка лимита по IP ===
    const ip = getClientIp(req);
    if (!isDev) {
      const limitCheck = await checkAndRecord(ip, mode, { dryRun: true });
      if (!limitCheck.allowed) {
        console.log(`Rate limit hit for IP ${ip} (mode: ${mode})`);
        return res.status(429).json({ error: 'rate_limited' });
      }
    }

    // === Промпт ===
    const localePrompts = PROMPTS[lang] || PROMPTS.ru;
    const promptBuilder = localePrompts[mode];
    if (!promptBuilder) {
      return res.status(400).json({ error: `Unknown mode: ${mode}` });
    }

    console.log('Request:', { mode, ip, lang: lang || 'ru', dev: isDev });

    const { systemPrompt, userMessage, maxTokens } = promptBuilder({
      ingredients, dish, rejected, filterModifier
    });

    // === КЕШ: ищем готовый ответ ===
    const cacheKey = buildKey({ mode, ingredients, dish, rejected, filterModifier, lang });
    if (cacheKey && await shouldUseCache(cacheKey)) {
      const cached = await cacheGet(cacheKey);
      if (cached) {
        console.log(`CACHE HIT [${mode}] key=${cacheKey} slot=${cached.slot}`);
        if (!isDev) await checkAndRecord(ip, mode);
        return res.status(200).json(cached.value);
      }
    }

    // === Зовём Claude ===
    const text = await callClaude(systemPrompt, userMessage, maxTokens);

    // Парсим JSON-ответ
    let parsedReply = { content: [{ text }] };
    let isValid = true;

    if (mode === 'idea' || mode === 'recipe') {
      try {
        const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        const parsed = JSON.parse(cleaned);

        if (mode === 'idea') {
          if (parsed.isFood === false) {
            isValid = false;
            parsedReply = { notFood: true, message: parsed.message || 'Не понял, какие у тебя ингредиенты' };
          } else if (parsed.isFood === true && parsed.title) {
            parsedReply = { content: [{ text: `${parsed.title}\n${parsed.description || ''}` }] };
          }
        } else if (mode === 'recipe') {
          if (parsed.isRecipe === false) {
            isValid = false;
            parsedReply = { notFood: true, message: parsed.message || 'Не понял, какое блюдо готовить' };
          } else if (parsed.isRecipe === true && parsed.content) {
            parsedReply = { content: [{ text: parsed.content }] };
          }
        }
      } catch (e) {
        console.warn('JSON parse failed for mode', mode, ':', e.message);
      }
    }

    // Записываем IP-usage только если ответ валидный и не dev
    if (isValid && !isDev) {
      await checkAndRecord(ip, mode);
    }

    // Сохраняем в кеш если ответ валидный
    if (isValid && cacheKey) {
      await cacheSet(cacheKey, parsedReply);
    }

    console.log('Claude response:', text.substring(0, 100), '| valid:', isValid);
    return res.status(200).json(parsedReply);

  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

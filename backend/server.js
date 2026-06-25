const express = require('express');
const cors = require('cors');
const cache = require('./cache');
require('dotenv').config({ path: '../.env' });

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'Backend working!' });
});

// Стата кеша - можно зайти в браузере и посмотреть состояние
app.get('/cache-stats', (req, res) => {
  res.json(cache.stats());
});

// === Серверный лимит по IP ===
// In-memory счётчик: для production заменим на Redis (через 1K MAU).
// Сейчас покрывает 100% реальных кейсов: если процесс рестартнётся — счётчики сбросятся,
// но это нормально, лимит вернётся в действие со следующей минуты.
//
// Формат: ipUsage[ip] = { date: 'YYYY-MM-DD', count: число }
const ipUsage = {};
const DAILY_IP_LIMIT = 8; // чуть больше чем клиентский (5), запас на разные устройства за одним NAT

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function getClientIp(req) {
  // X-Forwarded-For используется когда работаем за прокси (Vercel, Render, и т.д.)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function checkIpLimit(ip, costlyMode) {
  // Считаем только дорогие режимы: idea, recipe. Nutrition — лёгкий, не считаем.
  if (costlyMode !== 'idea' && costlyMode !== 'recipe') {
    return { allowed: true };
  }
  const today = todayISO();
  const record = ipUsage[ip];
  if (!record || record.date !== today) {
    ipUsage[ip] = { date: today, count: 0 };
  }
  if (ipUsage[ip].count >= DAILY_IP_LIMIT) {
    return { allowed: false };
  }
  return { allowed: true };
}

// Dev-режим: разработчик передаёт секрет в заголовке, бэк пропускает без лимита.
// Секрет хранится в .env как DEV_SECRET. Если не задан — dev-режим выключен полностью.
function isDevRequest(req) {
  const headerSecret = req.headers['x-dev-secret'];
  const envSecret = process.env.DEV_SECRET;
  // Простой "x-dev-mode: 1" без секрета тоже принимаем — для локальной разработки
  // когда DEV_SECRET не настроен. В production обязательно настрой DEV_SECRET!
  if (!envSecret) {
    return req.headers['x-dev-mode'] === '1';
  }
  return headerSecret === envSecret;
}

function recordIpUsage(ip, costlyMode) {
  if (costlyMode !== 'idea' && costlyMode !== 'recipe') return;
  const today = todayISO();
  if (!ipUsage[ip] || ipUsage[ip].date !== today) {
    ipUsage[ip] = { date: today, count: 0 };
  }
  ipUsage[ip].count++;
}

// Раз в час чистим записи старше суток — иначе мап будет расти бесконечно
setInterval(() => {
  const today = todayISO();
  for (const ip in ipUsage) {
    if (ipUsage[ip].date !== today) delete ipUsage[ip];
  }
}, 60 * 60 * 1000);

// === Промпты по языкам ===
// Архитектурно готово к мультиязычности. Сейчас активен только ru.
const PROMPTS = {
  ru: {
    idea: ({ ingredients, rejected, filterModifier }) => {
      const systemPrompt = `Ты помощник по приготовлению еды с лёгким характером.

ХАРАКТЕР:
- Дружелюбный, иногда с лёгким сарказмом — как друг который умеет готовить.
- Не лекторствуй, не делай нравоучения о здоровом питании.
- Не используй устаревший интернет-сленг ("краш", "вайб", "слэй").
- Не подкатывай близко: никаких "дружочек", "солнышко", сердечек.
- ПОДКОЛЫ — иногда, не в каждом ответе. Примерно 1 из 5 раз. Лёгкие, без злобы. Когда подкалываешь — делай это через короткую фразу-комментарий ПЕРЕД основным ответом, не в описании блюда.
- Тёмные темы (диеты, расстройства пищевого поведения, нехватка денег, война) — не шутить никогда.

ВАЖНО — СНАЧАЛА ПРОВЕРЬ ВВОД:
Если ввод НЕ является списком ингредиентов или едой (это вопрос к тебе, бессмыслица, ругательство, несъедобные вещи типа "камень, бензин", или общая фраза без продуктов) — верни:
{"isFood": false, "message": "<короткая фраза в характере + предложи дать ингредиенты. Можешь иногда пошутить если ввод абсурдный — например 'из бетонной крошки рецептов у меня пока нет, но если найдёшь курицу — обсудим' >"}

Если ввод ВАЛИДНЫЙ (есть хотя бы один пищевой ингредиент) — предложи ОДНО блюдо за 15-40 минут и верни:
{"isFood": true, "title": "<эмодзи> Название блюда", "description": "Краткое описание одной фразой"}

Иногда (примерно 1 из 5) в поле description можешь добавить лёгкий комментарий-наблюдение в начале, например "Классика для тех у кого мало времени и много голода. <обычное описание>". Не каждый раз.

ОТВЕЧАЙ ТОЛЬКО ВАЛИДНЫМ JSON, БЕЗ MARKDOWN, БЕЗ ТЕКСТА ВОКРУГ.

Примеры валидного JSON:
{"isFood": true, "title": "🐟 Рыба по-средиземноморски", "description": "Нежная рыба в томатном соусе"}
{"isFood": false, "message": "Хм, я не вижу ингредиентов 🤔 Напиши что есть в холодильнике — например 'курица, рис, помидоры'"}`;

      let userMessage = `Ингредиенты: ${ingredients}`;
      if (rejected && rejected.length > 0) {
        userMessage += `\n\nУже предлагал (НЕ повторяй эти блюда): ${rejected.join(', ')}\nПредложи что-то совсем другое.`;
      }
      if (filterModifier) {
        userMessage += `\n\nВажно: ${filterModifier}.`;
      }
      return { systemPrompt, userMessage, maxTokens: 400 };
    },

    recipe: ({ dish, ingredients }) => {
      const systemPrompt = `Ты помощник по приготовлению еды с лёгким характером.

ХАРАКТЕР:
- Дружелюбный, иногда с лёгким сарказмом — как друг который умеет готовить.
- Во вступлении к рецепту иногда (примерно 1 из 5) добавь короткий ободряющий комментарий или лёгкий подкол. Не каждый раз.
- Например: "Готовится быстрее чем ты успеешь забыть зачем зашёл" / "Простой рецепт, испортить почти невозможно" / "Классика которая не подведёт".
- НЕ лекторствуй, НЕ читай нотации о питании.
- НЕ используй устаревший интернет-сленг и обращения типа "дружочек".

ВАЖНО — СНАЧАЛА ПРОВЕРЬ ВВОД:
Если "Блюдо" не является реальным блюдом или едой (это фраза, вопрос, бессмыслица, ошибка) — верни ТОЛЬКО:
{"isRecipe": false, "message": "<короткая дружелюбная фраза в характере>"}

Если "Блюдо" валидное — верни рецепт:
{"isRecipe": true, "content": "<текст рецепта в markdown по правилам ниже>"}

ОТВЕЧАЙ ТОЛЬКО ВАЛИДНЫМ JSON, БЕЗ ТЕКСТА ВОКРУГ.

ПРАВИЛА ФОРМАТИРОВАНИЯ ТЕКСТА РЕЦЕПТА (для поля content):
- НЕ используй разделители "---" или "***"
- НЕ дублируй название блюда в начале (оно уже показано пользователю)
- Используй **жирный текст** только для названий секций ("Ингредиенты:", "Приготовление:") и важных действий
- Не делай вложенных подзаголовков типа "**Для соуса:**" — пиши обычным текстом "Для соуса:" с двоеточием
- Каждый ингредиент — одной строкой, начиная с "- "
- Каждый шаг приготовления — отдельной строкой с "1.", "2." и т.д.

Шаблон рецепта внутри content:
"Короткая фраза-вступление (1 предложение, можно с лёгким характером).\\n\\n**Ингредиенты:**\\n- ингредиент 1 — количество\\n- ингредиент 2 — количество\\n\\n**Приготовление:**\\n1. Первый шаг.\\n2. Второй шаг."

ВАЖНО: внутри JSON-строки переносы строк должны быть как \\n, а не реальные переносы — иначе JSON будет невалидным.

Будь конкретным, указывай примерное время и количество. Пиши понятно для новичка.`;

      const userMessage = `Блюдо: ${dish}\nДоступные ингредиенты: ${ingredients}\n\nДай рецепт этого блюда.`;
      return { systemPrompt, userMessage, maxTokens: 2000 };
    },

    nutrition: ({ dish }) => {
      const systemPrompt = `Ты диетолог. Оцени КБЖУ блюда на одну порцию.
ОТВЕТ СТРОГО В ФОРМАТЕ JSON, без markdown и текста вокруг:
{"calories": число, "protein": число, "fat": число, "carbs": число}
Числа — целые, в граммах (кроме калорий). Это приблизительная оценка.`;

      const userMessage = `Блюдо: ${dish}\nДай примерные КБЖУ на одну порцию.`;
      return { systemPrompt, userMessage, maxTokens: 200 };
    },
  },
  // en: { idea: ..., recipe: ..., nutrition: ... },  // когда понадобится
};

// === Вызов Claude API ===
async function callClaude(systemPrompt, userMessage, maxTokens = 600) {
  const apiKey = process.env.REACT_APP_ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('API key not found');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  const data = await response.json();
  if (!data.content || !data.content[0]) {
    throw new Error('Invalid API response: ' + JSON.stringify(data));
  }
  return data.content[0].text;
}

app.post('/api/chat', async (req, res) => {
  try {
    let { mode, ingredients, dish, rejected, filterModifier, lang } = req.body;

    // === Серверная проверка лимита по IP ===
    const ip = getClientIp(req);
    const isDev = isDevRequest(req);
    if (!isDev) {
      const ipCheck = checkIpLimit(ip, mode);
      if (!ipCheck.allowed) {
        console.log(`Rate limit hit for IP ${ip} (mode: ${mode})`);
        return res.status(429).json({ error: 'rate_limited' });
      }
    } else {
      console.log('Dev request — bypassing rate limit');
    }

    // Защита от битых эмодзи
    const clean = (s) => typeof s === 'string'
      ? s.replace(/[\uD800-\uDFFF]/g, '').trim()
      : s;
    ingredients = clean(ingredients);
    dish = clean(dish);
    filterModifier = clean(filterModifier);
    rejected = Array.isArray(rejected) ? rejected.map(clean).filter(Boolean) : [];

    const localePrompts = PROMPTS[lang] || PROMPTS.ru;
    const promptBuilder = localePrompts[mode];
    if (!promptBuilder) {
      return res.status(400).json({ error: `Unknown mode: ${mode}` });
    }

    console.log('Request:', { mode, ip, lang: lang || 'ru', ingredients, dish, rejected, filterModifier });

    const { systemPrompt, userMessage, maxTokens } = promptBuilder({
      ingredients, dish, rejected, filterModifier
    });

    // === КЕШ: проверяем, есть ли подходящий ответ ===
    const cacheKey = cache.buildKey({ mode, ingredients, dish, rejected, filterModifier, lang });
    if (cacheKey && cache.shouldUseCache(cacheKey)) {
      const cached = cache.get(cacheKey);
      if (cached) {
        console.log(`CACHE HIT [${mode}] key=${cacheKey} slot=${cached.slot}`);
        // Запишем использование IP даже из кеша — лимит должен срабатывать одинаково
        recordIpUsage(ip, mode);
        return res.json(cached.value);
      }
    }

    const text = await callClaude(systemPrompt, userMessage, maxTokens);

    // Парсим JSON-ответ от модели для idea и recipe.
    // Если ввод оказался не едой — возвращаем флаг notFood и НЕ списываем кредит.
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
          // если структура странная — оставим как есть, фронт обработает
        } else if (mode === 'recipe') {
          if (parsed.isRecipe === false) {
            isValid = false;
            parsedReply = { notFood: true, message: parsed.message || 'Не понял, какое блюдо готовить' };
          } else if (parsed.isRecipe === true && parsed.content) {
            parsedReply = { content: [{ text: parsed.content }] };
          }
        }
      } catch (e) {
        // JSON невалидный — модель ответила обычным текстом.
        // Это запасной путь: используем как есть.
        console.warn('JSON parse failed for mode', mode, ':', e.message);
      }
    }

    // Записываем IP-лимит только если ответ был полезным и это не dev
    if (isValid && !isDev) {
      recordIpUsage(ip, mode);
    }

    // === КЕШ: сохраняем валидный ответ для будущих запросов ===
    if (isValid && cacheKey) {
      cache.set(cacheKey, parsedReply);
    }

    console.log('Claude response:', text.substring(0, 100), '| valid:', isValid);
    res.json(parsedReply);

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(4000, () => console.log('Backend on port 4000'));

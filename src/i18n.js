// src/i18n.js
// Все строки UI и промпты для модели. Добавить новый язык = добавить новый объект.
// Когда появится логин — язык будет браться из настроек профиля.
// Сейчас — из браузера, с фолбэком на русский.

// Хелпер для русских числительных: pluralize(1, 'идея', 'идеи', 'идей') → 'идея'
function pluralize(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

const ru = {
  // UI: header
  headerTitle: 'Что готовим?',
  headerStatus: 'онлайн · готов помочь',

  // Звук — пока всегда вкл, потом добавим переключатель
  soundEnabled: true,

  // UI: messages
  // Варианты приветствия - случайный при загрузке. Большинство нейтральные, 1-2 с лёгким характером.
  greetings: [
    'Привет! 👋 Из чего готовим? Напиши что есть в холодильнике',
    'Привет! Что в холодильнике? Напиши через запятую — я что-нибудь придумаю',
    'Привет 👋 Открыл холодильник и не знаешь что делать? Перечисли что видишь',
    'Привет! Скажи что есть из продуктов — подберу что приготовить',
    'Привет 🍳 Из чего готовим сегодня?',
  ],
  // Старое поле для совместимости — возвращает случайный greeting
  get greeting() {
    return this.greetings[Math.floor(Math.random() * this.greetings.length)];
  },
  ideaIntro: 'Есть отличная идея 👇',
  ideaPrompt: 'Нравится? Показать рецепт?',
  btnGiveRecipe: 'Давай рецепт',
  btnOther: 'Другое',
  userMsgWantRecipe: 'Давай рецепт 👨‍🍳',
  userMsgWantOther: 'Другое 🔄',
  errorConnect: 'Что-то пошло не так с подключением. Попробуй ещё раз 😔',
  errorRecipe: 'Не получилось вытащить рецепт. Попробуй ещё раз 😔',

  // Состояние когда дневной лимит исчерпан (для анонимов)
  limitReached: {
    // Случайный вариант intro при показе
    intros: [
      'Всё, на сегодня я закрылся 😅',
      'Хватит на сегодня! Я не резиновый',
      'Всё, лимит на сегодня 🛑',
      'На сегодня всё! Я тебе уже 5 идей выдал',
    ],
    get intro() {
      return this.intros[Math.floor(Math.random() * this.intros.length)];
    },
    explanation: 'Без регистрации ограничение 5 идей в день — это чтобы не разориться на API. Завтра в 00:00 счётчик обновится.',
    cta: 'Или зарегистрируйся — тогда лимит будет больше + сохраню все твои любимые рецепты',
    btnLogin: 'Зарегистрироваться',
    btnWait: 'Подожду до завтра',
  },
  // Маленький счётчик в шапке
  remainingCount: (n) => `${n} ${pluralize(n, 'идея', 'идеи', 'идей')} сегодня`,
  exhausted: {
    intros: [
      'Окей, я выдохся 🤷 С такими ингредиентами больше идей у меня нет',
      'Всё, идеи кончились 🤷 Из этого набора я уже всё что мог',
      'Сдаюсь, не могу больше ничего придумать из этих продуктов 🤷',
    ],
    get intro() {
      return this.intros[Math.floor(Math.random() * this.intros.length)];
    },
    suggestion: 'Хочешь добавить что-то базовое к холодильнику? Это сильно расширит выбор:',
    products: [
      { emoji: '🥚', name: 'яйца' },
      { emoji: '🧅', name: 'лук' },
      { emoji: '🧄', name: 'чеснок' },
      { emoji: '🍅', name: 'помидоры' },
      { emoji: '🧀', name: 'сыр' },
      { emoji: '🍚', name: 'рис' },
    ],
    affiliateHint: 'Закажу всё это за 15 минут в Самокате:',
    affiliateButton: '🛒 Заказать недостающее',
    affiliateUrl: 'https://samokat.ru/', // TODO: заменить на partner link с UTM
    orInput: 'или напиши новые ингредиенты ↓',
  },

  // UI: input
  inputPlaceholders: [
    'Что у тебя есть?',
    'яйца, сыр, помидоры…',
    'курица и рис…',
    'что осталось в холодильнике…',
    'паста, чеснок, оливковое масло…',
  ],

  // F1: подсказки-чипсы под приветствием (быстрый старт)
  starterChips: [
    { emoji: '🍳', label: 'Завтрак', query: 'что есть на завтрак из обычных продуктов' },
    { emoji: '⚡', label: '15 минут', query: 'что-то быстрое за 15 минут из базовых продуктов' },
    { emoji: '🥗', label: 'Лёгкое', query: 'что-то лёгкое и полезное из обычных продуктов' },
    { emoji: '🎲', label: 'Удиви меня', query: 'удиви меня вкусной идеей из обычных домашних продуктов' },
  ],

  // F6: чипсы-фильтры после "Другое" — направляют поиск
  filterChips: [
    { emoji: '🥗', label: 'полегче', modifier: 'предложи что-то более лёгкое и менее калорийное' },
    { emoji: '💪', label: 'белок', modifier: 'предложи что-то с большим количеством белка' },
    { emoji: '⚡', label: 'быстрее', modifier: 'предложи что-то что готовится за 15-20 минут' },
    { emoji: '🍰', label: 'посытнее', modifier: 'предложи что-то более сытное и питательное' },
  ],
  filterHint: 'Или подскажи направление:',

  // F7: КБЖУ под рецептом
  showNutrition: 'Показать КБЖУ ~',
  hideNutrition: 'Скрыть КБЖУ',
  nutritionLoading: 'Считаю...',
  nutritionDisclaimer: '~ приблизительная оценка на одну порцию. Реальная погрешность 10-40%, поэтому если ты считаешь калории строго — сверяйся с граммовкой ингредиентов.',
  nutritionLabels: {
    calories: 'ккал',
    protein: 'белки',
    fat: 'жиры',
    carbs: 'углеводы',
  },

  // Чипсы после рецепта — куда направить пользователя если рецепт не зашёл
  afterRecipeHint: 'Не подошло?',
  afterRecipeChips: [
    { emoji: '⚡', label: 'Попроще', modifier: 'предложи блюдо проще в приготовлении — не больше 5-6 шагов и минимум ингредиентов' },
    { emoji: '⚡', label: 'Побыстрее', modifier: 'предложи блюдо которое готовится за 15-20 минут максимум' },
    { emoji: '🔄', label: 'Другое блюдо', modifier: null },
  ],

  // Промпты для модели — на языке пользователя
  prompts: {
    idea: ({ ingredients, rejected, filterModifier }) => {
      let prompt = `Ты дружелюбный помощник по приготовлению еды.
Пользователь напишет какие у него есть ингредиенты.
Предложи ОДНО конкретное блюдо которое можно из них приготовить за 15-40 минут.

ФОРМАТ ОТВЕТА (строго 2 строки, без лишнего текста):
[эмодзи] Название блюда
Краткое описание одной фразой

Пример:
🐟 Рыба по-средиземноморски с рисом
Нежная рыба в томатном соусе с ароматными травами

Не пиши рецепт, только название и описание!`;

      let userMessage = `Ингредиенты: ${ingredients}`;
      if (rejected && rejected.length > 0) {
        userMessage += `\n\nУже предлагал (НЕ повторяй эти блюда): ${rejected.join(', ')}\nПредложи что-то совсем другое.`;
      }
      if (filterModifier) {
        userMessage += `\n\nВажно: ${filterModifier}.`;
      }
      return { systemPrompt: prompt, userMessage };
    },

    recipe: ({ dish, ingredients }) => {
      const systemPrompt = `Ты дружелюбный помощник по приготовлению еды.
Пользователь выбрал блюдо и хочет рецепт.
Дай понятный рецепт с форматированием.

ФОРМАТ ОТВЕТА:
Название блюда

Ингредиенты:
- ингредиент 1
- ингредиент 2

Приготовление:
1. Первый шаг
2. Второй шаг
3. Третий шаг

Будь конкретным, указывай примерное время и количество. Пиши понятно для новичка.
Уложись в 1500 токенов — не обрезай рецепт.`;

      const userMessage = `Блюдо: ${dish}\nДоступные ингредиенты: ${ingredients}\n\nДай рецепт этого блюда.`;
      return { systemPrompt, userMessage };
    },

    nutrition: ({ dish }) => {
      const systemPrompt = `Ты диетолог. Оцени КБЖУ блюда на одну порцию.
ОТВЕТ СТРОГО В ФОРМАТЕ JSON, без markdown и текста вокруг:
{"calories": число, "protein": число, "fat": число, "carbs": число}
Числа — целые, в граммах (кроме калорий). Это приблизительная оценка.`;

      const userMessage = `Блюдо: ${dish}\nДай примерные КБЖУ на одну порцию.`;
      return { systemPrompt, userMessage };
    },
  },
};

// Когда захочется добавить язык — раскомментируй и заполни:
// const en = { headerTitle: "What's cooking?", ... };
// const es = { ... };

const locales = { ru /*, en, es */ };

// Определение языка пользователя
export function detectLocale() {
  // Приоритет: localStorage > navigator > 'ru'
  // (когда будет логин — добавим профиль)
  try {
    const saved = localStorage.getItem('recipebot_lang');
    if (saved && locales[saved]) return saved;
  } catch (e) { /* SSR / приватный режим */ }

  if (typeof navigator !== 'undefined' && navigator.language) {
    const short = navigator.language.split('-')[0].toLowerCase();
    if (locales[short]) return short;
  }
  return 'ru';
}

export function getTexts(locale) {
  return locales[locale] || locales.ru;
}

// Удобный default — для текущего языка
const currentLocale = typeof window !== 'undefined' ? detectLocale() : 'ru';
export const t = getTexts(currentLocale);
export const currentLang = currentLocale;

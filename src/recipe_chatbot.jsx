import React, { useState, useEffect, useRef } from 'react';
import { t, currentLang } from './i18n';
import { canDo, recordUsage, getUsageInfo } from './limits';
import { initAnalytics, track } from './analytics';

// На продакшене (Vercel) API лежит на том же домене — относительный путь.
// На локалке указываем явный хост старого Express-бэка.
// Дополнительно: можно переопределить через REACT_APP_BACKEND_URL.
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL
  ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:4000');

// === Звук: короткий "цок" через Web Audio API ===
// Работает везде, включая iPhone. Создаётся при первом взаимодействии (требование Safari).
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    } catch (e) { /* нет поддержки — молча игнор */ }
  }
  return audioCtx;
}

function playTick({ intensity = 1 } = {}) {
  if (!t.soundEnabled) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    // Если контекст suspended (iOS блокирует до user gesture), пробуем разбудить
    if (ctx.state === 'suspended') ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    // Короткий низкий "тук" — частота 180Hz, длительность ~50мс
    osc.frequency.setValueAtTime(intensity > 0.7 ? 220 : 180, ctx.currentTime);
    osc.type = 'sine';

    // Огибающая: быстрый удар + быстрое затухание
    const peakVol = 0.08 * intensity;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(peakVol, ctx.currentTime + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.06);
  } catch (e) { /* молча */ }
}

// === Sparkles: золотые искры по краям сообщения ===
// Рендерится один раз при появлении (через ключ idx), анимация CSS, потом исчезает.
function Sparkles({ variant = 'rich' }) {
  // rich — больше и ярче (рецепт), subtle — меньше и нежнее (идея)
  const count = variant === 'rich' ? 10 : 6;
  // Заранее распределённые позиции по периметру (top%, left%, size, delay)
  const positions = variant === 'rich' ? [
    { top: -8, left: 8, size: 14, delay: 0, drift: -6 },
    { top: 4, left: -10, size: 10, delay: 0.15, drift: -8 },
    { top: 40, left: -12, size: 12, delay: 0.4, drift: -10 },
    { top: 72, left: -8, size: 8, delay: 0.6, drift: -6 },
    { top: 96, left: 18, size: 12, delay: 0.3, drift: 6 },
    { top: 102, left: 60, size: 10, delay: 0.5, drift: 4 },
    { top: 88, left: 90, size: 14, delay: 0.1, drift: 8 },
    { top: 36, left: 102, size: 12, delay: 0.35, drift: 10 },
    { top: 6, left: 92, size: 10, delay: 0.2, drift: 6 },
    { top: -6, left: 50, size: 12, delay: 0.05, drift: 0 },
  ] : [
    { top: -6, left: 12, size: 8, delay: 0, drift: -4 },
    { top: 30, left: -8, size: 6, delay: 0.25, drift: -6 },
    { top: 70, left: -6, size: 7, delay: 0.5, drift: -4 },
    { top: 95, left: 75, size: 7, delay: 0.15, drift: 4 },
    { top: 30, left: 100, size: 8, delay: 0.35, drift: 6 },
    { top: -4, left: 80, size: 7, delay: 0.1, drift: 4 },
  ];

  return (
    <div style={styles.sparklesLayer} aria-hidden="true">
      {positions.slice(0, count).map((p, i) => (
        <span
          key={i}
          className={`sparkle sparkle-${variant}`}
          style={{
            top: `${p.top}%`,
            left: `${p.left}%`,
            width: `${p.size}px`,
            height: `${p.size}px`,
            animationDelay: `${p.delay}s`,
            '--drift': `${p.drift}px`,
          }}
        />
      ))}
    </div>
  );
}

// Безопасно убирает эмодзи из строки (не разрезает surrogate pairs)
function stripEmoji(str) {
  return str
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .trim();
}

// Нормализует название для сравнения: убирает эмодзи, регистр, знаки препинания
function normalizeTitle(str) {
  return stripEmoji(str)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '') // убрать всё кроме букв/цифр/пробелов
    .replace(/\s+/g, ' ')
    .trim();
}

// Простая мера схожести по корням слов.
// Использует prefix-match (общий префикс 4+ символов = один корень) — это покрывает
// русские словоформы типа «творожная»/«творожный», «картофель»/«картофельные».
function isTooSimilar(titleA, titleB) {
  const a = normalizeTitle(titleA);
  const b = normalizeTitle(titleB);
  if (!a || !b) return false;
  if (a === b) return true;
  const stop = new Set(['и','с','из','на','по','для','от','в','а','но','к','со','же']);
  const significant = (s) => s.split(' ').filter(w => w.length >= 3 && !stop.has(w));
  const sigA = significant(a);
  const sigB = significant(b);
  if (sigA.length === 0 || sigB.length === 0) return false;

  // Слова с общим префиксом 4+ символа считаем «одним корнем»
  const sameRoot = (w1, w2) => {
    const min = Math.min(w1.length, w2.length);
    if (min < 4) return w1 === w2;
    let prefix = 0;
    for (let i = 0; i < min; i++) {
      if (w1[i] === w2[i]) prefix++;
      else break;
    }
    return prefix >= 4;
  };

  // Сколько слов из B нашли «однокоренной» в A
  const common = sigB.filter(wb => sigA.some(wa => sameRoot(wa, wb))).length;
  const denom = Math.min(sigA.length, sigB.length);
  return common / denom >= 0.6;
}

export default function RecipeChatbot() {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [ingredients, setIngredients] = useState('');
  const [rejectedIdeas, setRejectedIdeas] = useState([]);
  // F2: индекс плейсхолдера для карусели
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  // LIM: текущая инфа о лимитах для отображения в шапке
  const [usageInfo, setUsageInfo] = useState(() => {
    try { return getUsageInfo(); } catch (e) { return { dailyRemaining: 5, dailyLimit: 5 }; }
  });
  const messagesEndRef = useRef(null);

  // F1: стартовые чипсы показываем пока пользователь ничего не вводил
  const showStarterChips = messages.length === 1 && !isLoading;

  useEffect(() => {
    initAnalytics();
    track('app_opened');
    setMessages([{
      role: 'assistant',
      type: 'text',
      content: t.greeting
    }]);
  }, []);

  // F2: карусель плейсхолдеров — меняется каждые 3 сек, пока поле пустое
  useEffect(() => {
    if (inputValue) return; // не крутим если человек печатает
    const interval = setInterval(() => {
      setPlaceholderIdx(i => (i + 1) % t.inputPlaceholders.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [inputValue]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // ===== Backend calls =====

  const callBackend = async (mode, payload) => {
    // Если в unlimited режиме — передаём dev-ключ чтобы бэк тоже пропустил
    // Ключ юзер сам ставит в DevTools: localStorage.setItem('recipebot_dev_key', '<секрет с сервера>')
    const headers = { 'Content-Type': 'application/json' };
    try {
      const isUnlimited = localStorage.getItem('recipebot_unlimited') === 'true';
      const devKey = localStorage.getItem('recipebot_dev_key');
      if (isUnlimited && devKey) headers['x-dev-key'] = devKey;
    } catch (e) { /* приватный режим */ }

    const response = await fetch(`${BACKEND_URL}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mode, lang: currentLang, ...payload })
    });
    if (!response.ok) {
      if (response.status === 429) {
        const err = new Error('rate_limited');
        err.code = 'rate_limited';
        throw err;
      }
      throw new Error('Backend error');
    }
    const data = await response.json();
    // Бэк может вернуть { content: [{text}] } для нормального ответа
    // или { notFood: true, message: "..." } для невалидного ввода
    if (data.notFood) {
      return { text: null, notFood: true, message: data.message };
    }
    return { text: data.content[0].text, notFood: false };
  };

  // Обёртка: проверяет клиентский лимит → вызывает бэк → фиксирует использование.
  // Возвращает { text, notFood, message } или null если клиентский лимит сработал.
  const checkAndCall = async (mode, payload) => {
    const check = canDo(mode);
    if (!check.allowed) {
      track('limit_reached', { mode, reason: check.reason });
      setMessages(prev => [...prev, { role: 'assistant', type: 'limit-reached' }]);
      return null;
    }
    try {
      const result = await callBackend(mode, payload);
      // Не списываем кредит если ввод был не едой — это не вина пользователя
      if (!result.notFood) {
        recordUsage(mode);
        setUsageInfo(getUsageInfo());
      }
      return result;
    } catch (error) {
      if (error.code === 'rate_limited') {
        track('limit_reached', { mode, reason: 'server_ip' });
        setMessages(prev => [...prev, { role: 'assistant', type: 'limit-reached' }]);
        return null;
      }
      throw error;
    }
  };

  const getIdea = async (ingredientsList, rejected = [], filterModifier = null) => {
    setIsLoading(true);
    try {
      const result = await checkAndCall('idea', {
        ingredients: ingredientsList,
        rejected,
        filterModifier
      });
      if (result === null) {
        // Лимит исчерпан — сообщение уже добавлено
        setIsLoading(false);
        return;
      }
      // Если ввод оказался не едой — показываем обычный текст без чипсов идеи
      if (result.notFood) {
        track('not_food_response', { source: rejected.length > 0 ? 'filter' : 'initial' });
        setMessages(prev => [...prev, {
          role: 'assistant',
          type: 'text',
          content: result.message
        }]);
        setIsLoading(false);
        return;
      }
      const text = result.text;
      const lines = text.trim().split('\n').filter(l => l.trim());
      const title = lines[0]?.trim() || text;
      const desc = lines[1]?.trim() || '';
      const cleanTitle = stripEmoji(title);

      // Проверяем — не повторяется ли новое предложение с уже отвергнутыми.
      // Если повтор — показываем "идеи исчерпаны" вместо очередной идеи.
      const isRepeat = rejected.some(r => isTooSimilar(title, r));

      if (isRepeat) {
        track('ideas_exhausted', { rejectedCount: rejected.length });
        setMessages(prev => [...prev, {
          role: 'assistant',
          type: 'exhausted'
        }]);
        playTick({ intensity: 0.4 });
      } else {
        track('idea_received', { rejectedCount: rejected.length, hasFilter: !!filterModifier });
        setMessages(prev => [...prev, {
          role: 'assistant',
          type: 'idea',
          title,
          cleanTitle,
          description: desc,
          ingredients: ingredientsList
        }]);
        playTick({ intensity: 0.5 });
      }
    } catch (error) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        type: 'text',
        content: t.errorConnect
      }]);
    }
    setIsLoading(false);
  };

  // ===== User actions =====

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!inputValue.trim() || isLoading) return;

    const userMessage = inputValue;
    track('ingredients_submitted', { source: 'input', length: userMessage.length });
    setInputValue('');
    setIngredients(userMessage);
    setRejectedIdeas([]);
    setMessages(prev => [...prev, { role: 'user', type: 'text', content: userMessage }]);
    await getIdea(userMessage, []);
  };

  // F1: тап по стартовому чипсу
  const handleStarterChip = async (chip) => {
    if (isLoading) return;
    track('starter_chip_clicked', { label: chip.label });
    setIngredients(chip.query);
    setRejectedIdeas([]);
    setMessages(prev => [...prev, { role: 'user', type: 'text', content: `${chip.emoji} ${chip.label}` }]);
    await getIdea(chip.query, []);
  };

  const handleWantRecipe = async (dishTitle) => {
    track('want_recipe_clicked');
    setMessages(prev => [...prev, { role: 'user', type: 'text', content: t.userMsgWantRecipe }]);
    setIsLoading(true);
    try {
      const result = await checkAndCall('recipe', { dish: dishTitle, ingredients });
      if (result === null) {
        setIsLoading(false);
        return;
      }
      // Если "блюдо" оказалось не блюдом — показываем обычный текст
      if (result.notFood) {
        track('not_food_response', { source: 'recipe' });
        setMessages(prev => [...prev, {
          role: 'assistant',
          type: 'text',
          content: result.message
        }]);
        setIsLoading(false);
        return;
      }
      track('recipe_received', { recipeLength: result.text.length });
      setMessages(prev => [...prev, {
        role: 'assistant',
        type: 'recipe',
        dish: dishTitle,
        content: result.text
      }]);
      playTick({ intensity: 1 }); // более звонкий цок на рецепт — главный момент
    } catch (error) {
      track('error', { where: 'recipe' });
      setMessages(prev => [...prev, {
        role: 'assistant',
        type: 'text',
        content: t.errorRecipe
      }]);
    }
    setIsLoading(false);
  };

  const handleWantOther = async (rejectedTitle) => {
    track('want_other_clicked', { rejectedTotal: rejectedIdeas.length + 1 });
    setMessages(prev => [...prev, { role: 'user', type: 'text', content: t.userMsgWantOther }]);
    const newRejected = [...rejectedIdeas, rejectedTitle];
    setRejectedIdeas(newRejected);
    await getIdea(ingredients, newRejected);
  };

  // F6: тап по чипсу-фильтру
  const handleFilterChip = async (chip) => {
    if (isLoading) return;
    track('filter_chip_clicked', { label: chip.label });
    setMessages(prev => [...prev, { role: 'user', type: 'text', content: `${chip.emoji} ${chip.label}` }]);
    await getIdea(ingredients, rejectedIdeas, chip.modifier);
  };

  // Чипс после рецепта (попроще / побыстрее / другое блюдо)
  // Помечает текущее блюдо как rejected и запрашивает новое с модификатором.
  const handleAfterRecipeChip = async (chip, currentDish) => {
    if (isLoading) return;
    track('after_recipe_chip_clicked', { label: chip.label });
    setMessages(prev => [...prev, { role: 'user', type: 'text', content: `${chip.emoji} ${chip.label}` }]);
    const cleanCurrent = stripEmoji(currentDish || '');
    const newRejected = cleanCurrent ? [...rejectedIdeas, cleanCurrent] : rejectedIdeas;
    setRejectedIdeas(newRejected);
    await getIdea(ingredients, newRejected, chip.modifier);
  };

  return (
    <div style={styles.appWrapper}>
      <style>{animationStyles}</style>
      <div style={styles.chatContainer}>

        <div style={styles.header}>
          <div style={styles.avatar}>🍳</div>
          <div style={{ flex: 1 }}>
            <div style={styles.headerTitle}>{t.headerTitle}</div>
            <div style={styles.headerStatus}>{t.headerStatus}</div>
          </div>
          <div style={usageInfo.unlimited ? styles.usageCounterDev : styles.usageCounter} title={usageInfo.unlimited ? 'Unlimited mode — лимиты отключены' : 'Лимит на сегодня'}>
            {usageInfo.unlimited ? (
              <span style={styles.usageNum}>∞</span>
            ) : (
              <>
                <span style={styles.usageNum}>{usageInfo.dailyRemaining}</span>
                <span style={styles.usageLabel}>/{usageInfo.dailyLimit}</span>
              </>
            )}
          </div>
        </div>

        <div style={styles.messagesArea}>
          {messages.map((msg, idx) => (
            <MessageBubble
              key={idx}
              message={msg}
              messageIndex={idx}
              rejectedCount={rejectedIdeas.length}
              onWantRecipe={handleWantRecipe}
              onWantOther={handleWantOther}
              onFilterChip={handleFilterChip}
              onAfterRecipeChip={handleAfterRecipeChip}
              checkAndCall={checkAndCall}
              isLoading={isLoading}
            />
          ))}

          {showStarterChips && (
            <div style={styles.starterChipsWrap} className="msg-appear-delayed">
              {t.starterChips.map((chip, i) => (
                <button
                  key={i}
                  style={styles.starterChip}
                  onClick={() => handleStarterChip(chip)}
                  disabled={isLoading}
                >
                  <span style={{ fontSize: 16 }}>{chip.emoji}</span> {chip.label}
                </button>
              ))}
            </div>
          )}

          {isLoading && <TypingIndicator />}
          <div ref={messagesEndRef} />
        </div>

        <form onSubmit={handleSendMessage} style={styles.inputArea}>
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={t.inputPlaceholders[placeholderIdx]}
            style={styles.input}
            disabled={isLoading}
          />
          <button
            type="submit"
            style={{
              ...styles.sendButton,
              opacity: inputValue.trim() ? 1 : 0.4,
              transform: inputValue.trim() ? 'scale(1)' : 'scale(0.92)'
            }}
            className={inputValue.trim() ? 'send-btn-active' : ''}
            disabled={isLoading || !inputValue.trim()}
            aria-label="Отправить"
          >
            ↑
          </button>
        </form>

      </div>
    </div>
  );
}

function MessageBubble({ message, messageIndex, rejectedCount, onWantRecipe, onWantOther, onFilterChip, onAfterRecipeChip, checkAndCall, isLoading }) {
  if (message.role === 'user') {
    return (
      <div style={{ ...styles.bubbleRow, justifyContent: 'flex-end' }}>
        <div style={styles.userBubble} className="msg-appear-user">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.type === 'idea') {
    return (
      <div style={{ ...styles.bubbleRow, justifyContent: 'flex-start' }}>
        <div style={{ ...styles.assistantBubble, position: 'relative' }} className="msg-appear">
          <Sparkles variant="subtle" />
          <div style={{ marginBottom: '8px', position: 'relative', zIndex: 1 }}>{t.ideaIntro}</div>
          <div style={styles.ideaTitle}>{message.title}</div>
          {message.description && (
            <div style={styles.ideaDesc}>{message.description}</div>
          )}

          <div className="buttons-delayed">
            <div style={styles.ideaPrompt}>{t.ideaPrompt}</div>
            <div style={styles.buttonRow}>
              <button
                style={styles.primaryButton}
                onClick={() => onWantRecipe(message.title)}
                disabled={isLoading}
              >
                {t.btnGiveRecipe}
              </button>
              <button
                style={styles.secondaryButton}
                onClick={() => onWantOther(message.cleanTitle || message.title)}
                disabled={isLoading}
              >
                {t.btnOther}
              </button>
            </div>

            {rejectedCount >= 1 && (
              <div style={styles.filterChipsBlock}>
                <div style={styles.filterHint}>{t.filterHint}</div>
                <div style={styles.filterChipsRow}>
                  {t.filterChips.map((chip, i) => (
                    <button
                      key={i}
                      style={styles.filterChip}
                      onClick={() => onFilterChip(chip)}
                      disabled={isLoading}
                    >
                      <span style={{ fontSize: 13 }}>{chip.emoji}</span> {chip.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (message.type === 'recipe') {
    return (
      <div style={{ ...styles.bubbleRow, justifyContent: 'flex-start' }}>
        <div style={{ ...styles.assistantBubble, maxWidth: '90%', position: 'relative' }} className="msg-appear">
          <Sparkles variant="rich" />
          <FormattedRecipe text={message.content} />
          <NutritionSection dish={message.dish} checkAndCall={checkAndCall} />

          {/* Чипсы после рецепта: попроще / побыстрее / другое */}
          <div style={styles.afterRecipeBlock}>
            <div style={styles.filterHint}>{t.afterRecipeHint}</div>
            <div style={styles.filterChipsRow}>
              {t.afterRecipeChips.map((chip, i) => (
                <button
                  key={i}
                  style={styles.filterChip}
                  onClick={() => onAfterRecipeChip(chip, message.dish)}
                  disabled={isLoading}
                >
                  <span style={{ fontSize: 13 }}>{chip.emoji}</span> {chip.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Состояние "лимит на сегодня исчерпан"
  if (message.type === 'limit-reached') {
    const lr = t.limitReached;
    return (
      <div style={{ ...styles.bubbleRow, justifyContent: 'flex-start' }}>
        <div style={{ ...styles.assistantBubble, position: 'relative' }} className="msg-appear">
          <div style={{ marginBottom: '10px', fontSize: '15px' }}>{lr.intro}</div>
          <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.75)', marginBottom: '10px', lineHeight: '1.5' }}>
            {lr.explanation}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.9)', marginBottom: '12px', lineHeight: '1.5' }}>
            {lr.cta}
          </div>
          <div style={styles.buttonRow}>
            <button
              style={styles.primaryButton}
              onClick={() => alert('Регистрация будет добавлена в следующей версии 🙂')}
              disabled={isLoading}
            >
              {lr.btnLogin}
            </button>
            <button
              style={styles.secondaryButton}
              disabled={true}
            >
              {lr.btnWait}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Состояние "идеи исчерпаны" - честная фраза + предложение базовых продуктов + affiliate-ссылка
  if (message.type === 'exhausted') {
    const ex = t.exhausted;
    return (
      <div style={{ ...styles.bubbleRow, justifyContent: 'flex-start' }}>
        <div style={{ ...styles.assistantBubble, position: 'relative' }} className="msg-appear">
          <div style={{ marginBottom: '10px' }}>{ex.intro}</div>
          <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.85)', marginBottom: '10px' }}>
            {ex.suggestion}
          </div>
          <div style={styles.exhaustedProducts}>
            {ex.products.map((p, i) => (
              <span key={i} style={styles.exhaustedProduct}>
                <span style={{ fontSize: 14 }}>{p.emoji}</span> {p.name}
              </span>
            ))}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', marginTop: '12px', marginBottom: '8px' }}>
            {ex.affiliateHint}
          </div>
          <a
            href={ex.affiliateUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.exhaustedAffiliateBtn}
            onClick={() => track('affiliate_clicked', { source: 'exhausted', partner: 'samokat' })}
          >
            {ex.affiliateButton}
          </a>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', marginTop: '10px', textAlign: 'center' }}>
            {ex.orInput}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...styles.bubbleRow, justifyContent: 'flex-start' }}>
      <div style={styles.assistantBubble} className="msg-appear">
        {message.content}
      </div>
    </div>
  );
}

function NutritionSection({ dish, checkAndCall }) {
  const [state, setState] = useState('hidden');
  const [data, setData] = useState(null);

  const handleToggle = async () => {
    if (state === 'shown') { setState('hidden'); return; }
    track('nutrition_opened');
    setState('loading');
    try {
      const result = await checkAndCall('nutrition', { dish });
      if (result === null) {
        // Лимит исчерпан — limit-reached сообщение уже добавлено в чат
        setState('hidden');
        return;
      }
      if (result.notFood) {
        // Маловероятно для nutrition, но на всякий
        setState('error');
        return;
      }
      const cleaned = result.text.trim().replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      setData(parsed);
      setState('shown');
    } catch (error) {
      console.error(error);
      setState('error');
    }
  };

  return (
    <div style={styles.nutritionWrap}>
      <button onClick={handleToggle} style={styles.nutritionToggle} disabled={state === 'loading'}>
        {state === 'loading' ? t.nutritionLoading
          : state === 'shown' ? t.hideNutrition
          : t.showNutrition}
      </button>
      {state === 'shown' && data && (
        <div style={styles.nutritionGrid} className="msg-appear">
          <NutritionCell value={data.calories} label={t.nutritionLabels.calories} />
          <NutritionCell value={data.protein + 'г'} label={t.nutritionLabels.protein} />
          <NutritionCell value={data.fat + 'г'} label={t.nutritionLabels.fat} />
          <NutritionCell value={data.carbs + 'г'} label={t.nutritionLabels.carbs} />
          <div style={styles.nutritionDisclaimer}>{t.nutritionDisclaimer}</div>
        </div>
      )}
    </div>
  );
}

function NutritionCell({ value, label }) {
  return (
    <div style={styles.nutritionCell}>
      <div style={styles.nutritionValue}>{value}</div>
      <div style={styles.nutritionLabel}>{label}</div>
    </div>
  );
}

// Рендер inline markdown: **жирный** и *курсив* → React элементы
function renderInline(text) {
  // Сначала разбиваем по **жирному**, потом по *курсиву*
  const parts = [];
  let remaining = text;
  let key = 0;
  // **жирный**
  const boldRegex = /\*\*([^*]+)\*\*/g;
  let lastEnd = 0;
  let match;
  while ((match = boldRegex.exec(remaining)) !== null) {
    if (match.index > lastEnd) {
      parts.push(remaining.slice(lastEnd, match.index));
    }
    parts.push(<strong key={key++} style={{ fontWeight: 600 }}>{match[1]}</strong>);
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd < remaining.length) {
    parts.push(remaining.slice(lastEnd));
  }
  // Если ничего не нашли — вернём как есть
  if (parts.length === 0) return text;
  return parts;
}

function FormattedRecipe({ text }) {
  // Разбиваем на строки и фильтруем мусор
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => {
      if (!l) return false;
      // Игнорируем горизонтальные разделители
      if (/^[-*_]{3,}$/.test(l)) return false;
      return true;
    });

  return (
    <div>
      {lines.map((line, idx) => {
        // 1. Заголовок секции: вся строка обёрнута в ** ** (например "**Ингредиенты:**")
        const sectionMatch = line.match(/^\*\*(.+?)\*\*:?\s*$/);
        if (sectionMatch) {
          return (
            <div key={idx} style={styles.recipeSectionHeader}>
              {sectionMatch[1].replace(/:$/, '')}:
            </div>
          );
        }

        // 2. Нумерованный шаг "1. ..." или "1) ..."
        const stepMatch = line.match(/^(\d+)[.)]\s+(.*)$/);
        if (stepMatch) {
          return (
            <div key={idx} style={styles.recipeStep}>
              <span style={styles.recipeStepNum}>{stepMatch[1]}.</span>
              <span>{renderInline(stepMatch[2])}</span>
            </div>
          );
        }

        // 3. Элемент списка "- ..." или "• ..." или "* ..."
        const bulletMatch = line.match(/^[-•*]\s+(.*)$/);
        if (bulletMatch) {
          return (
            <div key={idx} style={styles.recipeIngredient}>
              <span style={styles.recipeBullet}>•</span>
              <span>{renderInline(bulletMatch[1])}</span>
            </div>
          );
        }

        // 4. Подзаголовок внутри списка (например "Для соуса:")
        if (line.endsWith(':') && line.length < 40) {
          return (
            <div key={idx} style={styles.recipeSubheader}>
              {renderInline(line)}
            </div>
          );
        }

        // 5. Обычная строка
        return (
          <div key={idx} style={styles.recipeLine}>
            {renderInline(line)}
          </div>
        );
      })}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div style={{ ...styles.bubbleRow, justifyContent: 'flex-start' }}>
      <div style={styles.typingBubble} className="msg-appear">
        <span style={styles.dot} className="typing-dot-1">●</span>
        <span style={styles.dot} className="typing-dot-2">●</span>
        <span style={styles.dot} className="typing-dot-3">●</span>
      </div>
    </div>
  );
}

const animationStyles = `
  @keyframes msgAppear {
    from { opacity: 0; transform: translateY(12px) scale(0.96); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes msgAppearUser {
    from { opacity: 0; transform: translateX(20px); }
    to { opacity: 1; transform: translateX(0); }
  }
  .msg-appear { animation: msgAppear 0.35s cubic-bezier(0.34, 1.56, 0.64, 1); }
  .msg-appear-user { animation: msgAppearUser 0.28s cubic-bezier(0.2, 0.8, 0.3, 1); }
  .msg-appear-delayed { animation: msgAppear 0.4s 0.2s cubic-bezier(0.34, 1.56, 0.64, 1) both; }

  @keyframes buttonsFadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .buttons-delayed { animation: buttonsFadeIn 0.35s 0.4s ease-out both; }

  @keyframes sendPulse {
    0% { transform: scale(1); }
    50% { transform: scale(1.08); }
    100% { transform: scale(1); }
  }
  .send-btn-active { animation: sendPulse 0.4s ease-out; }

  @keyframes typingPulse {
    0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-4px); }
  }
  .typing-dot-1 { animation: typingPulse 1.2s infinite; }
  .typing-dot-2 { animation: typingPulse 1.2s infinite 0.2s; }
  .typing-dot-3 { animation: typingPulse 1.2s infinite 0.4s; }

  /* === Sparkles: золотые искры по краям сообщения === */
  .sparkle {
    position: absolute;
    pointer-events: none;
    opacity: 0;
    background:
      radial-gradient(circle, rgba(255,225,150,0.95) 0%, rgba(255,200,80,0.6) 30%, rgba(255,180,60,0) 70%);
    border-radius: 50%;
    /* Лёгкое свечение */
    box-shadow: 0 0 8px rgba(255,210,120,0.7);
    /* Используем drift из inline-стиля для лёгкого дрейфа в стороны */
    --drift: 0px;
    transform: translate(-50%, -50%) scale(0);
  }
  .sparkle::before, .sparkle::after {
    content: '';
    position: absolute;
    inset: 0;
    background: inherit;
    border-radius: inherit;
  }
  /* Крестообразное свечение: лучи через ::before и ::after */
  .sparkle::before {
    transform: scaleX(0.18);
  }
  .sparkle::after {
    transform: scaleY(0.18);
  }

  @keyframes sparkleRich {
    0%   { opacity: 0; transform: translate(-50%, -50%) scale(0) rotate(0deg); }
    25%  { opacity: 1; transform: translate(calc(-50% + var(--drift)*0.3), calc(-50% - 3px)) scale(1) rotate(45deg); }
    60%  { opacity: 0.8; transform: translate(calc(-50% + var(--drift)*0.7), calc(-50% - 6px)) scale(0.85) rotate(120deg); }
    100% { opacity: 0; transform: translate(calc(-50% + var(--drift)), calc(-50% - 10px)) scale(0) rotate(180deg); }
  }
  @keyframes sparkleSubtle {
    0%   { opacity: 0; transform: translate(-50%, -50%) scale(0); }
    30%  { opacity: 0.7; transform: translate(calc(-50% + var(--drift)*0.5), -50%) scale(1); }
    100% { opacity: 0; transform: translate(calc(-50% + var(--drift)), calc(-50% - 5px)) scale(0); }
  }
  .sparkle-rich { animation: sparkleRich 1.2s ease-out forwards; }
  .sparkle-subtle { animation: sparkleSubtle 0.9s ease-out forwards; }

  input::placeholder { color: rgba(255,255,255,0.5); transition: opacity 0.3s ease; }
  button:hover:not(:disabled) { filter: brightness(1.08); }
  button:active:not(:disabled) { transform: scale(0.97); }
  * { -webkit-tap-highlight-color: transparent; }
`;

const styles = {
  appWrapper: {
    minHeight: '100vh',
    background: 'linear-gradient(160deg, #143a6e 0%, #1f5694 100%)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '0',
    fontFamily: '-apple-system, system-ui, sans-serif'
  },
  chatContainer: {
    width: '100%', maxWidth: '480px', height: '100vh',
    display: 'flex', flexDirection: 'column',
    background: `
      url("data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'>
  <g fill='none' stroke='rgba(255,255,255,0.11)' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'>
    <!-- Ряд 1 -->
    <g transform='translate(20,22) rotate(-12)'>
      <circle cx='0' cy='2' r='9'/>
      <path d='M-3,-5 Q0,-9 3,-5 M0,-7 L0,-4'/>
    </g>
    <g transform='translate(60,18) rotate(20)'>
      <path d='M-7,0 Q0,-7 7,0 Q0,7 -7,0 Z M-7,0 L7,0'/>
    </g>
    <g transform='translate(100,28) rotate(-25)'>
      <path d='M-2,-7 Q-2,-9 0,-9 Q2,-9 2,-7'/>
      <path d='M-2,-7 Q-4,0 -2,7 Q0,9 2,7 Q4,0 2,-7 Z'/>
    </g>
    <g transform='translate(140,20) rotate(15)'>
      <ellipse cx='0' cy='0' rx='6' ry='8'/>
    </g>
    <!-- Ряд 2 -->
    <g transform='translate(40,58) rotate(-8)'>
      <path d='M-9,2 L9,2 L7,9 L-7,9 Z'/>
      <path d='M-9,2 L-12,2 M9,2 L12,2'/>
      <path d='M-3,-2 Q-1,-4 1,-2 Q3,-4 5,-2'/>
    </g>
    <g transform='translate(85,62) rotate(20)'>
      <ellipse cx='0' cy='0' rx='6' ry='8' transform='rotate(45)'/>
    </g>
    <g transform='translate(125,55) rotate(-20)'>
      <path d='M0,-7 L-4,7 L4,7 Z'/>
      <path d='M0,-7 L-2,-10 M0,-7 L2,-10 M0,-7 L0,-11'/>
    </g>
    <!-- Ряд 3 -->
    <g transform='translate(15,100) rotate(8)'>
      <path d='M-7,-2 Q-7,-7 0,-7 Q7,-7 7,-2 Z'/>
      <path d='M-3,-2 L-3,5 L3,5 L3,-2'/>
    </g>
    <g transform='translate(60,105) rotate(15)'>
      <path d='M0,-6 L2,-2 L6,-2 L3,1 L4,5 L0,3 L-4,5 L-3,1 L-6,-2 L-2,-2 Z'/>
    </g>
    <g transform='translate(105,95) rotate(-15)'>
      <!-- Багет -->
      <ellipse cx='0' cy='0' rx='10' ry='4'/>
      <path d='M-6,-1 L-4,1 M-2,-1 L0,1 M2,-1 L4,1'/>
    </g>
    <g transform='translate(145,100) rotate(10)'>
      <!-- Сыр треугольником -->
      <path d='M-8,4 L8,-2 L8,4 Z'/>
      <circle cx='2' cy='2' r='0.8'/>
      <circle cx='5' cy='3' r='0.8'/>
    </g>
    <!-- Ряд 4 -->
    <g transform='translate(30,140) rotate(-15)'>
      <!-- Рыба -->
      <path d='M-9,0 Q-5,-4 3,-3 Q9,0 3,3 Q-5,4 -9,0 Z'/>
      <path d='M3,-3 L7,-5 L7,5 L3,3'/>
      <circle cx='-3' cy='-1' r='0.7'/>
    </g>
    <g transform='translate(75,138) rotate(12)'>
      <!-- Бокал -->
      <path d='M-5,-7 L5,-7 L4,-1 Q0,2 -4,-1 Z'/>
      <path d='M0,-1 L0,5 M-4,5 L4,5'/>
    </g>
    <g transform='translate(120,145) rotate(-5)'>
      <!-- Перец болгарский -->
      <path d='M-5,-2 Q-7,2 -4,6 Q0,8 4,6 Q7,2 5,-2 Q5,-5 0,-5 Q-5,-5 -5,-2 Z'/>
      <path d='M-1,-5 L-1,-8 L2,-7'/>
    </g>
  </g>
</svg>
      `).replace(/\s+/g, ' ')}"),
      linear-gradient(160deg, #1a4d8f 0%, #2d6cb5 50%, #3a7fd0 100%)
    `,
    backgroundSize: '160px 160px, auto',
    backgroundRepeat: 'repeat, no-repeat',
    overflow: 'hidden'
  },
  header: {
    background: 'rgba(255,255,255,0.12)',
    backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
    padding: '16px 20px',
    display: 'flex', alignItems: 'center', gap: '12px',
    borderBottom: '1px solid rgba(255,255,255,0.1)'
  },
  avatar: {
    width: '42px', height: '42px', borderRadius: '50%',
    background: 'rgba(255,255,255,0.2)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '22px'
  },
  headerTitle: { color: '#fff', fontSize: '16px', fontWeight: '500' },
  headerStatus: { color: 'rgba(255,255,255,0.6)', fontSize: '12px' },
  usageCounter: {
    background: 'rgba(255,255,255,0.12)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '14px',
    padding: '5px 10px',
    fontSize: '12px',
    color: 'rgba(255,255,255,0.85)',
    display: 'flex',
    alignItems: 'baseline',
    gap: '1px',
  },
  usageCounterDev: {
    background: 'rgba(74, 222, 128, 0.2)',
    border: '1px solid rgba(74, 222, 128, 0.5)',
    borderRadius: '14px',
    padding: '5px 12px',
    fontSize: '14px',
    color: '#4ade80',
    display: 'flex',
    alignItems: 'center',
    fontWeight: '600',
  },
  usageNum: {
    fontWeight: '600',
    color: '#fff',
    fontSize: '14px',
  },
  usageLabel: {
    color: 'rgba(255,255,255,0.5)',
  },
  messagesArea: {
    flex: 1, overflowY: 'auto',
    padding: '20px 16px',
    display: 'flex', flexDirection: 'column', gap: '14px'
  },
  bubbleRow: { display: 'flex', width: '100%' },
  userBubble: {
    maxWidth: '80%',
    background: 'rgba(255,255,255,0.92)',
    borderRadius: '18px 18px 4px 18px',
    padding: '12px 16px',
    color: '#1a3a5c', fontSize: '14px', lineHeight: '1.5',
    wordWrap: 'break-word'
  },
  assistantBubble: {
    maxWidth: '85%',
    background: 'rgba(255,255,255,0.15)',
    backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '18px 18px 18px 4px',
    padding: '14px 16px',
    color: '#fff', fontSize: '14px', lineHeight: '1.6',
    wordWrap: 'break-word'
  },
  typingBubble: {
    background: 'rgba(255,255,255,0.15)',
    backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '18px 18px 18px 4px',
    padding: '14px 18px',
    display: 'flex', gap: '4px'
  },
  dot: { color: 'rgba(255,255,255,0.8)', fontSize: '8px', display: 'inline-block' },

  ideaTitle: { fontSize: '17px', fontWeight: '500', color: '#fff', marginTop: '4px' },
  ideaDesc: { fontSize: '13px', color: 'rgba(255,255,255,0.7)', marginTop: '4px' },
  ideaPrompt: { fontSize: '13px', color: 'rgba(255,255,255,0.85)', marginTop: '12px' },
  buttonRow: { display: 'flex', gap: '8px', marginTop: '10px' },
  primaryButton: {
    flex: 1,
    background: 'rgba(255,255,255,0.92)', color: '#1a4d8f',
    border: 'none', borderRadius: '12px',
    padding: '10px', fontSize: '13px', fontWeight: '500',
    cursor: 'pointer',
    transition: 'transform 0.15s, filter 0.15s'
  },
  secondaryButton: {
    flex: 1,
    background: 'rgba(255,255,255,0.12)', color: '#fff',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '12px',
    padding: '10px', fontSize: '13px',
    cursor: 'pointer',
    transition: 'transform 0.15s, filter 0.15s'
  },

  starterChipsWrap: {
    display: 'flex', flexWrap: 'wrap', gap: '8px',
    marginLeft: '2px', marginTop: '-4px'
  },
  starterChip: {
    background: 'rgba(255,255,255,0.15)',
    color: '#fff',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '20px',
    padding: '8px 14px',
    fontSize: '13px',
    cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    transition: 'transform 0.15s, filter 0.15s, background 0.2s'
  },

  filterChipsBlock: {
    marginTop: '14px',
    paddingTop: '12px',
    borderTop: '1px solid rgba(255,255,255,0.12)'
  },
  afterRecipeBlock: {
    marginTop: '16px',
    paddingTop: '12px',
    borderTop: '1px solid rgba(255,255,255,0.12)'
  },
  filterHint: {
    fontSize: '12px',
    color: 'rgba(255,255,255,0.6)',
    marginBottom: '8px'
  },
  filterChipsRow: {
    display: 'flex', flexWrap: 'wrap', gap: '6px'
  },
  filterChip: {
    background: 'rgba(255,255,255,0.1)',
    color: '#fff',
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: '14px',
    padding: '5px 10px',
    fontSize: '12px',
    cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    transition: 'transform 0.15s, filter 0.15s'
  },

  recipeSectionHeader: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#fff',
    marginTop: '14px',
    marginBottom: '8px',
    letterSpacing: '0.2px'
  },
  recipeSubheader: {
    fontSize: '13px',
    fontWeight: '500',
    color: 'rgba(255,255,255,0.9)',
    marginTop: '8px',
    marginBottom: '4px'
  },
  recipeStep: {
    fontSize: '14px',
    color: 'rgba(255,255,255,0.95)',
    marginBottom: '10px',
    lineHeight: '1.55',
    display: 'flex',
    gap: '8px'
  },
  recipeStepNum: {
    color: 'rgba(255,255,255,0.6)',
    fontWeight: '500',
    flexShrink: 0,
    minWidth: '18px'
  },
  recipeIngredient: {
    fontSize: '14px',
    color: 'rgba(255,255,255,0.9)',
    marginBottom: '5px',
    lineHeight: '1.5',
    display: 'flex',
    gap: '8px'
  },
  recipeBullet: {
    color: 'rgba(255,255,255,0.5)',
    flexShrink: 0
  },
  recipeLine: {
    fontSize: '14px',
    color: 'rgba(255,255,255,0.9)',
    marginBottom: '8px',
    lineHeight: '1.55'
  },

  nutritionWrap: {
    marginTop: '14px',
    paddingTop: '10px',
    borderTop: '1px solid rgba(255,255,255,0.12)'
  },
  nutritionToggle: {
    background: 'transparent',
    color: 'rgba(255,255,255,0.7)',
    border: 'none',
    fontSize: '12px',
    cursor: 'pointer',
    padding: 0,
    textDecoration: 'underline',
    textDecorationStyle: 'dotted',
    textUnderlineOffset: '3px'
  },
  nutritionGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '8px',
    marginTop: '10px',
    position: 'relative'
  },
  nutritionCell: {
    background: 'rgba(255,255,255,0.1)',
    borderRadius: '10px',
    padding: '8px 6px',
    textAlign: 'center'
  },
  nutritionValue: { fontSize: '15px', fontWeight: '500', color: '#fff' },
  nutritionLabel: { fontSize: '10px', color: 'rgba(255,255,255,0.6)', marginTop: '2px' },
  nutritionDisclaimer: {
    gridColumn: '1 / -1',
    fontSize: '11px',
    color: 'rgba(255,255,255,0.5)',
    textAlign: 'center',
    marginTop: '2px'
  },

  // Sparkles layer — на всю bubble, искры могут выходить за края
  sparklesLayer: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    overflow: 'visible',
    zIndex: 0
  },

  // Exhausted state: продукты-чипсы и affiliate-кнопка
  exhaustedProducts: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
  },
  exhaustedProduct: {
    background: 'rgba(255,255,255,0.12)',
    color: '#fff',
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: '14px',
    padding: '5px 10px',
    fontSize: '12px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
  },
  exhaustedAffiliateBtn: {
    display: 'block',
    background: 'rgba(255,255,255,0.92)',
    color: '#1a4d8f',
    border: 'none',
    borderRadius: '12px',
    padding: '11px',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
    textDecoration: 'none',
    textAlign: 'center',
  },

  inputArea: {
    background: 'rgba(255,255,255,0.12)',
    backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
    padding: '14px 16px',
    display: 'flex', gap: '10px', alignItems: 'center',
    borderTop: '1px solid rgba(255,255,255,0.1)'
  },
  input: {
    flex: 1,
    background: 'rgba(255,255,255,0.15)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '22px',
    padding: '12px 18px',
    color: '#fff', fontSize: '14px',
    outline: 'none'
  },
  sendButton: {
    width: '44px', height: '44px',
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.92)',
    border: 'none',
    color: '#1a4d8f',
    fontSize: '20px',
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    transition: 'opacity 0.25s, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)'
  }
};

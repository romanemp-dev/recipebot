// src/analytics.js
// Единая точка для всех событий аналитики.
// Поддерживает Yandex.Metrika + PostHog. Можно добавить другие позже.
//
// Использование:
//   import { track } from './analytics';
//   track('recipe_received', { dish: 'pasta' });
//
// Конфиг через ENV:
//   REACT_APP_YANDEX_METRIKA_ID=12345678
//   REACT_APP_POSTHOG_KEY=phc_xxxxxxxxxx
//   REACT_APP_POSTHOG_HOST=https://eu.posthog.com (опционально)
//
// Если переменные не заданы — модуль работает в no-op режиме (логирует в консоль).

const YM_ID = process.env.REACT_APP_YANDEX_METRIKA_ID;
const PH_KEY = process.env.REACT_APP_POSTHOG_KEY;
const PH_HOST = process.env.REACT_APP_POSTHOG_HOST || 'https://eu.i.posthog.com';

let initialized = false;

// === Инициализация ===
// Вызывается один раз при загрузке приложения.
export function initAnalytics() {
  if (initialized) return;
  initialized = true;

  // Yandex.Metrika
  if (YM_ID && typeof window !== 'undefined') {
    try {
      // Стандартный snippet от Метрики
      (function(m, e, t, r, i, k, a) {
        m[i] = m[i] || function() { (m[i].a = m[i].a || []).push(arguments); };
        m[i].l = 1 * new Date();
        for (let j = 0; j < document.scripts.length; j++) {
          if (document.scripts[j].src === r) return;
        }
        k = e.createElement(t); a = e.getElementsByTagName(t)[0];
        k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
      })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');

      window.ym(YM_ID, 'init', {
        clickmap: true,
        trackLinks: true,
        accurateTrackBounce: true,
        webvisor: true, // запись сессий, очень полезно на старте
      });

      console.log('[analytics] Yandex.Metrika initialized:', YM_ID);
    } catch (e) {
      console.warn('[analytics] YM init failed:', e);
    }
  }

  // PostHog
  if (PH_KEY && typeof window !== 'undefined') {
    try {
      // Lightweight встраивание PostHog через скрипт
      const script = document.createElement('script');
      script.async = true;
      script.src = `${PH_HOST}/static/array.js`;
      document.head.appendChild(script);

      // Создаём прокси PostHog который буферизует события до загрузки реального скрипта
      window.posthog = window.posthog || [];
      const ph = window.posthog;
      ph.snippet_version = '1.0';
      const methods = ['init', 'capture', 'identify', 'set_config', 'reset'];
      methods.forEach(method => {
        ph[method] = ph[method] || function() {
          (ph._queue = ph._queue || []).push([method, arguments]);
        };
      });

      ph.init(PH_KEY, {
        api_host: PH_HOST,
        capture_pageview: true,
        capture_pageleave: true,
        disable_session_recording: false,
      });

      console.log('[analytics] PostHog initialized');
    } catch (e) {
      console.warn('[analytics] PostHog init failed:', e);
    }
  }

  if (!YM_ID && !PH_KEY) {
    console.log('[analytics] No keys set — running in dev (console-only) mode');
  }
}

// === Отслеживание события ===
// event: snake_case название, например 'recipe_received'
// props: объект с дополнительными данными — БЕЗ PII
export function track(event, props = {}) {
  if (!initialized) initAnalytics();

  // Всегда логируем в консоль — удобно при разработке
  console.log('[analytics]', event, props);

  try {
    // Yandex.Metrika — события передаются через reachGoal
    if (YM_ID && window.ym) {
      window.ym(YM_ID, 'reachGoal', event, props);
    }
    // PostHog — capture
    if (PH_KEY && window.posthog) {
      window.posthog.capture(event, props);
    }
  } catch (e) {
    console.warn('[analytics] track failed:', e);
  }
}

// === Идентификация пользователя ===
// Когда подключим логин, будем вызывать identify(phoneOrUserId)
// чтобы связать события до и после логина
export function identify(userId, traits = {}) {
  if (!initialized) initAnalytics();
  try {
    if (PH_KEY && window.posthog) {
      window.posthog.identify(userId, traits);
    }
    // YM использует userParams для атрибутов
    if (YM_ID && window.ym) {
      window.ym(YM_ID, 'setUserID', userId);
      if (Object.keys(traits).length) {
        window.ym(YM_ID, 'userParams', traits);
      }
    }
  } catch (e) {
    console.warn('[analytics] identify failed:', e);
  }
}

// === Сброс (для logout) ===
export function reset() {
  try {
    if (PH_KEY && window.posthog) window.posthog.reset();
  } catch (e) { /* */ }
}
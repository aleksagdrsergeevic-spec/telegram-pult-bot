#!/usr/bin/env node
import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, ConfigError } from './config.js';
import { createLogger } from './logger.js';
import { Telegram, TelegramError } from './telegram.js';
import { SessionStore } from './sessions.js';
import { OpenCode, stripAnsi, isModelAccessDisabled } from './opencode.js';
import { cleanAgentOutput } from './text.js';
import { estimateTokens } from './models.js';
import { startWebServer } from './web.js';
import { HistoryStore } from './history.js';

const MAX_MESSAGE = 4000;
const MAX_QUEUE = 5;

let cfg;
let log;
let tg;
let store;
let history;
let oc;
let botUsername = null;
let stopping = false;
let webServer = null;
const startedAt = Date.now();

/** Очередь задач: chatId -> хвост цепочки */
const queues = new Map();
/** Сколько задач ждёт (включая выполняющуюся): chatId -> число */
const queueDepth = new Map();
/** chatId -> { name, startedAt, kill, prompt } */
const activeTasks = new Map();
/** Блокировки на рабочую папку: name -> хвост */
const workspaceLocks = new Map();
/** chatId -> имена сессий, показанные в последнем /sessions */
const callbackSessions = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Утилиты                                                             */
/* ------------------------------------------------------------------ */

function isAllowed(chatId) {
  return cfg.allowedChatIds.includes(String(chatId));
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} ч ${m} мин`;
  if (m > 0) return `${m} мин ${s} с`;
  return `${s} с`;
}

function splitText(text, size = MAX_MESSAGE) {
  const parts = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length) parts.push(rest);
  return parts;
}

/* ------------------------------------------------------------------ */
/* Блокировка по рабочей папке                                         */
/* ------------------------------------------------------------------ */

/** Если задача держит папку дольше таймаута задачи, блокировка считается зависшей. */
function staleLockMs() {
  return cfg.taskTimeoutMs + 120000;
}

async function withWorkspaceLock(key, fn, owner = '') {
  const now = Date.now();
  let entry = workspaceLocks.get(key);
  if (entry && now - entry.since > staleLockMs()) {
    log.warn(`блокировка «${key}» висит ${Math.round((now - entry.since) / 1000)} с — снимаю принудительно`);
    workspaceLocks.delete(key);
    entry = undefined;
  }

  const prev = entry ? entry.tail : Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate);
  const mine = { tail, since: now, owner: owner || '—' };
  workspaceLocks.set(key, mine);

  const waitedAt = Date.now();
  try {
    await prev;
    const waited = Date.now() - waitedAt;
    if (waited > 30000) {
      log.warn(`ждал блокировку «${key}» ${Math.round(waited / 1000)} с`);
    }
    return await fn();
  } finally {
    release();
    if (workspaceLocks.get(key) === mine) workspaceLocks.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/* Очередь на чат                                                      */
/* ------------------------------------------------------------------ */

function enqueueTask(chatId, prompt) {
  const key = String(chatId);
  const depth = (queueDepth.get(key) || 0) + 1;
  if (depth > MAX_QUEUE) {
    void tg
      .sendMessage(chatId, `Очередь переполнена (${MAX_QUEUE} задач). Дождитесь выполнения или /stop.`)
      .catch(() => {});
    return;
  }
  queueDepth.set(key, depth);
  if (depth > 1) {
    void tg.sendMessage(chatId, `В очереди: ${depth - 1}`).catch(() => {});
  }

  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(() => runTask(chatId, prompt)).catch((err) => {
    log.error('задача упала', err);
  });

  const tracked = run.finally(() => {
    const left = (queueDepth.get(key) || 1) - 1;
    if (left <= 0) queueDepth.delete(key);
    else queueDepth.set(key, left);
    if (queues.get(key) === tracked) queues.delete(key);
  });
  queues.set(key, tracked);
}

/* ------------------------------------------------------------------ */
/* Стриминг ответа в одно сообщение                                    */
/* ------------------------------------------------------------------ */

function createStreamer({ chatId, messageId, intervalMs, windowSize, logger }) {
  let buffer = '';
  let lastText = '';
  let lastFlush = 0;
  let timer = null;
  let busy = false;
  let closed = false;

  const render = () => {
    const clean = stripAnsi(buffer).replace(/\n{3,}/g, '\n\n').trim();
    if (!clean) return '';
    const tail = clean.length > windowSize ? `…\n${clean.slice(-windowSize)}` : clean;
    return `${tail}\n\n▌`;
  };

  async function flush() {
    if (busy || closed) return;
    const text = render();
    if (!text || text === lastText) return;
    busy = true;
    try {
      await tg.editText(chatId, messageId, text);
      lastText = text;
      lastFlush = Date.now();
    } catch (err) {
      logger.debug(`stream edit: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  function schedule() {
    if (closed || timer) return;
    const wait = Math.max(0, cfg.editIntervalMs - (Date.now() - lastFlush));
    timer = setTimeout(() => {
      timer = null;
      void flush().then(() => {
        if (!closed && render() && render() !== lastText) schedule();
      });
    }, wait);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    push(chunk) {
      if (closed) return;
      buffer += chunk;
      if (buffer.length > 400000) buffer = buffer.slice(-200000);
      schedule();
    },
    reset() {
      buffer = '';
      lastText = '';
      lastFlush = 0;
    },
    stop() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get buffer() {
      return buffer;
    },
  };
}

function startTyping(chatId) {
  const tick = () => {
    void tg.sendChatAction(chatId, 'typing').catch(() => {});
  };
  tick();
  const timer = setInterval(tick, 4500);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Итоговый ответ                                                      */
/* ------------------------------------------------------------------ */

function buildFinalText({ res, sessionName, elapsed }) {
  const body = stripAnsi(res.output || '').trim();

  if (/model access is disabled/i.test(`${body}${stripAnsi(res.stderr || '')}`)) {
    return [
      '❌ Модель недоступна: доступ к ней выключен в OpenCode Console.',
      '',
      'Включите её на https://opencode.ai/console (раздел Models) или выберите другую модель в шапке MiniApp / командой /model.',
    ].join('\n');
  }

  if (res.missing) {
    return [
      '❌ OpenCode не найден на сервере.',
      '',
      'Установите: npm i -g opencode-ai@latest',
      'Затем: systemctl restart telegram-pult',
    ].join('\n');
  }
  if (res.timedOut) {
    return [`⏰ Таймаут задачи (${formatDuration(cfg.taskTimeoutMs)}), OpenCode остановлен.`, '', body]
      .join('\n')
      .trim();
  }
  if (res.idle) {
    return [
      `⏸ Задача остановлена: ${formatDuration(cfg.idleTimeoutMs)} без единой строки вывода.`,
      'Похоже, OpenCode встал на входе в аккаунт или потерял связь с моделью.',
      '',
      body,
    ]
      .join('\n')
      .trim();
  }
  if (res.stopped) {
    return [`⏹ Остановлено (${elapsed}).`, '', body].join('\n').trim();
  }
  if (res.code !== 0) {
    const err = stripAnsi(res.stderr || '').trim();
    return [`❌ OpenCode завершился с кодом ${res.code} (${elapsed}).`, '', body || err || '(без вывода)']
      .join('\n')
      .trim();
  }
  return [`✅ ${sessionName} · ${elapsed}`, '', body || '(пустой вывод)'].join('\n');
}

async function deliverFinal(chatId, messageId, text) {
  const clean = String(text || '').trim() || '✅ Готово (пустой вывод)';

  if (clean.length <= MAX_MESSAGE) {
    if (messageId) {
      await tg.editText(chatId, messageId, clean);
      return;
    }
    await tg.sendMessage(chatId, clean);
    return;
  }

  const parts = splitText(clean, MAX_MESSAGE);
  if (messageId) await tg.editText(chatId, messageId, parts[0]);
  else await tg.sendMessage(chatId, parts[0]);

  if (parts.length <= 3) {
    for (const part of parts.slice(1)) {
      await tg.sendMessage(chatId, part);
    }
    return;
  }

  await tg.sendDocument(chatId, `opencode-output-${Date.now()}.txt`, clean, 'Полный вывод задачи').catch(async (err) => {
    log.warn(`sendDocument: ${err.message}`);
    for (const part of parts.slice(1, 6)) {
      await tg.sendMessage(chatId, part).catch(() => {});
    }
  });
}

/* ------------------------------------------------------------------ */
/* Выполнение задачи                                                   */
/* ------------------------------------------------------------------ */

async function runTask(chatId, prompt) {
  const key = String(chatId);
  let session = store.getCurrent();

  if (!session) {
    await tg.sendMessage(chatId, 'Сначала создайте сессию: /new <имя> (или /new <git-url>)').catch(() => {});
    return;
  }
  if (session.missing) {
    await tg
      .sendMessage(chatId, `Папка сессии «${session.name}» пропала: ${session.path}\nСоздайте новую: /new <имя>`)
      .catch(() => {});
    return;
  }
  if (prompt.length > cfg.promptMaxLength) {
    await tg
      .sendMessage(chatId, `Слишком длинная задача: ${prompt.length} символов, максимум ${cfg.promptMaxLength}.`)
      .catch(() => {});
    return;
  }

  const started = Date.now();
  const typing = startTyping(chatId);
  history.append(session.name, 'user', prompt);

  let placeholder = null;
  try {
    placeholder = await tg.sendMessage(chatId, `⏳ работаю: ${session.name}…`, {
      disable_notification: true,
    });
  } catch (err) {
    log.warn(`не смог отправить сообщение в ${key}: ${err.message}`);
  }

  const placeholderId = placeholder ? placeholder.message_id : null;
  let outputBuffer = '';

  // Поток вывода в чат — только если явно включён STREAMING=1.
  const streamer =
    placeholderId && cfg.streaming
      ? createStreamer({
          chatId,
          messageId: placeholderId,
          intervalMs: cfg.editIntervalMs,
          windowSize: cfg.streamWindow,
          logger: log,
        })
      : null;

  // В тихом режиме раз в минуту обновляем только «работаю · сколько прошло».
  let heartbeat = null;
  if (placeholderId && !cfg.streaming) {
    heartbeat = setInterval(() => {
      void tg
        .editText(
          chatId,
          placeholderId,
          `⏳ работаю: ${session.name} · ${formatDuration(Date.now() - started)}`,
        )
        .catch(() => {});
    }, 60000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
  }

  const onChunk = (text) => {
    outputBuffer += text;
    const running = activeTasks.get(key);
    if (running) running.lastOutputAt = Date.now();
    if (streamer) streamer.push(text);
  };

  const runOnce = (sessionId, resume, modelOverride) => {
    const handle = oc.start({
      cwd: session.path,
      prompt,
      sessionId,
      resume,
      model: modelOverride || session.model || cfg.model,
      timeoutMs: cfg.taskTimeoutMs,
      idleTimeoutMs: cfg.idleTimeoutMs,
      onChunk,
    });
    activeTasks.set(key, { name: session.name, startedAt: started, lastOutputAt: Date.now(), kill: handle.kill, prompt });
    return handle.promise;
  };

  let res;
  let modelNote = '';
  try {
    const usedModel = session.model || cfg.model;
    res = await withWorkspaceLock(session.name, () => runOnce(session.openCodeSessionId, session.hasRun), key);

    // Модель выключена в OpenCode Console — один раз повторяем на модели по умолчанию.
    if (isModelAccessDisabled(res) && usedModel !== cfg.model) {
      log.warn(`модель ${usedModel} недоступна (access disabled) — повторяю на ${cfg.model}`);
      modelNote = `⚠️ Модель ${usedModel} недоступна (доступ выключен в OpenCode Console). Переключился на ${cfg.model}.\n\n`;
      store.setModel(session.name, null);
      outputBuffer = '';
      if (streamer) streamer.reset();
      session = store.get(session.name) || session;
      res = await withWorkspaceLock(session.name, () => runOnce(null, false, cfg.model), key);
    }

    if (
      res &&
      !res.missing &&
      res.code !== 0 &&
      !res.stopped &&
      !res.timedOut &&
      !res.idle &&
      (session.openCodeSessionId || session.hasRun) &&
      /session|continue/i.test(`${res.stderr || ''}${res.output || ''}`)
    ) {
      log.warn(
        `возобновление сессии не удалось (sessionId=${session.openCodeSessionId || '—'}), стартую задачу с чистого листа`,
      );
      store.setOpenCodeSession(session.name, null);
      outputBuffer = '';
      if (streamer) streamer.reset();
      const fresh = store.get(session.name) || session;
      session = fresh;
      res = await withWorkspaceLock(session.name, () => runOnce(null, false), key);
    }

    if (res && !res.missing) {
      if (res.sessionId) store.setOpenCodeSession(session.name, res.sessionId);
      if (res.code === 0) store.markRun(session.name);
    }
  } catch (err) {
    log.error('ошибка выполнения', err);
    res = {
      code: -1,
      output: outputBuffer,
      stderr: err.message,
      timedOut: false,
      stopped: false,
      missing: false,
    };
  } finally {
    activeTasks.delete(key);
    typing.stop();
    if (heartbeat) clearInterval(heartbeat);
    if (streamer) streamer.stop();
  }

  const elapsed = formatDuration(Date.now() - started);
  const finalRes = { ...res, output: cleanAgentOutput(res.output || '') };
  log.info(
    `задача в «${session.name}»: код ${res.code}, ${elapsed}, вывода ${(finalRes.output || '').length} симв.` +
      `${res.stopped ? ', остановлено' : ''}${res.timedOut ? ', таймаут' : ''}${res.idle ? ', тишина' : ''}`,
  );
  if (res.stderr && res.code !== 0) log.warn(`stderr opencode: ${stripAnsi(res.stderr).slice(-500)}`);
  const text = modelNote + buildFinalText({ res: finalRes, sessionName: session.name, elapsed });
  store.addTokens(session.name, estimateTokens(prompt), estimateTokens(finalRes.output || ''));
  history.append(session.name, 'assistant', stripAnsi(finalRes.output || text || '').trim() || text);
  await deliverFinal(chatId, placeholderId, text).catch((err) => {
    log.error('не смог отправить итог', err);
  });
}

/* ------------------------------------------------------------------ */
/* Команды                                                             */
/* ------------------------------------------------------------------ */

function helpText(chatId) {
  return [
    '👋 Telegram-пульт для OpenCode.',
    '',
    `Ваш chat id: ${chatId}`,
    botUsername ? `Бот: @${botUsername}` : null,
    '',
    'Сессии (рабочие папки на сервере):',
    '/new <имя> — новая папка',
    '/new <git-url> — клонировать репозиторий',
    '/sessions — список и переключение',
    '/use <имя> — переключить сессию',
    '/status — текущая сессия и задача',
    '/stop — прервать задачу',
    '/model — модель и список доступных',
    '/help — эта справка',
    '',
    'Просто отправьте текст — он станет задачей для OpenCode',
    'в папке текущей сессии. Ответ продолжит ту же сессию OpenCode.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

async function handleCommand(chatId, text) {
  const head = text.split(/\s+/)[0];
  const cmd = head.split('@')[0].toLowerCase();
  const arg = text.slice(head.length).trim();

  switch (cmd) {
    case '/start':
    case '/help':
      await tg.sendMessage(chatId, helpText(chatId)).catch(() => {});
      return;

    case '/sessions':
      await handleSessions(chatId);
      return;

    case '/new':
      await handleNew(chatId, arg);
      return;

    case '/use':
      await handleUse(chatId, arg);
      return;

    case '/status':
      await handleStatus(chatId);
      return;

    case '/stop':
      await handleStop(chatId);
      return;

    case '/model':
      await handleModel(chatId);
      return;

    case '/id':
      await tg.sendMessage(chatId, `chat id: ${chatId}`).catch(() => {});
      return;

    default:
      await tg.sendMessage(chatId, `Не знаю команду ${cmd}. Справка: /help`).catch(() => {});
  }
}

async function handleSessions(chatId) {
  const items = store.list();
  const current = store.getCurrent();

  if (!items.length) {
    await tg.sendMessage(chatId, 'Сессий пока нет. Создайте: /new <имя> или /new <git-url>').catch(() => {});
    return;
  }

  const shown = items.slice(0, 24);
  callbackSessions.set(
    String(chatId),
    shown.map((item) => item.name),
  );

  const keyboard = shown.map((item, index) => [
    {
      text: `${current && current.name === item.name ? '✅ ' : ''}${item.name}`.slice(0, 60),
      callback_data: `use:${index}`,
    },
  ]);

  const lines = [
    '🧭 Сессии:',
    '',
    ...shown.map(
      (item, i) =>
        `${i + 1}. ${item.name}${current && current.name === item.name ? ' ← текущая' : ''}${
          item.openCodeSessionId ? '' : ' (новая)'
        }`,
    ),
    '',
    'Переключение — кнопкой ниже или /use <имя>.',
  ];

  const body = lines.join('\n');
  try {
    await tg.sendMessage(chatId, body, { reply_markup: { inline_keyboard: keyboard } });
  } catch (err) {
    log.warn(`sessions keyboard: ${err.message}`);
    await tg.sendMessage(chatId, body).catch(() => {});
  }
}

async function handleNew(chatId, arg) {
  if (!arg) {
    await tg
      .sendMessage(chatId, 'Использование:\n/new <имя> — пустая папка\n/new <git-url> — клонировать репозиторий')
      .catch(() => {});
    return;
  }

  await tg.sendMessage(chatId, '⏳ Создаю сессию…', { disable_notification: true }).catch(() => {});
  try {
    const item = await store.create(arg);
    store.use(item.name);
    await tg
      .sendMessage(chatId, [`✅ Сессия «${item.name}» создана и выбрана.`, `📁 ${item.path}`, '', 'Отправляйте задачу текстом.'].join('\n'))
      .catch(() => {});
  } catch (err) {
    await tg.sendMessage(chatId, `❌ ${err.message}`).catch(() => {});
  }
}

async function handleUse(chatId, arg) {
  if (!arg) {
    await tg.sendMessage(chatId, 'Использование: /use <имя>\nСписок: /sessions').catch(() => {});
    return;
  }
  try {
    const item = store.use(arg);
    await tg.sendMessage(chatId, `✅ Текущая сессия: ${item.name}\n📁 ${item.path}`).catch(() => {});
  } catch (err) {
    await tg.sendMessage(chatId, `❌ ${err.message}`).catch(() => {});
  }
}

async function handleStatus(chatId) {
  const current = store.getCurrent();
  const task = activeTasks.get(String(chatId));
  const waiting = Math.max(0, (queueDepth.get(String(chatId)) || 0) - (task ? 1 : 0));

  const lines = [
    `🧭 Сессия: ${current ? current.name : '— не выбрана'}`,
    current ? `📁 Путь: ${current.path}` : '',
    `🤖 Модель: ${(current && current.model) || cfg.model}`,
    `⚙️ OpenCode: ${oc.version || '?'} (session=${oc.caps.session ? 'да' : 'нет'}, continue=${oc.caps.continue ? 'да' : 'нет'})`,
    task
      ? `⏳ Задача: идёт ${formatDuration(Date.now() - task.startedAt)} (${task.name}), тишина ${formatDuration(
          Date.now() - (task.lastOutputAt || task.startedAt),
        )}`
      : '⏳ Задача: нет',
    waiting ? `⌛ В очереди: ${waiting}` : '',
    `🕒 Аптайм: ${formatDuration(Date.now() - startedAt)}`,
    `👥 Разрешённых чатов: ${cfg.allowedChatIds.length}`,
    `🗂 Сессий: ${store.list().length}`,
  ].filter(Boolean);

  await tg.sendMessage(chatId, lines.join('\n')).catch(() => {});
}

async function handleStop(chatId) {
  const key = String(chatId);
  let task = activeTasks.get(key);
  if (!task) {
    // Задача могла быть запущена из MiniApp или из другого чата в той же папке.
    const current = store.getCurrent();
    if (current) {
      for (const [, running] of activeTasks) {
        if (running.name === current.name) {
          task = running;
          break;
        }
      }
    }
  }
  if (!task) {
    await tg.sendMessage(chatId, 'Нечего останавливать.').catch(() => {});
    return;
  }
  task.kill('stop');
  await tg.sendMessage(chatId, '⏹ Останавливаю задачу…').catch(() => {});
}

async function handleModel(chatId) {
  const lines = [`🤖 Текущая модель: ${cfg.model}`, ''];

  const res = await oc.models().catch((err) => ({ code: -1, text: '', error: err.message }));

  if (res.missing) {
    lines.push('⚠️ OpenCode не найден на сервере.');
  } else if (res.code === 0 && res.text) {
    const models = res.text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const opencodeModels = models.filter((m) => /^opencode\//.test(m));
    if (opencodeModels.length) {
      lines.push('Модели провайдера opencode:', ...opencodeModels.slice(0, 25).map((m) => `• ${m}`));
    } else {
      lines.push('В списке нет моделей opencode/* — для бесплатных моделей нужен вход:');
      lines.push('pult-opencode auth login');
    }
    lines.push('', `Всего моделей: ${models.length}`);
  } else {
    lines.push('⚠️ Не удалось получить список моделей (opencode models).');
    if (res.error) lines.push(stripAnsi(res.error).slice(-600));
    lines.push('', 'Для бесплатных моделей нужен вход: opencode auth login');
  }

  lines.push('', 'Сменить модель: MODEL=... в .env и systemctl restart telegram-pult');
  for (const part of splitText(lines.join('\n'), MAX_MESSAGE).slice(0, 3)) {
    await tg.sendMessage(chatId, part).catch(() => {});
  }
}

async function handleCallback(query) {
  const chatId = query.message && query.message.chat ? query.message.chat.id : null;
  if (!chatId) {
    await tg.answerCallbackQuery(query.id, '').catch(() => {});
    return;
  }
  if (!isAllowed(chatId)) {
    await tg.answerCallbackQuery(query.id, 'Доступ запрещён').catch(() => {});
    return;
  }

  const data = String(query.data || '');
  if (!data.startsWith('use:')) {
    await tg.answerCallbackQuery(query.id, '').catch(() => {});
    return;
  }

  const names = callbackSessions.get(String(chatId)) || [];
  const name = names[Number(data.slice(4))];
  if (!name) {
    await tg.answerCallbackQuery(query.id, 'Список устарел, откройте /sessions').catch(() => {});
    return;
  }

  try {
    const item = store.use(name);
    await tg.answerCallbackQuery(query.id, `Переключено: ${name}`).catch(() => {});
    await tg.editText(chatId, query.message.message_id, `✅ Текущая сессия: ${item.name}\n📁 ${item.path}`);
  } catch (err) {
    await tg.answerCallbackQuery(query.id, err.message.slice(0, 190)).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Обработка апдейтов                                                  */
/* ------------------------------------------------------------------ */

async function handleMessage(msg) {
  const chatId = msg.chat && msg.chat.id;
  if (!chatId) return;

  if (!isAllowed(chatId)) {
    log.warn(
      `отказ: chat_id=${chatId} (@${(msg.from && msg.from.username) || '—'})`,
    );
    await tg
      .sendMessage(
        chatId,
        `⛔ Доступ запрещён.\nВаш chat id: ${chatId}\nАдминистратор может добавить его в ALLOWED_CHAT_IDS.`,
      )
      .catch(() => {});
    return;
  }

  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!text) {
    await tg.sendMessage(chatId, 'Пока понимаю только текст. Пришлите задачу текстом.').catch(() => {});
    return;
  }

  if (text.startsWith('/')) {
    await handleCommand(chatId, text);
    return;
  }

  enqueueTask(chatId, text);
}

function handleUpdate(update) {
  if (update.message) {
    void handleMessage(update.message);
    return;
  }
  if (update.callback_query) {
    void handleCallback(update.callback_query);
  }
}

/* ------------------------------------------------------------------ */
/* Long polling                                                        */
/* ------------------------------------------------------------------ */

async function pollLoop() {
  let offset = 0;
  let backoff = 1000;

  // Сбрасываем накопившийся за время простоя бэклог: старые сообщения не должны
  // внезапно превратиться в задачи после перезапуска сервиса.
  try {
    const stale = await tg.getUpdates({ offset: -1, timeout: 0, limit: 1 });
    if (stale.length) {
      offset = stale[stale.length - 1].update_id + 1;
      log.info(`пропускаю накопившиеся апдейты, стартую с offset ${offset}`);
    }
  } catch (err) {
    log.warn(`не смог сбросить бэклог: ${err.message}`);
  }

  while (!stopping) {
    try {
      const updates = await tg.getUpdates({
        offset,
        timeout: cfg.pollTimeout,
        allowedUpdates: ['message', 'callback_query'],
      });
      backoff = 1000;
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        handleUpdate(update);
      }
    } catch (err) {
      if (stopping) break;

      if (err instanceof TelegramError && (err.code === 401 || err.code === 404)) {
        log.error(`Telegram отказал (${err.code}): ${err.message}. Проверьте токен`);
        process.exit(78);
      }

      if (err instanceof TelegramError && err.conflict) {
        log.warn('конфликт getUpdates (409): другой процесс уже слушает бота, ждём 15 с');
        await sleep(15000);
        continue;
      }

      if (err instanceof TelegramError && err.code === 429) {
        const wait = (err.retryAfter || 5) * 1000;
        log.warn(`Telegram 429, ждём ${wait} мс`);
        await sleep(wait);
        continue;
      }

      log.warn(`ошибка polling: ${err.message}; повтор через ${backoff} мс`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Запуск                                                              */
/* ------------------------------------------------------------------ */

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  try {
    log.info(`остановка по ${signal}`);
  } catch {
    /* ignore */
  }
  for (const [, task] of activeTasks) {
    try {
      task.kill('stop');
    } catch {
      /* ignore */
    }
  }
  if (webServer) {
    void webServer.close().catch(() => {});
  }
  setTimeout(() => process.exit(0), 1500).unref?.();
}

/**
 * Конфиг OpenCode с полным доступом: агент не останавливается на запросах
 * подтверждений (shell, правки файлов, webfetch). Формат зависит от версии CLI.
 */
function isPermissiveConfig(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed.permission === 'allow') return true;
    const p = parsed.permission;
    if (p && typeof p === 'object' && p['*'] === 'allow' && p.external_directory === 'allow') return true;
    if (Array.isArray(parsed.permissions) && parsed.permissions.some((r) => r && r.action === '*' && r.effect === 'allow')) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function ensureOpenCodePermissions() {
  const dir = path.join(os.homedir(), '.config', 'opencode');
  const file = path.join(dir, 'opencode.json');

  if (fs.existsSync(file)) {
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      log.warn(`не смог прочитать ${file}: ${err.message}`);
    }
    if (raw && isPermissiveConfig(raw)) {
      log.info(`права OpenCode: полный доступ уже настроен (${file})`);
      const agents = path.join(dir, 'AGENTS.md');
      if (!fs.existsSync(agents)) {
        try {
          fs.writeFileSync(
            agents,
            [
              '# Сервер владельца',
              '',
              'Ты работаешь на VPS владельца Telegram-пульта.',
              '- У тебя есть `sudo` без пароля: `sudo <команда>` работает.',
              '- Используй sudo только когда операция действительно требует root.',
              '- Не удаляй системные каталоги, не трогай `/etc`, `/boot`, SSH-ключи без прямой просьбы.',
              '',
            ].join('\n'),
            { mode: 0o600 },
          );
        } catch (err) {
          log.warn(`не смог записать AGENTS.md: ${err.message}`);
        }
      }
      return;
    }
    if (raw) {
      try {
        fs.copyFileSync(file, `${file}.bak`);
        log.warn(`конфиг OpenCode был без полного доступа — сохранил копию в ${file}.bak и перезаписываю`);
      } catch (err) {
        log.warn(`не смог сохранить копию конфига: ${err.message}`);
      }
    }
  }

  const match = /(\d+)\.(\d+)/.exec(String(oc.version || ''));
  const major = match ? Number(match[1]) : 1;
  const body =
    major >= 2
      ? {
          $schema: 'https://opencode.ai/config.json',
          permissions: [
            { action: '*', resource: '*', effect: 'allow' },
            { action: 'read', resource: '*.env*', effect: 'allow' },
          ],
          instructions: ['~/.config/opencode/AGENTS.md'],
        }
      : {
          $schema: 'https://opencode.ai/config.json',
          // v1: одна строка включает allow вообще для всех действий,
          // включая external_directory и doom_loop.
          permission: 'allow',
          instructions: ['~/.config/opencode/AGENTS.md'],
        };

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(
      path.join(dir, 'AGENTS.md'),
      [
        '# Сервер владельца',
        '',
        'Ты работаешь на VPS владельца Telegram-пульта.',
        '- У тебя есть `sudo` без пароля: `sudo <команда>` работает.',
        '- Используй sudo только когда операция действительно требует root.',
        '- Не удаляй системные каталоги, не трогай `/etc`, `/boot`, SSH-ключи без прямой просьбы.',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    log.info(`создан конфиг OpenCode с полным доступом: ${file} (v${major >= 2 ? 2 : 1})`);
  } catch (err) {
    log.warn(`не смог создать конфиг прав OpenCode: ${err.message}`);
  }
}

async function main() {
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`[pult] ${err.message}\n`);
      process.exit(78);
    }
    throw err;
  }

  log = createLogger({ file: cfg.logFile, maxBytes: cfg.logMaxBytes, maxFiles: cfg.logMaxFiles });

  if (cfg.allowedChatIds.length === 0) {
    log.warn('ALLOWED_CHAT_IDS пуст: бот будет отказывать всем. Впишите свой chat id в .env');
  }

  store = new SessionStore({
    file: cfg.sessionsFile,
    workspacesDir: cfg.workspacesDir,
    logger: log,
    gitBin: cfg.gitBin,
    cloneTimeoutMs: cfg.cloneTimeoutMs,
  }).load();

  history = new HistoryStore({
    file: cfg.historyFile,
    maxEntries: cfg.historyLimit,
    logger: log,
  }).load();

  oc = new OpenCode({ bin: cfg.opencodeBin, model: cfg.model, logger: log });
  await oc.probe();
  ensureOpenCodePermissions();

  tg = new Telegram(cfg.token, log, { apiBase: cfg.apiBase });

  try {
    const me = await tg.getMe();
    botUsername = me.username || null;
    log.info(`бот @${botUsername || me.id} на связи, модель ${cfg.model}`);
  } catch (err) {
    log.error(`не смог залогиниться в Telegram: ${err.message}`);
    process.exit(78);
  }

  const current = store.ensureDefault('main');
  log.info(`рабочая папка: ${current ? current.path : '—'}; модель: ${cfg.model}`);

  if (cfg.webEnabled) {
    try {
      webServer = await startWebServer({
        cfg,
        log,
        store,
        oc,
        tg,
        activeTasks,
        withWorkspaceLock,
        botUsername,
        history,
      });
    } catch (err) {
      log.error(`MiniApp не запустился: ${err.message}`);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', reason);
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', err);
    process.exit(1);
  });

  await pollLoop();
}

main().catch((err) => {
  process.stderr.write(`[pult] фатальная ошибка: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});

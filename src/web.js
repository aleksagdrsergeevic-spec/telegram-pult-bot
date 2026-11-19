import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { stripAnsi } from './opencode.js';
import { saveImage } from './uploads.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(HERE, '..', 'web', 'index.html');
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const INIT_DATA_MAX_AGE = 24 * 60 * 60;
const MAX_BODY = 200 * 1024;

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} мин ${s} с` : `${s} с`;
}

/** Проверка подписи Telegram.WebApp.initData (HMAC-SHA256 с ключом "WebAppData"). */
function verifyInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') return null;
  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculated = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  if (calculated.length !== hash.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(hash))) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > INIT_DATA_MAX_AGE) return null;

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
  if (!user || !user.id) return null;
  return { userId: String(user.id), user };
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export async function startWebServer({ cfg, log, store, oc, tg, activeTasks, withWorkspaceLock, botUsername, history }) {
  /** token -> { userId, expiresAt } */
  const tokens = new Map();
  /** активные SSE-клиенты */
  const clients = new Set();
  /** userId -> сообщения, ждущие своей очереди */
  const queues = new Map();
  /** кто сейчас выполняет задачу */
  const activeUsers = new Set();
  let modelsCache = { at: 0, list: [] };
  const MAX_QUEUE = 10;

  function drainQueue(userId) {
    const list = queues.get(userId);
    if (!list || !list.length) return;
    if (activeUsers.has(userId)) return;
    const text = list.shift();
    if (!list.length) queues.delete(userId);
    activeUsers.add(userId);
    void runPrompt(userId, text).finally(() => {
      activeUsers.delete(userId);
      drainQueue(userId);
    });
  }

  function allowed(userId) {
    if (cfg.allowedChatIds.length === 0) return false;
    return cfg.allowedChatIds.includes(String(userId));
  }

  function tokenFor(req, url) {
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const raw = bearer || url.searchParams.get('t') || '';
    const entry = tokens.get(raw);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      tokens.delete(raw);
      return null;
    }
    return entry;
  }

  function broadcast(userId, event) {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      if (client.userId !== userId) continue;
      try {
        client.res.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  function stateFor(userId) {
    const current = store.getCurrent();
    const task = activeTasks.get(String(userId));
    return {
      bot: botUsername,
      now: Date.now(),
      model: (current && current.model) || cfg.model,
      current: current
        ? { name: current.name, path: current.path, model: current.model || cfg.model, missing: !!current.missing }
        : null,
      sessions: store.list().map((item) => ({
        name: item.name,
        path: item.path,
        model: item.model || cfg.model,
        lastUsedAt: item.lastUsedAt,
        hasRun: !!item.hasRun,
      })),
      running: !!task,
      task: task
        ? { name: task.name, startedAt: task.startedAt, lastOutputAt: task.lastOutputAt || task.startedAt }
        : null,
      queued: (queues.get(String(userId)) || []).length,
    };
  }

  async function runPrompt(userId, text) {
    const key = String(userId);
    const session = store.getCurrent();

    if (!session) {
      broadcast(userId, { type: 'error', message: 'Сначала создайте сессию: откройте список папок и добавьте новую.' });
      return;
    }
    if (session.missing) {
      broadcast(userId, { type: 'error', message: `Папка сессии «${session.name}» пропала на сервере.` });
      return;
    }
    if (text.length > cfg.promptMaxLength) {
      broadcast(userId, { type: 'error', message: `Слишком длинный запрос (${text.length} > ${cfg.promptMaxLength}).` });
      return;
    }
    if (activeTasks.has(key)) {
      broadcast(userId, { type: 'error', message: 'Задача уже выполняется — дождитесь окончания или нажмите стоп.' });
      return;
    }

    const model = session.model || cfg.model;
    const started = Date.now();
    broadcast(userId, { type: 'start', session: session.name, model });
    if (history) history.append(session.name, 'user', text);

    let idleTimer = null;
    let idleNoticeSent = 0;

    try {
      const res = await withWorkspaceLock(session.name, async () => {
        const handle = oc.start({
          cwd: session.path,
          prompt: text,
          sessionId: session.openCodeSessionId,
          resume: session.hasRun,
          model,
          timeoutMs: cfg.taskTimeoutMs,
          idleTimeoutMs: cfg.idleTimeoutMs,
          onChunk: (chunk) => {
            const running = activeTasks.get(key);
            if (running) running.lastOutputAt = Date.now();
            broadcast(userId, { type: 'chunk', text: chunk });
          },
        });
        activeTasks.set(key, {
          name: session.name,
          startedAt: started,
          lastOutputAt: Date.now(),
          kill: handle.kill,
          prompt: text,
        });

        idleTimer = setInterval(() => {
          const quiet = Math.round((Date.now() - handle.lastOutputAt) / 1000);
          if (quiet >= 60 && quiet - idleNoticeSent >= 45) {
            idleNoticeSent = quiet;
            broadcast(userId, {
              type: 'idle',
              seconds: quiet,
              limit: Math.round(cfg.idleTimeoutMs / 1000),
            });
          }
        }, 15000);
        if (typeof idleTimer.unref === 'function') idleTimer.unref();

        return handle.promise;
      });

      if (res.sessionId) store.setOpenCodeSession(session.name, res.sessionId);
      if (!res.missing) store.markRun(session.name);
      if (history) {
        const text = stripAnsi(res.output || '').trim();
        history.append(session.name, 'assistant', text || (res.missing ? 'OpenCode не найден на сервере' : '(пустой вывод)'));
      }

      broadcast(userId, {
        type: 'done',
        elapsed: formatDuration(Date.now() - started),
        ok: res.code === 0 && !res.timedOut && !res.stopped,
        stopped: !!res.stopped,
        timedOut: !!res.timedOut,
        code: res.code,
        error: res.missing ? 'OpenCode не найден на сервере' : stripAnsi(res.stderr || '').slice(-800),
      });
      log.info(`web: задача для ${key} завершена (код ${res.code})`);
    } catch (err) {
      log.error('web: ошибка задачи', err);
      broadcast(userId, { type: 'error', message: err.message });
    } finally {
      if (idleTimer) clearInterval(idleTimer);
      activeTasks.delete(key);
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /' || route === 'GET /index.html') {
      const html = fs.readFileSync(INDEX_PATH);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    if (route === 'GET /healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (route === 'POST /api/auth') {
      const body = await readBody(req);
      const auth = verifyInitData(body.initData, cfg.token);
      if (!auth) {
        sendJson(res, 401, { error: 'не удалось проверить initData' });
        return;
      }
      if (!allowed(auth.userId)) {
        sendJson(res, 403, { error: `доступ запрещён (id ${auth.userId})` });
        return;
      }
      const token = crypto.randomBytes(24).toString('hex');
      tokens.set(token, { userId: auth.userId, expiresAt: Date.now() + TOKEN_TTL_MS });
      sendJson(res, 200, { token, state: stateFor(auth.userId), user: auth.user });
      return;
    }

    const session = tokenFor(req, url);
    if (!session) {
      sendJson(res, 401, { error: 'нужна авторизация' });
      return;
    }

    if (route === 'GET /api/state') {
      sendJson(res, 200, stateFor(session.userId));
      return;
    }

    if (route === 'GET /api/history') {
      const current = store.getCurrent();
      const name = url.searchParams.get('session') || (current && current.name) || '';
      sendJson(res, 200, {
        session: name,
        messages: history ? history.list(name, 100) : [],
      });
      return;
    }

    if (route === 'GET /api/models') {      if (Date.now() - modelsCache.at > 10 * 60 * 1000) {
        const result = await oc.models().catch(() => ({ code: -1, text: '' }));
        const list = String(result.text || '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /^[\w.-]+\/[\w.\-/]+$/.test(line));
        modelsCache = { at: Date.now(), list };
      }
      sendJson(res, 200, { list: modelsCache.list, current: (store.getCurrent() || {}).model || cfg.model });
      return;
    }

    if (route === 'POST /api/model') {
      const body = await readBody(req);
      const current = store.getCurrent();
      if (!current) {
        sendJson(res, 400, { error: 'нет текущей сессии' });
        return;
      }
      const model = String(body.model || '').trim();
      if (!/^[\w.-]+\/[\w.\-/]+$/.test(model)) {
        sendJson(res, 400, { error: 'некорректная модель' });
        return;
      }
      store.setModel(current.name, model);
      sendJson(res, 200, stateFor(session.userId));
      return;
    }

    if (route === 'POST /api/session') {
      const body = await readBody(req);
      const action = String(body.action || '');
      try {
        if (action === 'use') {
          store.use(String(body.name || ''));
        } else if (action === 'new') {
          const item = await store.create(String(body.name || ''));
          store.use(item.name);
        } else {
          sendJson(res, 400, { error: 'неизвестное действие' });
          return;
        }
        sendJson(res, 200, stateFor(session.userId));
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (route === 'POST /api/prompt') {
      const bodyLimit = cfg.uploadMaxBytes * cfg.uploadMaxFiles * 2 + 512 * 1024;
      const body = await readBody(req, bodyLimit);
      let text = String(body.text || '').trim();
      const rawFiles = Array.isArray(body.files) ? body.files.slice(0, cfg.uploadMaxFiles) : [];
      // ws — рабочая папка; session — авторизация (userId обязателен для очереди и событий)
      const ws = store.getCurrent();

      if (!text && !rawFiles.length) {
        sendJson(res, 400, { error: 'пустой запрос' });
        return;
      }
      if (text.length > cfg.promptMaxLength) {
        sendJson(res, 400, { error: `слишком длинный запрос (максимум ${cfg.promptMaxLength})` });
        return;
      }
      if (!ws) {
        sendJson(res, 400, { error: 'сначала создайте сессию (папку)' });
        return;
      }
      log.info(`web: запрос от ${session.userId}: ${text.length} симв., файлов ${rawFiles.length}`);

      const saved = [];
      for (const item of rawFiles) {
        const match = /^data:([^;,]+);base64,(.+)$/s.exec(String((item && item.data) || ''));
        if (!match) continue;
        const buffer = Buffer.from(match[2], 'base64');
        if (buffer.length > cfg.uploadMaxBytes) {
          sendJson(res, 413, { error: `файл больше ${Math.round(cfg.uploadMaxBytes / 1024 / 1024)} МБ` });
          return;
        }
        saved.push(
          saveImage({
            dir: path.join(cfg.uploadsDir, ws.name),
            buffer,
            mime: match[1],
            nameHint: item.name,
          }),
        );
      }
      if (saved.length) {
        text = `Приложены изображения — открой их через read и учти содержимое:\n${saved.map((p) => `- ${p}`).join('\n')}\n\n${text}`;
        log.info(`web: сохранено вложений ${saved.length}`);
      }
      if (!text) {
        sendJson(res, 400, { error: 'нет ни текста, ни файлов' });
        return;
      }

      if (activeUsers.has(session.userId) || activeTasks.has(session.userId)) {
        const list = queues.get(session.userId) || [];
        if (list.length >= 10) {
          sendJson(res, 429, { error: `очередь переполнена (${10})` });
          return;
        }
        list.push(text);
        queues.set(session.userId, list);
        broadcast(session.userId, { type: 'notice', message: `добавлено в очередь: ${list.length}` });
        sendJson(res, 202, { queued: true, position: list.length, files: saved.length });
        return;
      }

      sendJson(res, 202, { accepted: true, files: saved.length });
      activeUsers.add(session.userId);
      void runPrompt(session.userId, text).finally(() => {
        activeUsers.delete(session.userId);
        drainQueue(session.userId);
      });
      return;
    }

    if (route === 'POST /api/queue/clear') {
      queues.delete(session.userId);
      broadcast(session.userId, { type: 'notice', message: 'очередь очищена' });
      sendJson(res, 200, stateFor(session.userId));
      return;
    }

    if (route === 'POST /api/stop') {
      let task = activeTasks.get(session.userId);
      if (!task) {
        // Задача могла быть запущена из Telegram или другого чата в той же папке.
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
      if (task) {
        task.kill('stop');
        queues.delete(session.userId);
        broadcast(session.userId, { type: 'notice', message: 'останавливаю задачу, очередь очищена' });
        log.info(`web: стоп для ${session.userId}`);
      }
      sendJson(res, 200, { stopped: !!task });
      return;
    }

    if (route === 'GET /api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      const client = { userId: session.userId, res };
      clients.add(client);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }, 25000);
      if (typeof ping.unref === 'function') ping.unref();
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(client);
      });
      return;
    }

    sendJson(res, 404, { error: 'не найдено' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.warn(`web: ${req.method} ${req.url} — ${err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.webPort, cfg.webHost, resolve);
  });

  log.info(`MiniApp слушает http://${cfg.webHost}:${cfg.webPort}${cfg.webPublicUrl ? ` (публично ${cfg.webPublicUrl})` : ''}`);

  if (cfg.webPublicUrl && tg) {
    try {
      await tg.call('setChatMenuButton', {
        menu_button: { type: 'web_app', text: 'Пульт', web_app: { url: cfg.webPublicUrl } },
      });
      log.info('кнопка MiniApp установлена в меню бота');
    } catch (err) {
      log.warn(`не смог поставить кнопку MiniApp: ${err.message}`);
    }
  }

  return {
    server,
    close: () =>
      new Promise((resolve) => {
        for (const client of clients) {
          try {
            client.res.end();
          } catch {
            /* ignore */
          }
        }
        clients.clear();
        server.close(() => resolve());
      }),
  };
}

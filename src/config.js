import fs from 'node:fs';
import path from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Минимальный разбор .env без зависимостей.
 * Поддерживает комментарии, пустые строки, кавычки и `export KEY=...`.
 */
export function parseEnvFile(text) {
  const env = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // необработанный комментарий в конце значения
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash);
    }
    env[key] = value.trim();
  }
  return env;
}

function readEnvFile(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return parseEnvFile(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function pick(fileEnv, key, fallback) {
  const fromProcess = process.env[key];
  if (typeof fromProcess === 'string' && fromProcess.trim() !== '') return fromProcess.trim();
  const fromFile = fileEnv[key];
  if (typeof fromFile === 'string' && fromFile.trim() !== '') return fromFile.trim();
  return fallback;
}

function toInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, name = '' } = {}) {
  const num = Number.parseInt(String(value), 10);
  if (!Number.isFinite(num)) {
    if (fallback === undefined) throw new ConfigError(`не число: ${name}`);
    return fallback;
  }
  if (num < min || num > max) return fallback;
  return num;
}

function toPath(value, fallback) {
  const raw = value || fallback;
  return path.resolve(raw);
}

export function loadConfig(envFile = path.resolve(process.cwd(), '.env')) {
  const fileEnv = readEnvFile(envFile);

  const token = pick(fileEnv, 'TELEGRAM_BOT_TOKEN', '');
  if (!token) {
    throw new ConfigError(
      `не задан TELEGRAM_BOT_TOKEN. Впишите токен от @BotFather в ${envFile} и перезапустите сервис`,
    );
  }
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
    throw new ConfigError(
      'TELEGRAM_BOT_TOKEN выглядит неправильно (ожидается формат 123456:AA...). Проверьте токен от @BotFather',
    );
  }

  const allowedRaw = pick(fileEnv, 'ALLOWED_CHAT_IDS', '');
  const allowedChatIds = allowedRaw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const workspacesDir = toPath(pick(fileEnv, 'WORKSPACES_DIR', ''), '/var/lib/telegram-pult/workspaces');
  const sessionsFile = toPath(pick(fileEnv, 'SESSIONS_FILE', ''), path.join(workspacesDir, '..', 'sessions.json'));
  const historyFile = toPath(pick(fileEnv, 'HISTORY_FILE', ''), path.join(workspacesDir, '..', 'history.json'));
  const logFile = toPath(pick(fileEnv, 'LOG_FILE', ''), path.join(workspacesDir, '..', 'logs', 'pult.log'));

  return {
    envFile,
    token,
    allowedChatIds,
    model: pick(fileEnv, 'MODEL', 'opencode/big-pickle'),
    imageModel: pick(fileEnv, 'IMAGE_MODEL', ''),
    workspacesDir,
    sessionsFile,
    historyFile,
    historyLimit: toInt(pick(fileEnv, 'HISTORY_LIMIT', '200'), 200, { min: 20, max: 5000, name: 'HISTORY_LIMIT' }),
    uploadsDir: toPath(pick(fileEnv, 'UPLOADS_DIR', ''), path.join(workspacesDir, '..', 'uploads')),
    uploadMaxFiles: toInt(pick(fileEnv, 'UPLOAD_MAX_FILES', '4'), 4, { min: 1, max: 10, name: 'UPLOAD_MAX_FILES' }),
    uploadMaxBytes: toInt(pick(fileEnv, 'UPLOAD_MAX_BYTES', '8388608'), 8388608, {
      min: 65536,
      max: 32 * 1024 * 1024,
      name: 'UPLOAD_MAX_BYTES',
    }),
    logFile,
    logMaxBytes: toInt(pick(fileEnv, 'LOG_MAX_BYTES', '5242880'), 5242880, { min: 65536, name: 'LOG_MAX_BYTES' }),
    logMaxFiles: toInt(pick(fileEnv, 'LOG_MAX_FILES', '3'), 3, { min: 1, max: 50, name: 'LOG_MAX_FILES' }),
    promptMaxLength: toInt(pick(fileEnv, 'PROMPT_MAX_LENGTH', '4000'), 4000, {
      min: 100,
      max: 100000,
      name: 'PROMPT_MAX_LENGTH',
    }),
    taskTimeoutMs: toInt(pick(fileEnv, 'TASK_TIMEOUT_MS', '1200000'), 1200000, {
      min: 30000,
      max: 4 * 60 * 60 * 1000,
      name: 'TASK_TIMEOUT_MS',
    }),
    editIntervalMs: toInt(pick(fileEnv, 'EDIT_INTERVAL_MS', '1200'), 1200, {
      min: 500,
      max: 10000,
      name: 'EDIT_INTERVAL_MS',
    }),
    streamWindow: toInt(pick(fileEnv, 'STREAM_WINDOW', '3600'), 3600, {
      min: 500,
      max: 3900,
      name: 'STREAM_WINDOW',
    }),
    idleTimeoutMs: toInt(pick(fileEnv, 'IDLE_TIMEOUT_MS', '600000'), 600000, {
      min: 120000,
      max: 60 * 60 * 1000,
      name: 'IDLE_TIMEOUT_MS',
    }),
    streaming: pick(fileEnv, 'STREAMING', '0') === '1',
    webEnabled: pick(fileEnv, 'WEB_ENABLED', '1') !== '0',
    webHost: pick(fileEnv, 'WEB_HOST', '127.0.0.1'),
    webPort: toInt(pick(fileEnv, 'WEB_PORT', '8787'), 8787, { min: 1024, max: 65535, name: 'WEB_PORT' }),
    webPublicUrl: pick(fileEnv, 'WEB_PUBLIC_URL', '').replace(/\/+$/, ''),
    pollTimeout: toInt(pick(fileEnv, 'POLL_TIMEOUT', '25'), 25, { min: 5, max: 50, name: 'POLL_TIMEOUT' }),
    cloneTimeoutMs: toInt(pick(fileEnv, 'GIT_CLONE_TIMEOUT_MS', '180000'), 180000, {
      min: 10000,
      max: 30 * 60 * 1000,
      name: 'GIT_CLONE_TIMEOUT_MS',
    }),
    opencodeBin: pick(fileEnv, 'OPENCODE_BIN', 'opencode'),
    gitBin: pick(fileEnv, 'GIT_BIN', 'git'),
    apiBase: pick(fileEnv, 'TELEGRAM_API_BASE', 'https://api.telegram.org'),
  };
}

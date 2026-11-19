import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class SessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionError';
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const URL_RE = /^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/i;

export function deriveSessionName(url) {
  const cleaned = String(url)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const parts = cleaned.split(/[/:]+/).filter(Boolean);
  let base = parts[parts.length - 1] || 'repo';
  try {
    base = decodeURIComponent(base);
  } catch {
    /* оставляем как есть */
  }
  base = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  if (!base) base = 'repo';
  return base.slice(0, 64);
}

export function validateSessionName(name) {
  const value = String(name || '').trim();
  if (!value) throw new SessionError('пустое имя сессии');
  if (value.includes('..') || value.includes('/') || value.includes('\\')) {
    throw new SessionError('в имени нельзя использовать «..», «/» и «\\»');
  }
  if (!NAME_RE.test(value)) {
    throw new SessionError('имя: латиница, цифры, «.», «-», «_», до 64 символов, начинается с буквы или цифры');
  }
  return value;
}

/**
 * Сессия = рабочая папка внутри WORKSPACES_DIR + id сессии OpenCode.
 * Состояние хранится в sessions.json (атомарная запись).
 */
export class SessionStore {
  constructor({ file, workspacesDir, logger, gitBin = 'git', cloneTimeoutMs = 180000 }) {
    this.file = file;
    this.workspacesDir = workspacesDir;
    this.log = logger;
    this.gitBin = gitBin;
    this.cloneTimeoutMs = cloneTimeoutMs;
    this.data = { current: null, items: {} };
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.mkdirSync(this.workspacesDir, { recursive: true });

    if (!fs.existsSync(this.file)) {
      this.data = { current: null, items: {} };
      return this;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const items = {};
      for (const [name, item] of Object.entries(parsed.items || {})) {
        if (!item || typeof item !== 'object') continue;
        try {
          const safeName = validateSessionName(name);
          items[safeName] = {
            name: safeName,
            path: this.workspacePath(safeName),
            openCodeSessionId: item.openCodeSessionId || null,
            hasRun: item.hasRun === true,
            model: typeof item.model === 'string' && item.model ? item.model : null,
            source: item.source || 'local',
            createdAt: item.createdAt || new Date().toISOString(),
            lastUsedAt: item.lastUsedAt || new Date().toISOString(),
          };
        } catch (err) {
          this.log.warn(`sessions.json: пропускаю запись «${name}» — ${err.message}`);
        }
      }
      this.data = {
        current: typeof parsed.current === 'string' && items[parsed.current] ? parsed.current : null,
        items,
      };
    } catch (err) {
      this.log.error(`sessions.json повреждён (${err.message}); сохраняю копию и начинаю заново`);
      try {
        fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`);
      } catch {
        /* ignore */
      }
      this.data = { current: null, items: {} };
    }
    return this;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  workspacePath(name) {
    const safeName = validateSessionName(name);
    const root = path.resolve(this.workspacesDir);
    const target = path.resolve(root, safeName);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new SessionError('путь оказался вне WORKSPACES_DIR');
    }
    return target;
  }

  /** Проверка, что путь реально внутри WORKSPACES_DIR (учитывая симлинки). */
  assertInsideRoot(target) {
    const root = fs.realpathSync(this.workspacesDir);
    const real = fs.existsSync(target) ? fs.realpathSync(target) : target;
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
      throw new SessionError('доступ к пути вне WORKSPACES_DIR запрещён');
    }
    return real;
  }

  list() {
    return Object.values(this.data.items).sort((a, b) => {
      const byUse = String(b.lastUsedAt).localeCompare(String(a.lastUsedAt));
      return byUse !== 0 ? byUse : a.name.localeCompare(b.name);
    });
  }

  get(name) {
    try {
      return this.data.items[validateSessionName(name)] || null;
    } catch {
      return null;
    }
  }

  getCurrent() {
    if (!this.data.current) return null;
    const item = this.data.items[this.data.current];
    if (!item) return null;
    if (!fs.existsSync(item.path)) {
      this.log.warn(`папка сессии «${item.name}» пропала: ${item.path}`);
      return { ...item, missing: true };
    }
    return item;
  }

  async create(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new SessionError('укажите имя папки или ссылку на git-репозиторий');
    if (raw.length > 500) throw new SessionError('слишком длинное имя или ссылка');

    const isUrl = URL_RE.test(raw);
    let name;
    let url = null;

    if (isUrl) {
      url = raw;
      name = validateSessionName(deriveSessionName(url));
    } else {
      name = validateSessionName(raw);
    }

    if (this.data.items[name]) throw new SessionError(`сессия «${name}» уже есть — переключитесь: /use ${name}`);

    const dir = this.workspacePath(name);
    if (fs.existsSync(dir)) throw new SessionError(`папка ${dir} уже существует, но не описана в sessions.json`);

    if (url) {
      await this.clone(url, dir);
    } else {
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    }

    const now = new Date().toISOString();
    const item = {
      name,
      path: dir,
      openCodeSessionId: null,
      hasRun: false,
      source: url || 'local',
      createdAt: now,
      lastUsedAt: now,
    };
    this.data.items[name] = item;
    this.data.current = name;
    this.save();
    this.log.info(`создана сессия «${name}»: ${dir}${url ? ` (clone ${url})` : ''}`);
    return item;
  }

  clone(url, dir) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.gitBin, ['clone', '--depth', '1', '--', url, dir], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
      } catch (err) {
        reject(new SessionError(`git не запустился: ${err.message}`));
        return;
      }

      let stderr = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, this.cloneTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4000);
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new SessionError(`git не запустился: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
          return;
        }
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        const tail = stderr.trim().slice(-500) || `код выхода ${code}`;
        reject(new SessionError(`git clone не удался: ${tail}`));
      });
    });
  }

  use(name) {
    const item = this.get(name);
    if (!item) throw new SessionError(`сессия «${name}» не найдена. Список: /sessions`);
    if (!fs.existsSync(item.path)) throw new SessionError(`папка сессии пропала: ${item.path}`);
    item.lastUsedAt = new Date().toISOString();
    this.data.current = item.name;
    this.save();
    return item;
  }

  touch(name) {
    const item = this.get(name);
    if (!item) return;
    item.lastUsedAt = new Date().toISOString();
    this.save();
  }

  setOpenCodeSession(name, sessionId) {
    const item = this.get(name);
    if (!item) return;
    item.openCodeSessionId = sessionId || null;
    this.save();
  }

  setModel(name, model) {
    const item = this.get(name);
    if (!item) return null;
    item.model = model || null;
    this.save();
    return item;
  }

  markRun(name) {
    const item = this.get(name);
    if (!item) return;
    item.hasRun = true;
    item.lastUsedAt = new Date().toISOString();
    this.save();
  }

  ensureDefault(name = 'main') {
    if (this.getCurrent() || this.list().length > 0) return this.getCurrent();
    const dir = this.workspacePath(name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    const now = new Date().toISOString();
    this.data.items[name] = {
      name,
      path: dir,
      openCodeSessionId: null,
      hasRun: false,
      source: 'local',
      createdAt: now,
      lastUsedAt: now,
    };
    this.data.current = name;
    this.save();
    this.log.info(`создана сессия по умолчанию «${name}»: ${dir}`);
    return this.getCurrent();
  }
}

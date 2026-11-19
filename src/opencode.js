import { spawn } from 'node:child_process';

const ANSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '').replace(/\r/g, '');
}

/**
 * Обёртка над CLI OpenCode.
 * Промпт всегда передаётся отдельным аргументом (без shell), cwd — папка сессии.
 */
export class OpenCode {
  constructor({ bin = 'opencode', model, logger, baseEnv = process.env }) {
    this.bin = bin;
    this.model = model;
    this.log = logger;
    this.baseEnv = {
      ...baseEnv,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb',
    };
    this.caps = { model: true, session: false, continue: true, auto: false };
    this.version = null;
    this.helpText = null;
  }

  execOnce(args, { timeoutMs = 60000, cwd } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.bin, args, {
          cwd,
          env: this.baseEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({ code: -1, stdout: '', stderr: `spawn: ${err.message}`, timedOut: false, missing: true });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let missing = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      child.stdout?.on('data', (chunk) => {
        stdout = `${stdout}${chunk.toString()}`.slice(-200000);
      });
      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-50000);
      });
      child.on('error', (err) => {
        missing = err.code === 'ENOENT';
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut, missing });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr, timedOut, missing });
      });
    });
  }

  /** Проверяем версию и какие флаги реально поддерживает `opencode run`. */
  async probe() {
    const version = await this.execOnce(['--version'], { timeoutMs: 20000 });
    this.version = stripAnsi(version.stdout || version.stderr).trim().split('\n')[0] || null;
    if (version.missing) {
      this.log.error(`OpenCode не найден (${this.bin}). Установите: npm i -g opencode-ai@latest`);
      return this.caps;
    }

    const help = await this.execOnce(['run', '--help'], { timeoutMs: 30000 });
    const text = `${help.stdout}\n${help.stderr}`;
    this.helpText = stripAnsi(text).trim().slice(0, 8000);

    if (this.helpText) {
      const caps = {
        model: /--model\b/.test(this.helpText),
        session: /--session\b/.test(this.helpText),
        continue: /--continue\b/.test(this.helpText),
        // --auto одобряет все запросы разрешений, которые не запрещены явно
        auto: /--auto\b/.test(this.helpText),
      };
      // Если справка распозналась — доверяем ей; иначе оставляем разумный дефолт.
      if (caps.model || caps.session || caps.continue) {
        this.caps = caps;
      }
      if (!this.caps.session && !this.caps.continue) this.caps.continue = true;
    }

    this.log.info(
      `OpenCode ${this.version || '?'}: флаги run — model=${this.caps.model ? 'да' : 'нет'}, session=${
        this.caps.session ? 'да' : 'нет'
      }, continue=${this.caps.continue ? 'да' : 'нет'}, auto=${this.caps.auto ? 'да' : 'нет'}`,
    );
    return this.caps;
  }

  async models() {
    const res = await this.execOnce(['models'], { timeoutMs: 90000 });
    return {
      code: res.code,
      text: stripAnsi(res.stdout).trim(),
      error: stripAnsi(res.stderr).trim(),
      missing: Boolean(res.missing),
    };
  }

  buildArgs({ prompt, sessionId, resume, model }) {
    const args = ['run'];
    if (this.caps.model) args.push('--model', model || this.model);
    if (this.caps.auto) args.push('--auto');

    if (this.caps.session && sessionId) {
      args.push('--session', sessionId);
    } else if (this.caps.continue && resume) {
      args.push('--continue');
    }

    // Промпт — строго один аргумент; если начинается с «-», не даём парсеру принять его за флаг.
    args.push(prompt.startsWith('-') ? ` ${prompt}` : prompt);
    return args;
  }

  /**
   * Запуск задачи. Возвращает handle { pid, kill(reason), promise }.
   */
  start({ cwd, prompt, sessionId = null, resume = false, model = null, timeoutMs = 1200000, onChunk = null }) {
    const args = this.buildArgs({ prompt, sessionId, resume, model });
    this.log.info(`opencode run в ${cwd} (sessionId=${sessionId || '—'}, model=${model || this.model}, resume=${resume})`);

    let child;
    try {
      child = spawn(this.bin, args, {
        cwd,
        env: this.baseEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        // своя группа процессов, чтобы /stop убивал всё дерево
        detached: true,
      });
    } catch (err) {
      return {
        pid: null,
        kill: () => {},
        promise: Promise.resolve({
          code: -1,
          output: '',
          stderr: `spawn: ${err.message}`,
          timedOut: false,
          stopped: false,
          sessionId: null,
          missing: true,
        }),
      };
    }

    let output = '';
    let stderr = '';
    let killedBy = null;
    let finished = false;

    const collect = (chunk, isError) => {
      const text = stripAnsi(chunk.toString());
      if (!text) return;
      output = `${output}${text}`;
      if (output.length > 400000) output = output.slice(-400000);
      if (isError) stderr = `${stderr}${text}`.slice(-20000);
      if (typeof onChunk === 'function') {
        try {
          onChunk(text);
        } catch (err) {
          this.log.debug(`onChunk: ${err.message}`);
        }
      }
    };

    child.stdout?.on('data', (chunk) => collect(chunk, false));
    child.stderr?.on('data', (chunk) => collect(chunk, true));

    const killTree = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* ignore */
        }
      }
    };

    const kill = (reason = 'stop') => {
      if (finished || killedBy) return;
      killedBy = reason;
      killTree('SIGTERM');
      const hard = setTimeout(() => killTree('SIGKILL'), 5000);
      if (typeof hard.unref === 'function') hard.unref();
    };

    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const promise = new Promise((resolve) => {
      child.on('error', (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const missing = err.code === 'ENOENT';
        resolve({
          code: -1,
          output,
          stderr: `${stderr}${err.message}`,
          timedOut: false,
          stopped: false,
          sessionId: null,
          missing,
        });
      });

      child.on('close', (code, signal) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const match = /ses_[A-Za-z0-9]{8,}/.exec(output);
        resolve({
          code: code ?? -1,
          signal: signal || null,
          output,
          stderr,
          timedOut: killedBy === 'timeout',
          stopped: killedBy === 'stop',
          sessionId: match ? match[0] : null,
          missing: false,
        });
      });
    });

    return { pid: child.pid, kill, promise };
  }
}

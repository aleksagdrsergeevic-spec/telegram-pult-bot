import fs from 'node:fs';
import path from 'node:path';

function formatArg(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Логгер в файл с ротацией по размеру: pult.log -> pult.log.1 .. pult.log.N.
 * Пишет синхронно: объём небольшой, зато при падении ничего не теряется.
 */
export function createLogger({
  file,
  maxBytes = 5 * 1024 * 1024,
  maxFiles = 3,
  alsoConsole = true,
  level = 'info',
} = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = levels[level] ?? levels.info;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = fs.existsSync(file) ? fs.statSync(file).size : 0;

  function rotate() {
    try {
      for (let i = maxFiles - 1; i >= 1; i -= 1) {
        const from = `${file}.${i}`;
        const to = `${file}.${i + 1}`;
        if (fs.existsSync(from)) {
          if (i + 1 > maxFiles) {
            fs.rmSync(from, { force: true });
          } else {
            fs.renameSync(from, to);
          }
        }
      }
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
      size = 0;
    } catch (err) {
      // Ротация не должна ронять бота.
      // eslint-disable-next-line no-console
      console.error(`[logger] ротация не удалась: ${err.message}`);
    }
  }

  function write(levelName, args) {
    if ((levels[levelName] ?? 99) < threshold) return;
    const message = args.map(formatArg).join(' ');
    const line = `${new Date().toISOString()} ${levelName.toUpperCase().padEnd(5)} ${message}\n`;
    if (alsoConsole) {
      const out = levelName === 'error' || levelName === 'warn' ? process.stderr : process.stdout;
      try {
        process.stdout.write(line);
      } catch {
        try {
          out.write(line);
        } catch {
          /* ignore */
        }
      }
    }
    try {
      const bytes = Buffer.byteLength(line);
      if (size + bytes > maxBytes) rotate();
      fs.appendFileSync(file, line);
      size += bytes;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[logger] запись не удалась: ${err.message}`);
    }
  }

  return {
    file,
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  };
}

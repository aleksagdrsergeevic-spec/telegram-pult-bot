import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRY_CHARS = 20000;

/**
 * История переписки по сессиям (папкам). Хранится в JSON, атомарная запись,
 * ограничение по числу сообщений на сессию.
 */
export class HistoryStore {
  constructor({ file, maxEntries = 200, logger }) {
    this.file = file;
    this.maxEntries = maxEntries;
    this.log = logger;
    this.data = {};
  }

  load() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    } catch (err) {
      this.log.warn(`history: не смог создать каталог: ${err.message}`);
    }
    if (!fs.existsSync(this.file)) return this;

    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const data = {};
      for (const [name, list] of Object.entries(parsed || {})) {
        if (!Array.isArray(list)) continue;
        data[name] = list
          .filter((item) => item && typeof item.text === 'string')
          .map((item) => ({
            role: item.role === 'user' ? 'user' : 'assistant',
            text: item.text,
            at: item.at || new Date().toISOString(),
          }))
          .slice(-this.maxEntries);
      }
      this.data = data;
    } catch (err) {
      this.log.error(`history.json повреждён (${err.message}); начинаю с чистого`);
      try {
        fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`);
      } catch {
        /* ignore */
      }
      this.data = {};
    }
    return this;
  }

  append(session, role, text) {
    const name = String(session || '').trim();
    const body = String(text || '').trim();
    if (!name || !body) return;

    const list = this.data[name] || (this.data[name] = []);
    list.push({
      role: role === 'user' ? 'user' : 'assistant',
      text: body.length > MAX_ENTRY_CHARS ? `${body.slice(0, MAX_ENTRY_CHARS)}\n…` : body,
      at: new Date().toISOString(),
    });
    if (list.length > this.maxEntries) list.splice(0, list.length - this.maxEntries);
    this.save();
  }

  list(session, limit = 100) {
    const list = this.data[String(session || '')] || [];
    return list.slice(-Math.max(1, limit));
  }

  save() {
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(this.data)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log.warn(`history: не смог сохранить: ${err.message}`);
    }
  }
}

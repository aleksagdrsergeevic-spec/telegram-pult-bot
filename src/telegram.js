const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TelegramError extends Error {
  constructor(message, code = 0, retryAfter = null) {
    super(message);
    this.name = 'TelegramError';
    this.code = code;
    this.retryAfter = retryAfter;
    this.conflict = code === 409;
  }
}

function clip(text, limit = 4096) {
  const str = String(text ?? '');
  return str.length <= limit ? str : `${str.slice(0, limit - 1)}…`;
}

/**
 * Тонкая обёртка над Bot API на встроенном fetch.
 * Повторяет запросы при сетевых ошибках, 429 и 5xx; 409 отдаёт наверх как конфликт.
 */
export class Telegram {
  constructor(token, logger, { apiBase = 'https://api.telegram.org' } = {}) {
    this.token = token;
    this.log = logger;
    this.apiBase = String(apiBase || 'https://api.telegram.org').replace(/\/+$/, '');
  }

  endpoint(method) {
    return `${this.apiBase}/bot${this.token}/${method}`;
  }

  async call(method, params = {}, { timeoutMs = 30000, retries = 2 } = {}) {
    let attempt = 0;
    for (;;) {
      try {
        const res = await fetch(this.url(method), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const raw = await res.text();
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          data = null;
        }

        if (data && data.ok) return data.result;

        const code = (data && data.error_code) || res.status;
        const description = (data && data.description) || `HTTP ${res.status}`;
        const retryAfter = data && data.parameters ? data.parameters.retry_after : null;

        if (code === 409) {
          // Другой процесс уже слушает getUpdates — ретраить бессмысленно.
          throw new TelegramError(description, 409);
        }
        if ((code === 429 || code >= 500) && attempt < retries) {
          const wait = code === 429 ? (retryAfter || 3) * 1000 : 800 * 2 ** attempt;
          attempt += 1;
          this.log.warn(`telegram ${method}: ${description}; повтор через ${wait} мс`);
          await sleep(wait);
          continue;
        }
        throw new TelegramError(`${method}: ${description}`, code, retryAfter);
      } catch (err) {
        if (err instanceof TelegramError) throw err;
        const reason = err && err.message ? err.message : String(err);
        if (attempt < retries) {
          const wait = 800 * 2 ** attempt;
          attempt += 1;
          this.log.warn(`telegram ${method}: сеть (${reason}); повтор через ${wait} мс`);
          await sleep(wait);
          continue;
        }
        throw new TelegramError(`${method}: сеть (${reason})`, 0);
      }
    }
  }

  url(method) {
    return this.endpoint(method);
  }

  getMe() {
    return this.call('getMe', {}, { timeoutMs: 15000, retries: 3 });
  }

  getUpdates({ offset = 0, timeout = 25, allowedUpdates = ['message', 'callback_query'], limit = 50 } = {}) {
    return this.call(
      'getUpdates',
      { offset, timeout, limit, allowed_updates: allowedUpdates },
      { timeoutMs: (timeout + 25) * 1000, retries: 1 },
    );
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call(
      'sendMessage',
      {
        chat_id: chatId,
        text: clip(text),
        disable_web_page_preview: true,
        ...extra,
      },
      { timeoutMs: 30000, retries: 2 },
    );
  }

  /**
   * Редактирование сообщения. Ошибки не пробрасываются (кроме silent: false):
   * «message is not modified» — нормальная ситуация при стриминге.
   */
  async editText(chatId, messageId, text, { silent = true } = {}) {
    try {
      return await this.call(
        'editMessageText',
        {
          chat_id: chatId,
          message_id: messageId,
          text: clip(text),
          disable_web_page_preview: true,
        },
        { timeoutMs: 25000, retries: 1 },
      );
    } catch (err) {
      if (/message is not modified/i.test(err.message)) return null;
      this.log.debug(`editMessageText: ${err.message}`);
      if (silent) return null;
      throw err;
    }
  }

  sendChatAction(chatId, action = 'typing') {
    return this.call('sendChatAction', { chat_id: chatId, action }, { timeoutMs: 15000, retries: 0 });
  }

  answerCallbackQuery(callbackQueryId, text = '') {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text: clip(text, 200) }, {
      timeoutMs: 15000,
      retries: 1,
    });
  }

  async sendDocument(chatId, filename, content, caption = '') {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', clip(caption, 1000));
    form.append('document', new Blob([content], { type: 'text/plain;charset=utf-8' }), filename);

    const res = await fetch(this.endpoint('sendDocument'), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120000),
    });
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!data || !data.ok) {
      throw new TelegramError(`sendDocument: ${(data && data.description) || `HTTP ${res.status}`}`, (data && data.error_code) || res.status);
    }
    return data.result;
  }
}

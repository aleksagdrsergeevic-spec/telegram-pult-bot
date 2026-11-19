import { stripAnsi } from './opencode.js';

/** Строки-маркеры шагов: "> build · model", "• Read …", "✓ …", рамки. */
const TOOL_MARK = /^\s*[>›»•·◦○●◉✓✔✗✘×✕⬡⎿┃│└├╭╮╰╯─━]/;
/** Строки вида "Read src/bot.js" — начало с имени инструмента. */
const TOOL_NAME = /^\s*(Read|Write|Edit|Patch|Bash|Grep|Glob|List|Task|WebFetch|TodoWrite)\b/i;

/**
 * Оставляет только текст, который написал агент: убирает шапку с моделью,
 * маркеры шагов, строки вызовов инструментов и рамки. Код в ``` сохраняется.
 */
export function cleanAgentOutput(text) {
  const kept = [];
  let inFence = false;

  for (const raw of stripAnsi(text).split('\n')) {
    const line = raw.replace(/\s+$/, '');

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (inFence) {
      kept.push(line);
      continue;
    }
    if (TOOL_MARK.test(line)) continue;
    if (TOOL_NAME.test(line)) continue;
    kept.push(line);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

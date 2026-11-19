/** Лимиты контекста по известным моделям каталога OpenCode (оценка для индикатора). */
const LIMITS = {
  'big-pickle': 200000,
  'deepseek-v4.1-flash-free': 200000,
  'mimo-v2.6-flash-free': 200000,
  'deepseek-v4.1-flash': 1000000,
  'glm-5.3-flash': 1000000,
  'gemini-3.8-flash': 1048576,
};

export function contextLimit(model) {
  const id = String(model || '').split('/').slice(1).join('/');
  return LIMITS[id] || 200000;
}

/** Грубая оценка токенов по длине текста (4 символа ≈ 1 токен). */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

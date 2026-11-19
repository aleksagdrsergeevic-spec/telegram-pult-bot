import fs from 'node:fs';
import path from 'node:path';

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

export function isImageMime(mime) {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('image/');
}

function extFor(mime, nameHint) {
  const byMime = EXT_BY_MIME[String(mime || '').toLowerCase()];
  if (byMime) return byMime;
  const byName = /\.(jpe?g|png|webp|gif|heic|heif)$/i.exec(String(nameHint || ''));
  if (byName) return byName[0].toLowerCase();
  return '.img';
}

/** Кладёт картинку в каталог загрузок и возвращает абсолютный путь. */
export function saveImage({ dir, buffer, mime, nameHint }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extFor(mime, nameHint)}`);
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  return file;
}

/** Строка-префикс промпта со списком вложений. */
export function imagePromptPrefix(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return '';
  return [
    'К сообщению приложены изображения — открой их через read.',
    'Важно: если содержимое изображения не читается (модель без поддержки картинок),',
    'не вызывай субагентов и не пытайся обойти это — просто скажи одной строкой,',
    'что нужна vision-модель, и выполни текстовую часть задачи.',
    ...list.map((p) => `- ${p}`),
    '',
    '',
  ].join('\n');
}

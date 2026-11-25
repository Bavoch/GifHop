export function normalizeAnimationTitle(value) {
  if (typeof value !== 'string') return '';
  const clean = value.normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, '')
    .replace(/^[.\s`#'“”「」《》]+|[\s`'“”「」《》。.，、；：！!？?…]+$/gu, '')
    .replace(/\s+/gu, '');
  const title = Array.from(clean).slice(0, 12).join('').replace(/\.+$/u, '');
  return /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(title) ? '' : title;
}

export function parseAnimationTitle(reply) {
  try {
    const json = JSON.parse(reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    return normalizeAnimationTitle(json.title);
  } catch { return ''; }
}

export function normalizeReferenceTitle(value) {
  const title = normalizeAnimationTitle(value?.title);
  return title && typeof value?.imageHash === 'string' && /^[a-f0-9]{64}$/.test(value.imageHash) ? { imageHash: value.imageHash, title } : null;
}

export function animationFilename(title, size, extension) {
  const name = normalizeAnimationTitle(title);
  if (!name) throw new Error('动画标题尚未生成，请重试导出。');
  return `${name}-${size}px.${extension}`;
}

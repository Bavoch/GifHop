import path from 'node:path';
import { normalizeAnimationTitle, normalizeReferenceTitle } from '../animation-title.mjs';
import { normalizeReferenceCrop } from '../reference-crop.mjs';

export const MAX_IMAGE = 20 * 1024 * 1024;
export const MAX_FILE = 100 * 1024 * 1024;
export function text(value, max, label, optional = false) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${label}无效或过长。`);
  return value.trim();
}
export function imageData(value, max = MAX_IMAGE) {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) + 100) throw new Error('图片过大。');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error('仅支持 PNG、JPEG 或 WebP 图片。');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > max || bytes.toString('base64') !== match[2]) throw new Error('图片数据无效。');
  const type = imageType(bytes);
  if (type !== match[1]) throw new Error('图片内容与格式不符。');
  return { bytes, type, extension: type === 'jpeg' ? 'jpg' : type };
}
export function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('Codex 未返回有效图片。');
}
export function validateJob(input, { allowImageOnly = false, referenceLimit = 8 * 1024 * 1024 } = {}) {
  if (!input || typeof input !== 'object') throw new Error('请求无效。');
  const id = text(input.id, 80, '任务编号');
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('任务编号无效。');
  const referenceImage = input.referenceImage ? imageData(input.referenceImage, referenceLimit) : null;
  const prompt = text(input.prompt, 4000, '提示词', allowImageOnly && !!referenceImage);
  const model = text(input.model, 120, '模型', true);
  if (model && !/^[a-zA-Z0-9._:-]+$/.test(model)) throw new Error('模型名称无效。');
  return { id, prompt, model, referenceImage };
}
export function assetPath(root, requestUrl) {
  const url = new URL(requestUrl);
  if (url.protocol !== 'fox24:' || url.hostname !== 'app' || url.port || url.username || url.password) return null;
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  const resolved = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  return resolved.startsWith(`${path.resolve(root)}${path.sep}`) ? resolved : null;
}
export function validExportFilename(name) {
  return typeof name === 'string' && name.length <= 120
    && !/[\p{Cc}\p{Cf}<>:"/\\|?*]/u.test(name)
    && !/^[.\s]|[.\s]$/.test(name)
    && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
    && /^.+\.(gif|webp|png|jpg|jpeg|mp4|webm)$/.test(name);
}
export function validateProject(project) {
  if (!project || project.format !== 'fox24' || ![1, 2].includes(project.version) || !Array.isArray(project.slots) || project.slots.length > 4) throw new Error('无法识别此 GifHop 工程。');
  // Legacy versioned projects keep only their inline sheets; removed version IDs are ignored.
  const slots = project.slots.map(slot => {
    if (!slot || typeof slot !== 'object') throw new Error('无法识别此 GifHop 工程。');
    if (slot.sheet) imageData(slot.sheet);
    const offsets = slot.offsets ?? [];
    if (!Array.isArray(offsets) || offsets.length > 24 || offsets.some(o => !Number.isFinite(o.dx) || !Number.isFinite(o.dy) || Math.abs(o.dx) > 1000 || Math.abs(o.dy) > 1000)) throw new Error('帧偏移数据无效。');
    return { sheet: slot.sheet || null, offsets,
      ...(slot.sheetAsset ? { sheetAsset: materialAsset(slot.sheetAsset) } : {}),
      ...(normalizeAnimationTitle(slot.title) ? { title: normalizeAnimationTitle(slot.title) } : {}),
      ...(slot.prompt != null ? { prompt: text(slot.prompt, 4000, '提示词', true) } : {}) };
  });
  if (project.referenceImage) imageData(project.referenceImage, 8 * 1024 * 1024);
  return { format: 'fox24', version: project.version, prompt: text(project.prompt, 4000, '提示词', true),
    referenceImage: project.referenceImage || null,
    ...(normalizeReferenceTitle(project.referenceTitle) ? { referenceTitle: normalizeReferenceTitle(project.referenceTitle) } : {}),
    ...(project.referenceCrop ? { referenceCrop: normalizeReferenceCrop(project.referenceCrop) } : {}),
    ...(project.version === 2 && project.referenceAsset != null ? { referenceAsset: materialAsset(project.referenceAsset) } : {}),
    slots };
}
export function materialAsset(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(value)) throw new Error('素材文件编号无效。');
  return value;
}

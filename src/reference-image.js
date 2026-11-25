import { referenceCropBounds } from '../reference-crop.mjs';

const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

export async function squareReferenceImage(src, crop) {
  const image = new Image();
  image.src = src;
  await image.decode().catch(() => { throw new Error('参考图损坏或格式不受支持，请更换图片。'); });
  const width = image.naturalWidth, height = image.naturalHeight;
  const encodedLength = src.length - src.indexOf(',') - 1;
  const bytes = encodedLength * 3 / 4 - (src.endsWith('==') ? 2 : src.endsWith('=') ? 1 : 0);
  if (width === height && bytes <= MAX_REFERENCE_BYTES) return src;
  const { x, y, side: sourceSide } = referenceCropBounds(width, height, crop);
  const canvas = document.createElement('canvas');
  let side = Math.min(sourceSide, 4096);
  try {
    while (side >= 1) {
      canvas.width = canvas.height = side;
      canvas.getContext('2d').drawImage(image, x, y,
        sourceSide, sourceSide, 0, 0, side, side);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('参考图裁切失败，请更换图片。');
      if (blob.size <= MAX_REFERENCE_BYTES) {
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('参考图裁切失败，请重试。'));
          reader.readAsDataURL(blob);
        });
      }
      // Keep transparent pixels while fitting the existing reference-image byte limit.
      side = Math.floor(side * Math.min(0.9, Math.sqrt(MAX_REFERENCE_BYTES / blob.size) * 0.95));
    }
    throw new Error('参考图过大，请缩小图片后重试。');
  } finally { canvas.width = canvas.height = 0; }
}

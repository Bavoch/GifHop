export function normalizeReferenceCrop(value) {
  const clamp = number => typeof number === 'number' && Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0.5;
  return { x: clamp(value?.x), y: clamp(value?.y) };
}

export function referenceCropBounds(width, height, value) {
  const crop = normalizeReferenceCrop(value);
  const side = Math.min(width, height);
  return { x: (width - side) * crop.x, y: (height - side) * crop.y, side };
}

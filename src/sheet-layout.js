function seamScores(image, vertical) {
  const canvas = document.createElement('canvas');
  canvas.width = vertical ? image.naturalWidth : Math.min(image.naturalWidth, 256);
  canvas.height = vertical ? Math.min(image.naturalHeight, 256) : image.naturalHeight;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  const { width, height } = canvas;
  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const length = vertical ? width : height;
  const samples = vertical ? height : width;
  const stride = vertical ? 4 : width * 4;
  const across = vertical ? width * 4 : 4;
  const scores = new Float32Array(length);
  for (let edge = 1; edge < length; edge++) {
    let sum = 0;
    for (let sample = 0; sample < samples; sample++) {
      const next = edge * stride + sample * across;
      const previous = next - stride;
      const delta = (Math.abs(data[next] - data[previous]) +
        Math.abs(data[next + 1] - data[previous + 1]) +
        Math.abs(data[next + 2] - data[previous + 2])) / 3;
      sum += Math.min(delta, 48);
    }
    scores[edge] = sum / samples;
  }
  return scores;
}

function findSeam(scores, expected) {
  const center = Math.round(expected);
  let position = center;
  for (let x = center - 2; x <= center + 2; x++) {
    if (scores[x] > scores[position]) position = x;
  }
  const nearby = (scores[center - 4] + scores[center + 4]) / 2;
  return scores[position] >= Math.max(5, nearby * 2.25) ? position : null;
}

export function findClippedSheetGrid(image, columns, rows) {
  const { naturalWidth: width, naturalHeight: height } = image;
  const nominalWidth = width / columns;
  if (nominalWidth < 64) return null;

  const interiors = Array.from({ length: columns - 1 }, (_, index) => index + 1);
  const verticalScores = seamScores(image, true);
  if (interiors.filter(index => findSeam(verticalScores, index * nominalWidth) !== null).length >= 3) {
    return null;
  }

  // Only recover a cropped last column when every preceding column has a strong periodic seam.
  let columnEdges;
  let bestStrength = 0;
  for (let step = Math.ceil(nominalWidth * 1.06); step <= nominalWidth * 1.18; step++) {
    const edges = interiors.map(index => findSeam(verticalScores, index * step));
    if (edges.includes(null)) continue;
    const strength = Math.min(...edges.map(edge => verticalScores[edge]));
    if (strength > bestStrength) {
      columnEdges = [0, ...edges];
      bestStrength = strength;
    }
  }
  if (!columnEdges) return null;

  const horizontalScores = seamScores(image, false);
  const rowEdges = [0, ...Array.from({ length: rows - 1 }, (_, index) => {
    const expected = (index + 1) * height / rows;
    return findSeam(horizontalScores, expected) ?? Math.round(expected);
  }), height];
  return { columnEdges, rowEdges };
}

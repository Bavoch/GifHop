// 前端导出编码器:GIF(自写 LZW)+ 动画 WebP(复用浏览器 still-WebP 编码器再封装 RIFF 容器)
// 输入统一为 RGBA 像素(Uint8ClampedArray),便于在 node 里用 sharp 做回归验证。

// ---------- 通用 ----------

const u16 = v => [v & 255, (v >> 8) & 255];
const u24 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255];
const u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];

class ByteOut {
  constructor() { this.bytes = []; }
  push(...arr) { for (const b of arr) this.bytes.push(b); }
  // 大块数据(VP8 码流等)不能展开入参,逐字节追加避免超出调用栈
  pushBytes(arr) { for (let i = 0; i < arr.length; i++) this.bytes.push(arr[i]); }
  ascii(str) { for (let i = 0; i < str.length; i++) this.bytes.push(str.charCodeAt(i)); }
  u16(v) { this.push(...u16(v)); }
  u24(v) { this.push(...u24(v)); }
  u32(v) { this.push(...u32(v)); }
  toUint8Array() { return new Uint8Array(this.bytes); }
}

// GIF/WebP(遵循 RIFF)的数据块都以长度前缀 + 数据 + pad 的方式对齐
const paddedSize = n => n + (n & 1);

// ---------- 调色板量化(中位切分) ----------

// 从全部帧采样像素做中位切分,返回最多 maxColors 个 [r,g,b]
function buildPalette(frames, width, height, maxColors) {
  const target = 60000;
  const total = frames.length * width * height;
  const stride = Math.max(1, Math.floor(total / target));
  const samples = [];
  for (const frame of frames) {
    for (let i = 0; i < width * height; i += stride) {
      const o = i * 4;
      if (frame[o + 3] < 128) continue; // 透明像素不参与配色
      samples.push([frame[o], frame[o + 1], frame[o + 2]]);
    }
  }
  if (!samples.length) return [[0, 0, 0]];

  let boxes = [samples];
  while (boxes.length < maxColors) {
    // 取体积(极差)最大的盒子切分
    let bi = -1, bestRange = -1;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      let range = -1;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const s of box) { if (s[c] < lo) lo = s[c]; if (s[c] > hi) hi = s[c]; }
        range = Math.max(range, hi - lo);
      }
      if (range > bestRange) { bestRange = range; bi = i; }
    });
    if (bi < 0 || bestRange <= 0) break;
    const box = boxes[bi];
    let ch = 0, chRange = -1;
    for (let c = 0; c < 3; c++) {
      let lo = 255, hi = 0;
      for (const s of box) { if (s[c] < lo) lo = s[c]; if (s[c] > hi) hi = s[c]; }
      if (hi - lo > chRange) { chRange = hi - lo; ch = c; }
    }
    box.sort((a, b) => a[ch] - b[ch]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }

  return boxes
    .filter(box => box.length)
    .map(box => {
      let r = 0, g = 0, b = 0;
      for (const s of box) { r += s[0]; g += s[1]; b += s[2]; }
      return [Math.round(r / box.length), Math.round(g / box.length), Math.round(b / box.length)];
    });
}

// 像素 → 调色板索引。缓存按 5bit/通道量化颜色,空间 32768 足够快。
function mapToIndices(frame, width, height, palette) {
  const cache = new Map();
  const indices = new Uint8Array(width * height);
  const transparent = 255;
  for (let i = 0, n = width * height; i < n; i++) {
    const o = i * 4;
    if (frame[o + 3] < 128) { indices[i] = transparent; continue; }
    const r = frame[o], g = frame[o + 1], b = frame[o + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let idx = cache.get(key);
    if (idx === undefined) {
      let best = 0, bestDist = Infinity;
      for (let p = 0; p < palette.length; p++) {
        const dr = r - palette[p][0], dg = g - palette[p][1], db = b - palette[p][2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) { bestDist = dist; best = p; }
      }
      idx = best;
      cache.set(key, idx);
    }
    indices[i] = idx;
  }
  return indices;
}

// ---------- GIF LZW ----------

// LZW 输出按 255 字节子块组织,GIF 要求每个图像描述符的数据由子块组成、以 0 结尾
class SubblockWriter {
  constructor(out) { this.out = out; this.block = []; }
  byte(b) {
    this.block.push(b);
    if (this.block.length === 255) this.flushBlock();
  }
  flushBlock() {
    if (this.block.length) {
      this.out.push(this.block.length, ...this.block);
      this.block = [];
    }
  }
  end() { this.flushBlock(); this.out.push(0); }
}

function lzwEncode(minCodeSize, indices, sub) {
  const CLEAR = 1 << minCodeSize;
  const EOI = CLEAR + 1;
  let width = minCodeSize + 1;
  let next = EOI + 1;
  const dict = new Map();

  let cur = 0, curBits = 0;
  const emit = code => {
    cur |= code << curBits;
    curBits += width;
    while (curBits >= 8) { sub.byte(cur & 255); cur >>= 8; curBits -= 8; }
  };

  emit(CLEAR);
  if (!indices.length) { emit(EOI); if (curBits > 0) sub.byte(cur & 255); sub.end(); return; }

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      // 解码方每读一个码才补一个表项、比编码方晚一步,因此升位要晚一个表项
      if (next === (1 << width) + 1 && width < 12) width++;
    } else {
      emit(CLEAR);
      dict.clear();
      next = EOI + 1;
      width = minCodeSize + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(EOI);
  if (curBits > 0) sub.byte(cur & 255);
  sub.end();
}

// ---------- GIF89a ----------

// frames: Uint8ClampedArray[] (RGBA), 透明像素(alpha<128)输出为 GIF 单比特透明
// onProgress(0~1) 每帧回调,并在帧间让出主线程,避免大图导出时卡住界面
export async function encodeGif({ frames, width, height, fps, onProgress }) {
  const palette = buildPalette(frames, width, height, 255);
  const out = new ByteOut();

  // 文件头 + 逻辑屏幕描述符(全局颜色表 256 项,不用图像本地表)
  out.ascii('GIF89a');
  out.u16(width); out.u16(height);
  out.push(0xF7, 255, 0); // 全局颜色表 8bit,背景色指向透明槽,像素宽高比 0

  // 全局颜色表:补齐到 256 项,末位留给透明索引
  for (let i = 0; i < 256; i++) {
    const c = i < palette.length ? palette[i] : [0, 0, 0];
    out.push(c[0], c[1], c[2]);
  }

  // 无限循环
  out.push(0x21, 0xFF, 0x0B);
  out.ascii('NETSCAPE2.0');
  out.push(0x03, 0x01, 0x00, 0x00, 0x00);

  const delayCs = Math.max(2, Math.round(100 / fps));
  for (let f = 0; f < frames.length; f++) {
    // 图形控制扩展:dispose=2(播后还原背景)保证透明帧不叠影
    out.push(0x21, 0xF9, 0x04, (2 << 2) | 1, ...u16(delayCs), 255, 0x00);
    // 图像描述符
    out.push(0x2C, ...u16(0), ...u16(0), ...u16(width), ...u16(height), 0x00);
    out.push(8); // LZW 最小码长
    lzwEncode(8, mapToIndices(frames[f], width, height, palette), new SubblockWriter(out));
    if (onProgress) onProgress((f + 1) / frames.length);
    await new Promise(r => setTimeout(r, 0));
  }

  out.push(0x3B); // Trailer
  return out.toUint8Array();
}

// ---------- 动画 WebP 封装 ----------

// 从 still-WebP 文件中抽出 ALPH / VP8 / VP8L 数据块(原样保留 fourcc+size+payload+pad)
function extractFrameChunks(webp /* Uint8Array */) {
  const chunks = [];
  if (webp.length < 12) return chunks;
  let off = 12;
  while (off + 8 <= webp.length) {
    const tag = String.fromCharCode(webp[off], webp[off + 1], webp[off + 2], webp[off + 3]);
    const size = webp[off + 4] | (webp[off + 5] << 8) | (webp[off + 6] << 16) | (webp[off + 7] << 24);
    if (tag === 'ALPH' || tag === 'VP8 ' || tag === 'VP8L') {
      chunks.push(webp.subarray(off, off + 8 + paddedSize(size)));
    }
    off += 8 + paddedSize(size);
  }
  return chunks;
}

// frameWebps: Uint8Array[](浏览器 canvas 编出的 still-WebP);循环播放
export function encodeAnimatedWebp({ frameWebps, width, height, fps }) {
  const hasAlpha = frameWebps.some(w => extractFrameChunks(w).some(c =>
    String.fromCharCode(c[0], c[1], c[2], c[3]) === 'ALPH'));
  const durationMs = Math.max(10, Math.round(1000 / fps));

  const writeChunk = (out, tag, payload) => {
    out.ascii(tag);
    out.u32(payload.length);
    out.pushBytes(payload.bytes ? payload.bytes : payload);
    if (payload.length & 1) out.push(0);
  };

  const out = new ByteOut();
  out.ascii('RIFF');
  out.u32(0); // 先占位,算完整个块再回填
  out.ascii('WEBP');

  // VP8X:A=动画,L=含 alpha;画布宽高按 (尺寸-1) 存 24bit
  const flags = 0x02 | (hasAlpha ? 0x10 : 0x00);
  writeChunk(out, 'VP8X', [flags, 0, 0, 0, ...u24(width - 1), ...u24(height - 1)]);
  // ANIM:背景色 BGRA 全零 + 循环 0 = 无限
  writeChunk(out, 'ANIM', [0, 0, 0, 0, 0, 0]);

  for (const webp of frameWebps) {
    const payload = new ByteOut();
    payload.u24(0); payload.u24(0);            // 帧偏移 x / y
    payload.u24(width - 1); payload.u24(height - 1);
    payload.u24(durationMs);
    payload.push(0x02);                        // B=1:整帧覆盖,不做 alpha 混合
    for (const chunk of extractFrameChunks(webp)) payload.pushBytes(chunk);
    writeChunk(out, 'ANMF', payload.bytes);
  }

  const bytes = out.toUint8Array();
  const size = bytes.length - 8;
  bytes[4] = size & 255; bytes[5] = (size >> 8) & 255;
  bytes[6] = (size >> 16) & 255; bytes[7] = (size >>> 24) & 255;
  return bytes;
}

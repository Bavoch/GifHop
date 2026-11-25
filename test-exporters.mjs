// 编码器回归验证:用 sharp 解码自产 GIF / 动画 WebP,校验结构与像素
import sharp from 'sharp';
import { encodeGif, encodeAnimatedWebp } from './src/exporters.js';

const W = 96, H = 96, N = 5, FPS = 12;

// 生成测试帧:每帧一个基准色 + 横向渐变 + 右下角透明区域
function makeFrame(hue) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      px[o] = (hue + x) % 256;
      px[o + 1] = Math.floor(hue * 0.7);
      px[o + 2] = 255 - hue;
      px[o + 3] = (x > W - 20 && y > H - 20) ? 0 : 255; // 右下角透明
    }
  }
  return px;
}
const frames = Array.from({ length: N }, (_, i) => makeFrame(i * 40));

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failed++;
};

// ---------- GIF ----------
const gif = await encodeGif({ frames, width: W, height: H, fps: FPS });


const gm = await sharp(gif, { animated: true }).metadata();
check('GIF 帧数', gm.pages === N, `pages=${gm.pages}`);
check('GIF 尺寸', gm.width === W && gm.height / gm.pages === H, `${gm.width}x${gm.page_height}`);
check('GIF 延迟', gm.delay?.length === N && gm.delay.every(d => d === 80), JSON.stringify(gm.delay));
check('GIF 循环', Buffer.from(gif).includes(Buffer.from('NETSCAPE2.0')), '');

// 逐帧像素验证:解码每一页,对比左上角像素(RGB)与右下角透明区
for (let i = 0; i < N; i++) {
  const page = await sharp(gif, { page: i, animated: true }).raw().toBuffer();
  const o = (0 * W + 1) * 4; // (1,0) 像素
  const expectR = (i * 40 + 1) % 256;
  const alphaPos = (H - 10) * W + (W - 10);
  const transparent = page[alphaPos * 4 + 3] === 0;
  const colorOk = page[o] === expectR && page[o + 3] === 255;
  if (i === 0) check('GIF 像素颜色', colorOk, `r=${page[o]} expect=${expectR}`);
  if (i === 0) check('GIF 透明区', transparent, `alpha=${page[alphaPos * 4 + 3]}`);
}

// LZW 字典溢出路径:16 色随机噪声(40k 像素 → 字典必满 4096,触发 clear 重置)
const noise = new Uint8ClampedArray(200 * 200 * 4);
const colors = [[10, 20, 30], [40, 80, 120], [200, 100, 50], [250, 250, 250], [0, 0, 0], [255, 0, 128], [60, 200, 60], [130, 130, 90], [90, 10, 200], [180, 220, 30], [30, 60, 200], [100, 0, 0], [0, 100, 0], [0, 0, 100], [128, 128, 128], [240, 200, 160]];
const noiseIdx = new Uint8Array(200 * 200);
for (let i = 0; i < 200 * 200; i++) {
  const c = (Math.random() * 16) | 0;
  noiseIdx[i] = c;
  const o = i * 4;
  noise[o] = colors[c][0]; noise[o + 1] = colors[c][1]; noise[o + 2] = colors[c][2]; noise[o + 3] = 255;
}
const noiseGif = await encodeGif({ frames: [noise], width: 200, height: 200, fps: FPS });
const decoded = await sharp(noiseGif).raw().toBuffer();
let mismatch = 0;
for (let i = 0; i < 200 * 200; i++) {
  const o = i * 4, c = colors[noiseIdx[i]];
  if (decoded[o] !== c[0] || decoded[o + 1] !== c[1] || decoded[o + 2] !== c[2]) mismatch++;
}
check('GIF LZW 溢出路径像素精确', mismatch === 0, `${mismatch} 像素不符`);

// ---------- 动画 WebP ----------
const stills = [];
for (const frame of frames) {
  stills.push(await sharp(Buffer.from(frame), { raw: { width: W, height: H, channels: 4 } }).webp({ quality: 90 }).toBuffer());
}
const webp = encodeAnimatedWebp({ frameWebps: stills, width: W, height: H, fps: FPS });

const wm = await sharp(webp, { animated: true }).metadata();
check('WebP 帧数', wm.pages === N, `pages=${wm.pages}`);
check('WebP 尺寸', wm.width === W && wm.height / wm.pages === H, `${wm.width}x${wm.page_height}`);
check('WebP 延迟', wm.delay?.length === N && wm.delay.every(d => d === 83), JSON.stringify(wm.delay));
const page0 = await sharp(webp, { page: 0, animated: true }).raw().toBuffer();
const wo = (0 * W + 1) * 4;
check('WebP 首帧像素(有损容差)', Math.abs(page0[wo] - 1) < 12 && page0[wo + 3] === 255, `r=${page0[wo]}`);
const wAlpha = page0[((H - 10) * W + (W - 10)) * 4 + 3];
check('WebP 透明区', wAlpha < 20, `alpha=${wAlpha}`);

// 无损 VP8L 路径
const llStills = [];
for (const frame of frames) {
  llStills.push(await sharp(Buffer.from(frame), { raw: { width: W, height: H, channels: 4 } }).webp({ lossless: true }).toBuffer());
}
const llWebp = encodeAnimatedWebp({ frameWebps: llStills, width: W, height: H, fps: FPS });

const lm = await sharp(llWebp, { animated: true }).metadata();
check('WebP VP8L 帧数', lm.pages === N, `pages=${lm.pages}`);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);

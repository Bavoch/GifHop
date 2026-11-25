import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sharp from 'sharp';

const sheet = `data:image/png;base64,${(await fs.readFile('tests/fixtures/sample-sheet.png')).toString('base64')}`;
const green = { r: 20, g: 180, b: 80 };
const fixture = async (width, height) => {
  const overlays = [];
  for (const [color, left, top, w, h] of width > height
    ? [['#ff0000', 0, 0, 150, height], ['#0000ff', width - 150, 0, 150, height]]
    : height > width ? [['#ff0000', 0, 0, width, 150], ['#0000ff', 0, height - 150, width, 150]] : []) {
    overlays.push({ input: await sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer(), left, top });
  }
  return sharp({ create: { width, height, channels: 3, background: green } }).composite(overlays).png().toBuffer();
};
const assertSquarePixels = async src => {
  const { data, info } = await sharp(Buffer.from(src.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 300);
  assert.equal(info.height, 300);
  for (let i = 0; i < data.length; i += 3) assert.deepEqual([...data.subarray(i, i + 3)], [green.r, green.g, green.b]);
};
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 700 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(sheet => {
    window.__square = { generations: [], asks: [] };
    window.fox24 = {
      autoRestoreRecovery: true, status: async () => ({ ready: true }), onProgress: () => () => {},
      readRecovery: async () => JSON.parse(localStorage.getItem('square-recovery') || 'null'),
      writeRecovery: async project => { window.__square.checkpoint = project; return project; },
      ask: async input => { window.__square.asks.push(input); return { text: '绿色方块跳动' }; },
      generate: async input => {
        window.__square.generations.push(input);
        return { image: sheet, title: '绿色方块跳动' };
      },
    };
  }, sheet);
  await page.goto(process.env.GIFHOP_TEST_URL || 'http://127.0.0.1:5173');
  const reference = page.getByRole('img', { name: '动画参考图', exact: true });
  const prompt = page.getByRole('textbox', { name: '动作描述', exact: true });
  const assertFilled = async () => {
    assert.ok(await page.locator('.preview-image').evaluateAll(images => images.every(image => {
      const box = image.getBoundingClientRect();
      const pane = image.closest('.preview-panel').getBoundingClientRect();
      return getComputedStyle(image).objectFit === 'cover' && Math.abs(box.width - box.height) < 1
        && Math.abs(box.x - pane.x) < 1 && Math.abs(box.y - pane.y) < 1
        && Math.abs(box.width - pane.width) < 1 && Math.abs(box.height - pane.height) < 1;
    })), 'reference and result fill their square panes edge to edge');
  };
  for (const [width, height] of [[600, 300], [300, 600], [300, 300]]) {
    const buffer = await fixture(width, height);
    await page.locator('input[type="file"]').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer });
    await reference.waitFor();
    await page.waitForFunction(([w, h]) => {
      const image = document.querySelector('img[alt="动画参考图"]');
      return image?.complete && image.naturalWidth === w && image.naturalHeight === h;
    }, [width, height]);
    await assertFilled();
    const { data, info } = await sharp(await page.locator('.reference-panel').screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const edge = (Math.floor(info.height / 2) * info.width + 1) * 3;
    assert.deepEqual([...data.subarray(edge, edge + 3)], [green.r, green.g, green.b], 'visible crop reaches the pane edge');
    await prompt.fill('绿色方块跳动');
    await page.getByRole('button', { name: 'AI 润色提示词', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.prompt-textarea').disabled);
    await assertSquarePixels(await page.evaluate(() => window.__square.asks.at(-1).referenceImage));
    if (height > width) await prompt.fill('');
    await page.getByRole('button', { name: '生成动画', exact: true }).click();
    await page.getByRole('img', { name: '动画预览画面', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.prompt-textarea').disabled);
    const sent = await page.evaluate(() => window.__square.generations.at(-1).referenceImage);
    if (height > width) assert.equal(await page.evaluate(() => window.__square.generations.at(-1).prompt), '', 'image-only generation uses the same crop');
    await assertSquarePixels(sent);
    if (width === height) assert.equal(sent, `data:image/png;base64,${buffer.toString('base64')}`, 'square references retain original bytes');
    await assertFilled();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await assertFilled();
  await fs.mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/square-filled-previews.png' });
  const legacy = `data:image/png;base64,${(await fixture(600, 300)).toString('base64')}`;
  await page.evaluate(referenceImage => localStorage.setItem('square-recovery', JSON.stringify({
    format: 'fox24', version: 1, prompt: '旧素材继续生成', referenceImage, slots: [{ sheet: null, offsets: [] }],
  })), legacy);
  await page.reload();
  await reference.waitFor();
  await page.waitForFunction(() => !document.querySelector('.prompt-textarea').disabled);
  await page.getByRole('button', { name: '生成动画', exact: true }).click();
  await page.waitForFunction(() => window.__square.generations.length === 1 && !document.querySelector('.prompt-textarea').disabled);
  await assertSquarePixels(await page.evaluate(() => window.__square.generations[0].referenceImage));
  assert.deepEqual(errors, []);
  console.log('PASS: edge-to-edge square input/result, landscape/portrait center crops, exact generated/polished pixels, original square bytes and legacy reference recovery (560px/1280px, headless).');
} finally { await browser.close(); }

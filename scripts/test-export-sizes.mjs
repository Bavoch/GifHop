import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sharp from 'sharp';

const base = process.env.GIFHOP_TEST_URL || 'http://127.0.0.1:5173';
const source = await fs.readFile('tests/fixtures/sample-sheet.png');
const image = `data:image/png;base64,${source.toString('base64')}`;
const metadata = await sharp(source).metadata();
const files = [];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 700 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('__captureExport', file => files.push({ name: file.name, bytes: Buffer.from(file.bytes) }));
  await page.addInitScript(image => {
    const clippedSheet = sessionStorage.getItem('clipped-sheet');
    const sheet = clippedSheet || image;
    window.__sheetDraws = [];
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (args[0]?.src === sheet && args.length === 9) window.__sheetDraws.push(args.slice(1));
      return drawImage.apply(this, args);
    };
    window.fox24 = {
      autoRestoreRecovery: true, status: async () => ({ ready: true }), onProgress: () => () => {},
      readRecovery: async () => ({ format: 'fox24', version: 2, prompt: '',
        slots: [{ sheet, offsets: clippedSheet ? [] : [{ dx: 8, dy: -5 }], title: '红绿灯闪烁' }] }),
      writeRecovery: async project => project,
      saveFile: async file => { await window.__captureExport({ name: file.name, bytes: Array.from(file.bytes) }); return true; },
    };
  }, image);
  await page.goto(base);
  await page.getByRole('img', { name: '动画预览画面', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.export-action').disabled);
  const trigger = page.locator('.export-format-trigger');
  const panel = page.getByRole('dialog', { name: '导出选项', exact: true });
  const sizeMenu = page.getByRole('menu', { name: '导出尺寸', exact: true });
  const formatMenu = page.getByRole('menu', { name: '导出格式', exact: true });
  await trigger.click();
  assert.deepEqual(await sizeMenu.getByRole('menuitemradio').allTextContents(), [
    '40 × 40', '80 × 80', '160 × 160', '240 × 240', '320 × 320', '480 × 480',
  ]);
  assert.equal(await sizeMenu.getByRole('menuitemradio', { name: '320 × 320', exact: true }).getAttribute('aria-checked'), 'true');
  const bounds = await panel.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 560 && bounds.y + bounds.height <= 700);
  await fs.mkdir('output/playwright', { recursive: true });
  await panel.screenshot({ path: 'output/playwright/export-size-options.png' });
  await page.keyboard.press('Tab');
  assert.ok(await sizeMenu.evaluate(el => el.contains(document.activeElement)), 'Tab moves from format to size choices');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await panel.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement === document.querySelector('.export-format-trigger'));
  assert.ok(await trigger.evaluate(el => el === document.activeElement), 'selection restores focus to trigger');
  await trigger.click();
  assert.equal(await sizeMenu.getByRole('menuitemradio', { name: '480 × 480', exact: true }).getAttribute('aria-checked'), 'true');
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  assert.equal(files.length, 0, 'choosing dimensions never starts an export');

  for (const [format, size] of [['GIF', 40], ['WebP', 80], ['视频', 160], ['GIF', 240], ['WebP', 320], ['视频', 480]]) {
    await trigger.click();
    await sizeMenu.getByRole('menuitemradio', { name: `${size} × ${size}`, exact: true }).click();
    await trigger.click();
    await formatMenu.getByRole('menuitemradio', { name: format, exact: true }).click();
    await trigger.click();
    assert.equal(await sizeMenu.getByRole('menuitemradio', { name: `${size} × ${size}`, exact: true }).getAttribute('aria-checked'), 'true', 'format changes retain dimensions');
    await page.mouse.click(4, 250);
    await panel.waitFor({ state: 'hidden' });
    await page.evaluate(() => { window.__sheetDraws = []; });
    const count = files.length;
    await page.locator('.export-action').click();
    await page.waitForFunction(() => !document.querySelector('.export-action').disabled, null, { timeout: 30000 });
    assert.equal(files.length, count + 1);
    const file = files.at(-1);
    assert.ok(file.name.startsWith(`红绿灯闪烁-${size}px.`));
    if (format === '视频') {
      const dimensions = await page.evaluate(bytes => new Promise((resolve, reject) => {
        const video = document.createElement('video');
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
        video.onloadedmetadata = () => { const result = [video.videoWidth, video.videoHeight]; URL.revokeObjectURL(url); resolve(result); };
        video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('视频元数据无法读取')); };
        video.src = url;
      }), [...file.bytes]);
      assert.deepEqual(dimensions, [size, size]);
    } else {
      const decoded = await sharp(file.bytes, { animated: true }).metadata();
      assert.equal(decoded.pages, 24);
      assert.equal(decoded.width, size);
      assert.equal(decoded.pageHeight, size);
    }
    const calls = await page.evaluate(() => window.__sheetDraws);
    assert.equal(calls.length, 24, 'exports read the original sheet');
    const side = Math.min(metadata.width / 6, metadata.height / 4);
    assert.ok(Math.abs(calls[0][0] - ((metadata.width / 6 - side) / 2 - 8 * side / 360)) < 0.001, 'legacy offsets retain their original coordinates');
    assert.equal(calls[0][6], size);
    assert.equal(calls[0][7], size);
  }
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('.export-action').disabled);
  await trigger.click();
  assert.equal(await sizeMenu.getByRole('menuitemradio', { name: '320 × 320', exact: true }).getAttribute('aria-checked'), 'true');
  assert.equal(await formatMenu.getByRole('menuitemradio', { name: 'GIF', exact: true }).getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('.workspace-notices, .product-notice').count(), 0);
  const clipped = await sharp({
    create: { width: 384, height: 256, channels: 3, background: '#296884' },
  }).composite(Array.from({ length: 20 }, (_, index) => ({
    input: { create: { width: 72, height: 64, channels: 3, background: index % 2 ? '#ce5020' : '#20a6ce' } },
    left: index % 5 * 72, top: Math.floor(index / 5) * 64,
  }))).png().toBuffer();
  await page.evaluate(src => sessionStorage.setItem('clipped-sheet', src), `data:image/png;base64,${clipped.toString('base64')}`);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('.export-action').disabled);
  await page.locator('.export-action').click();
  await page.waitForFunction(() => !document.querySelector('.export-action').disabled);
  assert.equal((await sharp(files.at(-1).bytes, { animated: true }).metadata()).pages, 20);
  const recovered = await page.evaluate(() => window.__sheetDraws);
  assert.equal(recovered.length, 40, 'both preview and export use the same 20 complete frames');
  assert.deepEqual(recovered[4].slice(0, 4), [292, 0, 64, 64]);
  assert.deepEqual(recovered[5].slice(0, 4), [4, 64, 64, 64]);
  assert.deepEqual(errors, []);
  console.log('PASS: size picker, keyboard navigation, session defaults, six actual output sizes across GIF/WebP/video, original-sheet decoding and legacy offsets (560px, headless).');
} finally { await browser.close(); }

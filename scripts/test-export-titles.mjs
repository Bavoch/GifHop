import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const image = `data:image/png;base64,${(await fs.readFile('tests/fixtures/sample-sheet.png')).toString('base64')}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 760 }, reducedMotion: 'reduce' });
  await page.addInitScript(image => {
    window.__titles = { calls: [], files: [], fail: false, hold: true, generated: false };
    window.fox24 = {
      autoRestoreRecovery: true, status: async () => ({ ready: true }), onProgress: () => () => {},
      readRecovery: async () => ({ format: 'fox24', version: 2, prompt: '当前输入并非动画内容',
        slots: [{ sheet: image, offsets: [], title: '', prompt: '旧提示词' }] }),
      writeRecovery: async project => { window.__titles.project = project; return project; },
      title: async input => {
        window.__titles.calls.push(input);
        if (window.__titles.hold) await new Promise(resolve => { window.__titles.release = resolve; });
        if (window.__titles.fail) throw new Error('模拟命名失败');
        return { title: '红绿灯依次闪烁' };
      },
      generate: async () => ({ image, title: '小猫伸懒腰' }),
      generateReference: async () => ({ image }),
      saveFile: async file => { window.__titles.files.push(file.name); return true; },
    };
  }, image);
  await page.goto(process.env.GIFHOP_TEST_URL || 'http://127.0.0.1:5173');
  await page.waitForFunction(() => !document.querySelector('.export-action').disabled);
  await page.locator('.export-format-trigger').click();
  await page.getByRole('menuitemradio', { name: 'WebP', exact: true }).click();
  await page.locator('.export-action').click();
  await page.waitForFunction(() => typeof window.__titles.release === 'function');
  assert.ok(await page.getByRole('button', { name: '导出中…', exact: true }).isDisabled());
  assert.ok(await page.locator('.export-format-trigger').isDisabled());
  assert.equal(await page.evaluate(() => window.__titles.files.length), 0);
  const input = await page.evaluate(() => window.__titles.calls[0]);
  assert.equal(input.referenceImage, image);
  assert.equal(input.versionId, undefined);
  assert.equal(input.prompt, '旧提示词');
  await page.evaluate(() => window.__titles.release());
  await page.waitForFunction(() => window.__titles.files.length === 1 && !document.querySelector('.export-action').disabled);
  assert.equal(await page.evaluate(() => window.__titles.files[0]), '红绿灯依次闪烁-360px.webp');
  await page.locator('.export-action').click();
  await page.waitForFunction(() => window.__titles.files.length === 2 && !document.querySelector('.export-action').disabled);
  assert.equal(await page.evaluate(() => window.__titles.calls.length), 1, 'repeated exports reuse the title');
  await page.getByRole('button', { name: '生成动画', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.export-action').disabled);
  await page.locator('.export-action').click();
  await page.waitForFunction(() => window.__titles.files.length === 3 && !document.querySelector('.export-action').disabled);
  assert.equal(await page.evaluate(() => window.__titles.files[2]), '小猫伸懒腰-360px.webp');
  assert.equal(await page.evaluate(() => window.__titles.calls.length), 1, 'generation titles need no second request');

  await page.reload();
  await page.waitForFunction(() => !document.querySelector('.export-action').disabled);
  await page.evaluate(() => { window.__titles.hold = false; window.__titles.fail = true; });
  await page.locator('.export-action').click();
  await page.getByRole('alert').filter({ hasText: '模拟命名失败' }).waitFor();
  assert.equal(await page.evaluate(() => window.__titles.files.length), 0, 'failed naming cannot export a generic filename');
  assert.ok(await page.getByRole('img', { name: '动画预览画面', exact: true }).isVisible());
  assert.ok(await page.locator('.export-action').isEnabled());
  assert.equal(await page.locator('.workspace-notices, .product-notice').count(), 0);
  console.log('PASS: actual-sheet naming input, immutable source prompt, busy button, Chinese filenames, title caching, generation title reuse, naming failure preservation and no banners (560px, headless).');
} finally { await browser.close(); }

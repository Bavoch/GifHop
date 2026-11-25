import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const base = process.env.GIFHOP_TEST_URL || 'http://127.0.0.1:5173';
const image = `data:image/png;base64,${(await fs.readFile('public/assets/builtin-animation-sheets/traffic-light.png')).toString('base64')}`;
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 760 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(image => {
    window.__feedback = { generateMode: 'success', saveMode: 'cancel', writeFails: false, saveCalls: 0 };
    window.fox24 = {
      status: async () => ({ ready: true }), onProgress: () => () => {},
      readRecovery: async () => ({ format: 'fox24', version: 1, prompt: '角色挥手', slots: [{ sheet: image, offsets: [] }] }),
      writeRecovery: async project => {
        if (window.__feedback.writeFails) throw new Error('模拟自动保存失败');
        return project;
      },
      title: async () => ({ title: '红绿灯闪烁' }),
      generate: async () => {
        if (window.__feedback.generateMode === 'fail') throw new Error('模拟生成失败，请重试');
        return { image, title: '红绿灯闪烁' };
      },
      generateReference: async () => ({ image }),
      saveFile: async () => {
        window.__feedback.saveCalls++;
        if (window.__feedback.saveMode === 'fail') throw new Error('模拟导出失败，请重试');
        return window.__feedback.saveMode !== 'cancel';
      },
    };
  }, image);
  const noBanners = async () => {
    assert.equal(await page.locator('.workspace-notices, .product-notice, [data-slot="alert"]').count(), 0);
    assert.deepEqual(await page.locator('.workspace').evaluate(el => [...el.children].map(child => child.className)), ['canvas-stage', 'composer-area']);
    assert.equal(await page.getByRole('button', { name: '关闭提示', exact: true }).count(), 0);
  };
  const inlineError = async text => {
    await page.locator('.composer-area > .workspace-error').filter({ hasText: text }).waitFor();
    await noBanners();
  };
  const generate = page.getByRole('button', { name: '生成动画', exact: true });
  const preview = page.getByRole('img', { name: '动画预览画面', exact: true });
  await page.goto(base);
  await page.locator('.result-panel').getByRole('button', { name: '恢复工程', exact: true }).waitFor();
  await noBanners();
  await page.getByRole('button', { name: '恢复工程', exact: true }).focus();
  await page.keyboard.press('Enter');
  await preview.waitFor();
  assert.equal(await page.getByText('工程已恢复', { exact: true }).count(), 0);
  await noBanners();

  await page.locator('.export-format-trigger').click();
  await page.getByRole('menuitemradio', { name: 'WebP', exact: true }).click();
  const exportButton = page.getByRole('button', { name: '导出 WebP', exact: true });
  await exportButton.click();
  await page.waitForFunction(() => window.__feedback.saveCalls === 1 && !document.querySelector('.export-action').disabled);
  assert.equal(await page.getByText('已取消保存', { exact: true }).count(), 0);
  assert.equal(await page.locator('.workspace-error').count(), 0);
  await noBanners();

  await page.evaluate(() => { window.__feedback.saveMode = 'fail'; });
  await exportButton.click();
  await inlineError('模拟导出失败');
  assert.ok(await preview.isVisible());
  await page.evaluate(() => { window.__feedback.saveMode = 'success'; });
  await exportButton.click();
  await page.waitForFunction(() => window.__feedback.saveCalls === 3 && !document.querySelector('.export-action').disabled);
  assert.equal(await page.locator('.workspace-error').count(), 0);
  await noBanners();

  await page.locator('input[type="file"]').setInputFiles({ name: 'unsupported.gif', mimeType: 'image/gif', buffer: Buffer.from('invalid') });
  await inlineError('仅支持 PNG、JPEG 或 WebP');
  await page.evaluate(() => { window.__feedback.generateMode = 'fail'; });
  await generate.click();
  await inlineError('模拟生成失败');
  assert.ok(await preview.isVisible());

  await page.evaluate(() => { window.__feedback.writeFails = true; });
  await page.getByRole('textbox', { name: '动作描述', exact: true }).fill('自动保存失败检查');
  await inlineError('模拟自动保存失败');
  await fs.mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/feedback-inline-error.png' });
  assert.ok(await page.locator('.workspace-error').evaluate(el => {
    const box = el.getBoundingClientRect();
    return box.right <= innerWidth && box.bottom <= innerHeight;
  }));
  await page.evaluate(() => { window.__feedback.writeFails = false; window.__feedback.generateMode = 'success'; });
  await generate.click();
  await page.waitForFunction(() => !document.querySelector('.prompt-textarea').disabled);
  assert.ok(await preview.isVisible());
  assert.ok(await generate.isEnabled());
  await noBanners();
  assert.deepEqual(errors, []);
  console.log('PASS: no title-bar banners for recovery, save cancellation/success/failure, invalid input, AI failure and autosave failure; inline feedback and recovery actions remain usable (560px, headless).');
} finally { await browser.close(); }

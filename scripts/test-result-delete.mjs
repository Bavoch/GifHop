import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sharp from 'sharp';

const base = process.env.GIFHOP_TEST_URL || 'http://127.0.0.1:5173';
const image = `data:image/png;base64,${(await sharp({ create: { width: 600, height: 400, channels: 3, background: '#8ab75e' } }).png().toBuffer()).toString('base64')}`;
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 700 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ image }) => {
    const project = { format: 'fox24', version: 2, prompt: '角色挥手', referenceImage: null,
      slots: [{ sheet: image, offsets: [], title: '', prompt: '角色挥手' }] };
    window.__test = { writes: 0, hold: false, fail: false, checkpoints: [] };
    window.fox24 = {
      autoRestoreRecovery: true, status: async () => ({ ready: true }), onProgress: () => () => {},
      readRecovery: async () => project,
      writeRecovery: async value => {
        window.__test.writes++;
        if (window.__test.hold) await new Promise(resolve => { window.__test.release = resolve; });
        if (window.__test.fail) throw new Error('模拟自动保存失败');
        window.__test.checkpoints.push(value); return value;
      },
    };
  }, { image });
  await page.goto(base);
  const preview = page.getByRole('img', { name: '动画预览画面', exact: true });
  const remove = page.getByRole('button', { name: '删除当前结果', exact: true });
  await preview.waitFor();
  await page.waitForFunction(() => !document.querySelector('.preview-delete').disabled);
  assert.equal(await page.getByRole('button', { name: '素材管理', exact: true }).count(), 0);
  await page.locator('.result-panel').hover();
  const pane = await page.locator('.result-panel').boundingBox();
  const button = await remove.boundingBox();
  assert.ok(Math.abs(pane.x + pane.width - button.x - button.width - 8) < 2);
  assert.ok(Math.abs(pane.y + pane.height - button.y - button.height - 8) < 2);
  await remove.focus();
  assert.ok(await remove.evaluate(el => el.matches(':focus-visible')));
  await fs.mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/result-delete.png' });

  await page.evaluate(() => { window.__test.hold = true; });
  await remove.focus();
  await page.keyboard.press('Enter');
  const deleting = page.getByRole('button', { name: '正在删除…', exact: true });
  await deleting.waitFor();
  assert.equal(await deleting.isDisabled(), true);
  assert.notEqual(await deleting.getAttribute('data-pending'), null);
  assert.equal(await deleting.locator('[data-slot="spinner"]').count(), 1);
  assert.ok(await preview.isVisible());
  const writes = await page.evaluate(() => window.__test.writes);
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.__test.writes), writes, 'repeated clicks share the pending deletion');
  await page.evaluate(() => window.__test.release());
  await preview.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('.prompt-textarea').disabled);
  assert.equal(await remove.count(), 0);
  assert.equal(await page.getByRole('button', { name: '导出 GIF', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: '导出 GIF', exact: true }).isDisabled(), true);
  const saved = await page.evaluate(() => window.__test.checkpoints.at(-1));
  assert.equal(saved.slots[0].sheet, null);
  assert.equal(saved.slots[0].offsets.length, 0);
  assert.equal(await page.getByRole('textbox', { name: '动作描述', exact: true }).inputValue(), '角色挥手');
  assert.equal(await page.locator('.workspace-notices, .product-notice').count(), 0, 'successful deletion is silent');
  assert.equal(await page.getByRole('button', { name: '撤销删除', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: direct delete placement, keyboard activation, pending state, duplicate prevention, empty checkpoint, silent success and no history UI (560px, headless).');
} finally { await browser.close(); }

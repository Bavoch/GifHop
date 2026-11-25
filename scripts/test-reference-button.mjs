import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sharp from 'sharp';

const png = async (width, height, background) => `data:image/png;base64,${(await sharp({ create: { width, height, channels: 3, background } }).png().toBuffer()).toString('base64')}`;
const oldSource = await png(300, 300, '#ce7853');
const newSource = await png(300, 300, '#4b84c6');
const nextSource = await png(300, 300, '#d0b44b');
const sheet = await png(600, 400, '#47876a');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 760 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ oldSource, newSource, nextSource, sheet }) => {
    const pending = new Map();
    window.__referenceButton = { calls: [], animations: [], cancels: [], saves: [], pending, newSource, nextSource };
    window.fox24 = {
      autoRestoreRecovery: true, status: async () => ({ ready: true }), onProgress: () => () => {},
      readRecovery: async () => JSON.parse(localStorage.getItem('reference-button-draft') || 'null') || {
        format: 'fox24', version: 2, prompt: '生成一只小猫', referenceImage: oldSource,
        slots: [{ sheet, offsets: [], title: '小猫挥手', prompt: '生成一只小猫' }],
      },
      writeRecovery: async project => {
        window.__referenceButton.saves.push(project);
        if (window.__referenceButton.holdSave) await new Promise(resolve => { window.__referenceButton.releaseSave = resolve; });
        localStorage.setItem('reference-button-draft', JSON.stringify(project));
        return project;
      },
      generateReference: input => new Promise((resolve, reject) => { window.__referenceButton.calls.push(input); pending.set(input.id, { resolve, reject }); }),
      generate: async input => {
        window.__referenceButton.animations.push(input);
        return { image: sheet, title: '小猫挥手' };
      },
      cancel: async id => { window.__referenceButton.cancels.push(id); },
    };
    window.__referenceButton.finish = (index, image) => pending.get(window.__referenceButton.calls[index].id).resolve({ image: image || newSource });
  }, { oldSource, newSource, nextSource, sheet });
  await page.goto(process.env.GIFHOP_TEST_URL || 'http://127.0.0.1:5173');
  const prompt = page.getByRole('textbox', { name: '动作描述', exact: true });
  const reference = page.getByRole('button', { name: '生成参考图', exact: true });
  const animation = page.getByRole('button', { name: '生成动画', exact: true });
  const source = page.getByRole('img', { name: '动画参考图', exact: true });
  const result = page.getByRole('img', { name: '动画预览画面', exact: true });
  const idle = () => page.waitForFunction(() => !document.querySelector('.prompt-textarea').disabled);
  await result.waitFor(); await idle();
  const originalResult = await result.getAttribute('src');
  const referenceBox = await reference.boundingBox(), animationBox = await animation.boundingBox();
  assert.ok(referenceBox.x + referenceBox.width <= animationBox.x && referenceBox.y === animationBox.y);
  await prompt.fill(''); assert.ok(await reference.isDisabled()); assert.ok(await animation.isEnabled());
  await prompt.fill('生成一只小猫');
  await animation.focus(); await page.keyboard.press('Shift+Tab');
  assert.ok(await reference.evaluate(el => el === document.activeElement));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__referenceButton.calls.length === 1);
  const cancel = page.getByRole('button', { name: '取消生成参考图', exact: true });
  assert.ok(await cancel.isEnabled()); assert.ok(await animation.isDisabled());
  await page.locator('.reference-panel .preview-loading').waitFor();
  assert.equal(await page.locator('.result-panel .preview-loading').count(), 0);
  assert.equal(await result.getAttribute('src'), originalResult);
  await page.evaluate(() => window.__referenceButton.pending.get(window.__referenceButton.calls[0].id).reject(new Error('模拟参考图失败')));
  await idle();
  assert.equal(await source.getAttribute('src'), oldSource); assert.equal(await result.getAttribute('src'), originalResult);

  await reference.click();
  await page.waitForFunction(() => window.__referenceButton.calls.length === 2);
  await cancel.click();
  const stopping = page.getByRole('button', { name: '正在停止参考图生成', exact: true });
  assert.ok(await stopping.isDisabled());
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.__referenceButton.cancels.length), 1);
  assert.equal(await page.evaluate(() => window.__referenceButton.cancels[0]), await page.evaluate(() => window.__referenceButton.calls[1].id));
  await page.evaluate(() => window.__referenceButton.pending.get(window.__referenceButton.calls[1].id).reject(new Error('已取消')));
  await idle();
  assert.equal(await source.getAttribute('src'), oldSource);

  await reference.click();
  await page.waitForFunction(() => window.__referenceButton.calls.length === 3);
  await page.evaluate(() => window.__referenceButton.finish(2)); await idle();
  assert.equal(await source.getAttribute('src'), newSource);
  assert.equal(await result.getAttribute('src'), originalResult);
  assert.equal(await page.evaluate(() => window.__referenceButton.animations.length), 0, 'reference action never launches animation');
  assert.ok(await page.evaluate(value => window.__referenceButton.saves.some(project => project.referenceImage === value), newSource));

  await page.evaluate(() => { window.__referenceButton.holdSave = true; });
  await reference.click();
  await page.waitForFunction(() => window.__referenceButton.calls.length === 4);
  await page.evaluate(() => window.__referenceButton.finish(3, window.__referenceButton.nextSource));
  await page.waitForFunction(() => typeof window.__referenceButton.releaseSave === 'function');
  assert.equal(await source.getAttribute('src'), nextSource);
  assert.equal(await page.locator('.reference-panel .preview-loading').count(), 0, 'completed image stays uncovered while saving');
  await cancel.click(); assert.ok(await stopping.isDisabled());
  await page.evaluate(() => { window.__referenceButton.holdSave = false; window.__referenceButton.releaseSave(); }); await idle();
  assert.equal(await page.evaluate(() => window.__referenceButton.animations.length), 0);
  await animation.click(); await idle();
  assert.equal(await page.evaluate(() => window.__referenceButton.animations[0].referenceImage), nextSource);
  assert.equal(await page.evaluate(() => window.__referenceButton.calls.length), 4, 'animation reuses the independently generated image');
  await page.reload(); await source.waitFor(); await idle();
  assert.equal(await source.getAttribute('src'), nextSource);
  for (const width of [375, 560]) {
    await page.setViewportSize({ width, height: 760 });
    assert.ok(await page.locator('.composer-actions button').evaluateAll(buttons => buttons.every(button => {
      const box = button.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
    })), 'action buttons fit narrow windows');
  }
  await fs.mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/standalone-reference-button.png' });
  assert.equal(await page.locator('.workspace-notices, .product-notice').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: reference button placement, keyboard order, empty-prompt guard, standalone generation/cancellation, old-image/result preservation, save boundary, animation reuse, recovery and narrow layout (375px/560px, headless).');
} finally { await browser.close(); }

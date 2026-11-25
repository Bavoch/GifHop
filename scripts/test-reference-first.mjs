import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sharp from 'sharp';

const reference = `data:image/png;base64,${(await sharp({ create: { width: 300, height: 300, channels: 3, background: '#df8b46' } }).png().toBuffer()).toString('base64')}`;
const sheet = `data:image/png;base64,${(await sharp({ create: { width: 600, height: 400, channels: 3, background: '#397e65' } }).png().toBuffer()).toString('base64')}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 760 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ reference, sheet }) => {
    const jobs = new Map();
    window.__first = { references: [], animations: [], cancellations: [], saves: [], jobs, reference, sheet, order: [] };
    const pending = (kind, input) => new Promise((resolve, reject) => {
      jobs.set(input.id, { resolve, reject });
      if (kind === 'reference') { window.__first.references.push(input); window.__first.order.push('reference'); }
      else {
        window.__first.animations.push({ ...input, visibleReference: document.querySelector('img[alt="动画参考图"]')?.src });
        window.__first.order.push('animation');
      }
    });
    window.fox24 = {
      autoRestoreRecovery: true, status: async () => ({ ready: true }),
      onProgress: callback => { window.__first.progress = callback; return () => {}; },
      readRecovery: async () => JSON.parse(localStorage.getItem('reference-first-draft') || 'null'),
      writeRecovery: async project => {
        if (project.referenceImage) {
          window.__first.saves.push(project);
          window.__first.order.push('save');
          if (window.__first.holdSave) await new Promise(resolve => { window.__first.releaseSave = resolve; });
        }
        localStorage.setItem('reference-first-draft', JSON.stringify(project));
        return project;
      },
      generateReference: input => pending('reference', input),
      generate: input => pending('animation', input),
      cancel: async id => { window.__first.cancellations.push(id); },
    };
    window.__first.finishReference = index => jobs.get(window.__first.references[index].id).resolve({ image: reference });
    window.__first.finishAnimation = index => jobs.get(window.__first.animations[index].id).resolve({ image: sheet, title: '小猫挥手' });
  }, { reference, sheet });
  await page.goto(process.env.GIFHOP_TEST_URL || 'http://127.0.0.1:5173');
  const input = page.getByRole('textbox', { name: '动作描述', exact: true });
  const generate = page.getByRole('button', { name: '生成动画', exact: true });
  const source = page.getByRole('img', { name: '动画参考图', exact: true });
  const result = page.getByRole('img', { name: '动画预览画面', exact: true });
  const idle = () => page.waitForFunction(() => !document.querySelector('.generate-button').disabled && document.querySelector('.generate-button').textContent.includes('生成动画'));
  await page.waitForFunction(() => !document.querySelector('.prompt-textarea').disabled);
  assert.ok(await generate.isDisabled());
  await input.fill('橘猫拿着小旗挥手');
  await input.press('Enter');
  await page.waitForFunction(() => window.__first.references.length === 1);
  assert.equal(await page.evaluate(() => window.__first.animations.length), 0);
  await page.locator('.reference-panel .preview-loading').getByText('正在生成参考图…', { exact: true }).waitFor();
  assert.equal(await page.locator('.result-panel .preview-loading').count(), 0);
  assert.ok(await page.getByRole('button', { name: '取消生成', exact: true }).isEnabled());
  await fs.mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/reference-first-stage.png' });
  await page.evaluate(() => window.__first.finishReference(0));
  await page.waitForFunction(() => window.__first.animations.length === 1);
  assert.equal(await source.getAttribute('src'), reference);
  const first = await page.evaluate(() => window.__first.animations[0]);
  assert.equal(first.referenceImage, reference);
  assert.equal(first.visibleReference, reference, 'left image is committed before dependent generation');
  assert.equal(first.prompt, '橘猫拿着小旗挥手');
  assert.ok((await page.evaluate(() => window.__first.order.join(','))).startsWith('reference,save,animation'));
  const referenceId = await page.evaluate(() => window.__first.references[0].id);
  assert.equal(referenceId, `${first.id}-reference`);
  await page.evaluate(id => window.__first.progress({ id, stage: 'creating-reference' }), referenceId);
  await page.locator('.result-panel .preview-loading').getByText('正在生成动画…', { exact: true }).waitFor();
  await page.screenshot({ path: 'output/playwright/reference-first-animation.png' });
  await page.evaluate(() => window.__first.finishAnimation(0)); await idle(); await result.waitFor();

  await page.locator('.reference-panel').hover();
  await page.getByRole('button', { name: '移除图片', exact: true }).click();
  await generate.click();
  await page.waitForFunction(() => window.__first.references.length === 2);
  await page.evaluate(() => window.__first.jobs.get(window.__first.references[1].id).reject(new Error('模拟参考图失败')));
  await idle();
  assert.equal(await source.count(), 0);
  assert.ok(await result.isVisible());
  assert.equal(await page.evaluate(() => window.__first.animations.length), 1);
  await generate.click();
  await page.waitForFunction(() => window.__first.references.length === 3);
  await page.getByRole('button', { name: '取消生成', exact: true }).click();
  const stopping = page.getByRole('button', { name: '正在停止…', exact: true });
  assert.ok(await stopping.isDisabled());
  assert.equal(await page.evaluate(() => window.__first.cancellations.at(-1)), await page.evaluate(() => window.__first.references[2].id));
  await page.evaluate(() => {
    const id = window.__first.references[2].id;
    window.__first.progress({ id, stage: 'creating-reference' });
  });
  await page.locator('.reference-panel .preview-loading').getByText('正在取消…', { exact: true }).waitFor();
  assert.ok(await stopping.isDisabled(), 'cancel acknowledgement does not end an active stage');
  await page.evaluate(() => window.__first.jobs.get(window.__first.references[2].id).reject(new Error('已取消')));
  await idle();
  assert.equal(await page.evaluate(() => window.__first.animations.length), 1);

  await generate.click();
  await page.waitForFunction(() => window.__first.references.length === 4);
  await page.evaluate(() => window.__first.finishReference(3));
  await page.waitForFunction(() => window.__first.animations.length === 2);
  await page.evaluate(() => window.__first.jobs.get(window.__first.animations[1].id).reject(new Error('模拟动画失败')));
  await idle();
  assert.equal(await source.getAttribute('src'), reference);
  assert.ok(await result.isVisible());
  await generate.click();
  await page.waitForFunction(() => window.__first.animations.length === 3);
  assert.equal(await page.evaluate(() => window.__first.references.length), 4, 'retry reuses the retained reference');
  await page.getByRole('button', { name: '取消生成', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__first.cancellations.at(-1)), await page.evaluate(() => window.__first.animations[2].id));
  assert.ok(await stopping.isDisabled());
  await page.evaluate(() => window.__first.jobs.get(window.__first.animations[2].id).reject(new Error('已取消')));
  await idle();

  await page.locator('.reference-panel').hover();
  await page.getByRole('button', { name: '移除图片', exact: true }).click();
  await page.evaluate(() => { window.__first.holdSave = true; });
  await generate.click();
  await page.waitForFunction(() => window.__first.references.length === 5);
  await page.evaluate(() => window.__first.finishReference(4));
  await page.waitForFunction(() => typeof window.__first.releaseSave === 'function');
  await page.getByRole('button', { name: '取消生成', exact: true }).click();
  await page.evaluate(() => { window.__first.holdSave = false; window.__first.releaseSave(); }); await idle();
  assert.equal(await page.evaluate(() => window.__first.animations.length), 3, 'cancellation at the stage boundary cannot launch animation');
  assert.equal(await source.getAttribute('src'), reference);
  await page.reload(); await source.waitFor(); await idle();
  assert.equal(await source.getAttribute('src'), reference, 'completed reference survives recovery');
  await generate.click();
  await page.waitForFunction(() => window.__first.animations.length === 1);
  assert.equal(await page.evaluate(() => window.__first.references.length), 0, 'recovery does not regenerate the first stage');
  await page.evaluate(() => window.__first.finishAnimation(0)); await idle();
  assert.equal(await page.locator('.workspace-notices, .product-notice').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: sequential reference-first generation, left/right stage feedback, committed reference and checkpoint, independent job IDs, failures/retries, cancellation in both stages and at their boundary, and recovery (560px, headless).');
} finally { await browser.close(); }

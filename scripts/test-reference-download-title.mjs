import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sharp from 'sharp';

const solid = async color => sharp({ create: { width: 300, height: 300, channels: 3, background: color } }).png().toBuffer();
const red = await solid('#ff0000'), blue = await solid('#0000ff');
const wide = await sharp({ create: { width: 600, height: 300, channels: 3, background: '#000000' } })
  .composite([{ input: red, left: 0, top: 0 }, { input: blue, left: 300, top: 0 }]).png().toBuffer();
const source = `data:image/png;base64,${wide.toString('base64')}`;
const sheet = `data:image/png;base64,${(await sharp({ create: { width: 600, height: 400, channels: 3, background: '#397e65' } }).png().toBuffer()).toString('base64')}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 760 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ source, sheet }) => {
    window.__referenceNames = { names: [], files: [], hold: true, nextTitle: '蓝色海洋', fail: false, save: true };
    window.fox24 = {
      autoRestoreRecovery: true, status: async () => ({ ready: !window.__referenceNames.offline, installed: true }), onProgress: () => () => {},
      readRecovery: async () => JSON.parse(localStorage.getItem('reference-name-draft') || 'null') || {
        format: 'fox24', version: 2, prompt: '与图片无关的当前提示词', referenceImage: source,
        referenceCrop: { x: 1, y: 0.5 }, slots: [{ sheet, offsets: [], title: '旧动画的标题', prompt: '旧动画提示词' }],
      },
      writeRecovery: async project => { window.__referenceNames.saved = project; localStorage.setItem('reference-name-draft', JSON.stringify(project)); return project; },
      title: async input => {
        window.__referenceNames.names.push(input);
        if (window.__referenceNames.hold) await new Promise(resolve => { window.__referenceNames.release = resolve; });
        if (window.__referenceNames.fail || window.__referenceNames.offline) throw new Error('模拟图片命名失败');
        return { title: window.__referenceNames.nextTitle };
      },
      saveFile: async input => { window.__referenceNames.files.push({ name: input.name, bytes: Array.from(input.bytes) }); return window.__referenceNames.save; },
    };
  }, { source, sheet });
  await page.goto(process.env.GIFHOP_TEST_URL || 'http://127.0.0.1:5173');
  const image = page.getByRole('img', { name: '动画参考图', exact: true });
  const result = page.getByRole('img', { name: '动画预览画面', exact: true });
  const download = page.getByRole('button', { name: '下载参考图', exact: true });
  const crop = page.getByRole('slider', { name: '图片取景位置', exact: true });
  await result.waitFor(); await page.waitForFunction(() => !document.querySelector('.prompt-textarea').disabled);
  const resultBefore = await result.getAttribute('src');
  await page.locator('.reference-panel').hover(); await download.click();
  await page.waitForFunction(() => typeof window.__referenceNames.release === 'function');
  const busy = page.getByRole('button', { name: '正在下载参考图', exact: true });
  assert.ok(await busy.isDisabled());
  assert.equal(await page.evaluate(() => window.__referenceNames.files.length), 0, 'naming completes before saving');
  const naming = await page.evaluate(() => window.__referenceNames.names[0]);
  assert.equal(naming.target, 'reference'); assert.equal(naming.versionId, undefined); assert.equal(naming.prompt, undefined);
  const namedPixels = await sharp(Buffer.from(naming.referenceImage.split(',')[1], 'base64')).raw().toBuffer();
  assert.deepEqual([...namedPixels.subarray(0, 3)], [0, 0, 255], 'AI sees only the selected blue crop');
  await page.evaluate(() => { window.__referenceNames.hold = false; window.__referenceNames.release(); });
  await download.waitFor(); assert.ok(await download.isEnabled());
  assert.equal(await page.evaluate(() => window.__referenceNames.files[0].name), '蓝色海洋.png');
  await download.click(); await download.waitFor();
  assert.equal(await page.evaluate(() => window.__referenceNames.names.length), 1, 'unchanged picture reuses its AI title');
  await page.getByRole('textbox', { name: '动作描述', exact: true }).fill('再换一个与图片无关的提示词');
  await download.click(); await download.waitFor();
  assert.equal(await page.evaluate(() => window.__referenceNames.names.length), 1, 'editing text cannot change picture-based naming');

  await crop.focus(); await page.keyboard.press('Home');
  await page.evaluate(() => { window.__referenceNames.nextTitle = '红色夕阳'; });
  await download.click(); await download.waitFor();
  assert.equal(await page.evaluate(() => window.__referenceNames.names.length), 2, 'changed visible crop invalidates the previous title');
  assert.equal(await page.evaluate(() => window.__referenceNames.files.at(-1).name), '红色夕阳.png');
  const previousFiles = await page.evaluate(() => window.__referenceNames.files.length);
  await crop.focus(); await page.keyboard.press('End');
  await page.evaluate(() => { window.__referenceNames.fail = true; });
  await download.click();
  await page.locator('.workspace-error').filter({ hasText: '模拟图片命名失败' }).waitFor();
  assert.ok(await download.isEnabled());
  assert.equal(await page.evaluate(() => window.__referenceNames.files.length), previousFiles, 'failed naming never falls back to a generic filename');
  await page.evaluate(() => { window.__referenceNames.fail = false; window.__referenceNames.nextTitle = '蓝色星空波光流转宁静海面映出梦幻月色'; window.__referenceNames.save = false; });
  await download.click(); await download.waitFor();
  const last = await page.evaluate(() => window.__referenceNames.files.at(-1));
  assert.ok(Array.from(last.name.replace(/\.png$/, '')).length <= 12);
  assert.equal(await page.locator('.workspace-error').count(), 0, 'cancelled save is silent');
  const namedCount = await page.evaluate(() => window.__referenceNames.names.length);
  await download.click(); await download.waitFor();
  assert.equal(await page.evaluate(() => window.__referenceNames.names.length), namedCount, 'cancelled save keeps the completed title');
  await page.waitForFunction(() => window.__referenceNames.saved?.referenceTitle?.title && window.__referenceNames.saved.referenceCrop.x === 1);
  assert.equal(await image.getAttribute('src'), source); assert.equal(await result.getAttribute('src'), resultBefore);
  await page.reload(); await result.waitFor(); await page.waitForFunction(() => !document.querySelector('.prompt-textarea').disabled);
  await page.evaluate(() => { window.__referenceNames.offline = true; window.dispatchEvent(new Event('focus')); });
  await page.locator('.reference-panel').hover(); await download.click(); await download.waitFor();
  assert.equal(await page.evaluate(() => window.__referenceNames.names.length), 0, 'saved image title survives reload and works offline');
  assert.equal(await page.evaluate(() => window.__referenceNames.files[0].name), last.name);
  assert.deepEqual(errors, []);
  console.log('PASS: static-image naming from actual crop, no prompt/animation-title contamination, <=12-character filenames, pending state, content-aware cache/reload/offline use, failure retry, cancelled-save reuse and source/result preservation (560px, headless).');
} finally { await browser.close(); }

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sharp from 'sharp';

const sheet = `data:image/png;base64,${(await sharp({ create: { width: 600, height: 400, channels: 3, background: '#346a42' } }).png().toBuffer()).toString('base64')}`;
const colors = ['#ff0000', '#00ff00', '#0000ff'];
const source = async vertical => sharp({ create: { width: vertical ? 300 : 900, height: vertical ? 900 : 300, channels: 3, background: '#000000' } })
  .composite(await Promise.all(colors.map(async (color, index) => ({
    input: await sharp({ create: { width: 300, height: 300, channels: 3, background: color } }).png().toBuffer(),
    left: vertical ? 0 : index * 300, top: vertical ? index * 300 : 0,
  })))).png().toBuffer();
const assertPixels = async (src, rgb) => {
  const { data, info } = await sharp(Buffer.from(src.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 300); assert.equal(info.height, 300);
  for (let offset = 0; offset < data.length; offset += 3) {
    if (!rgb.every((channel, index) => data[offset + index] === channel)) assert.fail(`crop includes pixels outside the selected region at ${offset}`);
  }
};
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 560, height: 760 }, hasTouch: true, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(sheet => {
    window.__pan = { generations: [], asks: [], checkpoints: [] };
    window.fox24 = {
      autoRestoreRecovery: true, status: async () => ({ ready: true }), onProgress: () => () => {},
      readRecovery: async () => JSON.parse(localStorage.getItem('pan-checkpoint') || 'null'),
      writeRecovery: async project => { window.__pan.checkpoints.push(project); localStorage.setItem('pan-checkpoint', JSON.stringify(project)); return project; },
      generate: async input => {
        window.__pan.generations.push(input);
        if (window.__pan.hold) await new Promise(resolve => { window.__pan.release = resolve; });
        return { image: sheet, title: '角色挥手' };
      },
      ask: async input => { window.__pan.asks.push(input); return { text: '角色挥手' }; },
    };
  }, sheet);
  await page.goto(process.env.GIFHOP_TEST_URL || 'http://127.0.0.1:5173');
  const slider = page.getByRole('slider', { name: '图片取景位置', exact: true });
  const wide = await source(false), portrait = await source(true);
  const upload = async (buffer, orientation) => {
    await page.locator('input[type="file"]').setInputFiles({ name: 'source.png', mimeType: 'image/png', buffer });
    await slider.waitFor();
    await page.waitForFunction(value => document.querySelector('[role="slider"]')?.getAttribute('aria-orientation') === value, orientation);
    assert.equal(await slider.getAttribute('aria-valuenow'), '50');
  };
  const idle = () => page.waitForFunction(() => !document.querySelector('.prompt-textarea').disabled);
  const drag = async (vertical, delta) => {
    const box = await slider.boundingBox();
    const x = box.x + box.width * (delta < 0 && !vertical ? 0.9 : 0.5);
    const y = box.y + box.height * (delta < 0 && vertical ? 0.9 : 0.5);
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + (vertical ? 0 : box.width * delta), y + (vertical ? box.height * delta : 0), { steps: 6 });
    await page.mouse.up();
    assert.equal(await slider.getAttribute('data-dragging'), 'false');
  };
  await upload(wide, 'horizontal');
  await slider.focus();
  await page.keyboard.press('ArrowRight'); assert.equal(await slider.getAttribute('aria-valuenow'), '51');
  await page.keyboard.press('Shift+ArrowLeft'); assert.equal(await slider.getAttribute('aria-valuenow'), '41');
  await page.keyboard.press('Escape'); assert.equal(await slider.getAttribute('aria-valuenow'), '50');
  assert.ok(await slider.evaluate(el => el.matches(':focus-visible')));
  await drag(false, 2);
  assert.equal(await slider.getAttribute('aria-valuenow'), '0', 'captured drag outside the pane clamps at the first edge');
  await page.waitForFunction(() => window.__pan.checkpoints.at(-1)?.referenceCrop?.x === 0);
  assert.equal(await page.evaluate(() => window.__pan.generations.length), 0, 'panning never requests AI');
  await page.getByRole('textbox', { name: '动作描述', exact: true }).fill('角色挥手');
  await page.evaluate(() => { window.__pan.hold = true; });
  await page.getByRole('button', { name: '生成动画', exact: true }).click();
  await page.waitForFunction(() => typeof window.__pan.release === 'function');
  assert.equal(await slider.getAttribute('aria-disabled'), 'true');
  const first = await page.evaluate(() => window.__pan.generations[0]);
  await assertPixels(first.referenceImage, [255, 0, 0]);
  await page.evaluate(() => { window.__pan.hold = false; window.__pan.release(); }); await idle();
  assert.equal(await slider.getAttribute('aria-valuenow'), '0', 'generation retains the full source and crop position');
  for (let i = 0; i < 3; i++) await drag(false, -0.8);
  assert.equal(await slider.getAttribute('aria-valuenow'), '100');
  await page.getByRole('button', { name: 'AI 润色提示词', exact: true }).click(); await idle();
  await assertPixels(await page.evaluate(() => window.__pan.asks.at(-1).referenceImage), [0, 0, 255]);
  await page.getByRole('button', { name: '生成动画', exact: true }).click(); await idle();
  await assertPixels(await page.evaluate(() => window.__pan.generations.at(-1).referenceImage), [0, 0, 255]);
  await page.locator('.result-panel').hover();
  await page.reload(); await slider.waitFor(); await idle();
  assert.equal(await slider.getAttribute('aria-valuenow'), '0', 'reload restores the saved crop');
  assert.equal(await page.locator('img[alt="动画参考图"]').evaluate(el => el.naturalWidth), 900);

  await upload(portrait, 'vertical');
  const box = await slider.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + box.height * 1.4 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await slider.getAttribute('aria-valuenow'), '0', 'touch panning selects the top edge');
  assert.equal(await slider.getAttribute('data-dragging'), 'false');
  await page.getByRole('textbox', { name: '动作描述', exact: true }).fill('');
  await page.getByRole('button', { name: '生成动画', exact: true }).click(); await idle();
  await assertPixels(await page.evaluate(() => window.__pan.generations.at(-1).referenceImage), [255, 0, 0]);
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await slider.getAttribute('aria-valuenow'), '0', 'resizing retains source-relative crop');
  await fs.mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/reference-pan.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: mouse/touch panning, pointer capture and clamping, keyboard focus, exact cropped generation/polishing pixels, preserved originals, idle save, reload and resize (560px/1280px, headless).');
} catch (error) {
  console.log(await page.evaluate(() => ({ error: document.querySelector('.workspace-error')?.textContent,
    generations: window.__pan.generations.length,
    crop: document.querySelector('[role="slider"]')?.getAttribute('aria-valuenow'),
    generating: document.querySelector('.generate-button')?.textContent, promptDisabled: document.querySelector('.prompt-textarea')?.disabled })));
  throw error;
} finally { await browser.close(); }

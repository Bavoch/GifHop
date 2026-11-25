import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 700 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__connection = { calls: 0, hold: true, fail: false, value: { ready: true } };
    window.fox24 = {
      readRecovery: async () => null, writeRecovery: async () => {}, onProgress: () => () => {},
      status: async () => {
        window.__connection.calls++;
        if (window.__connection.hold) await new Promise(resolve => { window.__connection.release = resolve; });
        if (window.__connection.fail) throw new Error('检测失败，请检查登录后返回应用');
        return window.__connection.value;
      },
    };
  });
  await page.goto(process.env.GIFHOP_TEST_URL || 'http://127.0.0.1:5173');
  await page.waitForFunction(() => typeof window.__connection.release === 'function');
  const banner = page.locator('.connection-banner');
  assert.equal(await banner.count(), 0, 'initial checking does not flash a warning');
  await page.evaluate(() => { window.__connection.hold = false; window.__connection.release(); });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await banner.count(), 0);
  assert.equal(await page.getByText('Codex 已连接', { exact: true }).count(), 0);
  assert.equal(await page.locator('.hardware-header .connection-status, .hardware-header .connection-banner').count(), 0);

  for (const [value, label, text] of [
    [{ ready: false, installed: false, message: '请安装 Codex CLI 后运行 codex login。' }, '未找到 Codex', '请安装 Codex CLI'],
    [{ ready: false, compatible: false, message: '请升级 Codex CLI。' }, 'Codex 需升级', '请升级 Codex CLI'],
    [{ ready: false, loggedIn: false, message: '请运行 codex login 并使用 ChatGPT 登录。' }, 'Codex 未登录', 'codex login'],
    [{ ready: false, message: '当前账号未提供可用的低成本模型，请检查 Codex 账号权限。' }, 'Codex 未连接', '低成本模型'],
  ]) {
    await page.evaluate(value => { window.__connection.value = value; window.dispatchEvent(new Event('focus')); }, value);
    await page.getByRole('alert', { name: label, exact: true }).waitFor();
    await page.getByText(text, { exact: false }).waitFor();
    assert.equal(await banner.count(), 1);
    assert.ok(await banner.evaluate(el => {
      const box = el.getBoundingClientRect();
      const header = document.querySelector('.hardware-header').getBoundingClientRect();
      return box.top >= header.bottom && box.left >= 0 && box.right <= innerWidth;
    }));
  }
  await fs.mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/codex-disconnected-banner.png' });

  const calls = await page.evaluate(() => window.__connection.calls);
  await page.evaluate(() => {
    window.__connection.hold = true;
    window.__connection.value = { ready: true };
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.evaluate(() => window.__connection.calls), calls + 1, 'overlapping checks share one request');
  assert.ok(await banner.isVisible(), 'warning stays until connection is actually confirmed');
  assert.equal(await banner.getAttribute('aria-busy'), 'true');
  await page.evaluate(() => { window.__connection.hold = false; window.__connection.release(); });
  await banner.waitFor({ state: 'hidden' });
  assert.equal(await page.getByText('Codex 已连接', { exact: true }).count(), 0);

  await page.evaluate(() => { window.__connection.fail = true; window.dispatchEvent(new Event('focus')); });
  await page.getByRole('alert', { name: 'Codex 未连接', exact: true }).waitFor();
  assert.ok((await banner.textContent()).includes('检测失败'));
  await page.evaluate(() => { window.__connection.fail = false; window.__connection.value = { ready: false, mode: 'browser-preview' }; window.dispatchEvent(new Event('focus')); });
  await banner.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log('PASS: silent connected/checking states, disconnected-only banner, install/upgrade/login/model failures, recheck coalescing, reconnect removal and browser-preview distinction (560px, headless).');
} finally { await browser.close(); }

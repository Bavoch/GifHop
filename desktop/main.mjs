import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session } from 'electron';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { developmentOrigin } from './development.mjs';
import { CodexService, safeMessage } from './codex.mjs';
import { assetPath, MAX_FILE, validateProject, validExportFilename } from './validation.mjs';
import { AssetStore, atomicWrite } from './asset-store.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const smoke = process.argv.includes('--smoke-test');
// Preserve settings, recovery and Chromium storage across the product rename.
if (!smoke) {
  const legacyUserData = path.join(app.getPath('appData'), 'fox24');
  mkdirSync(legacyUserData, { recursive: true });
  app.setPath('userData', legacyUserData);
}
app.setName('GifHop');
nativeTheme.themeSource = 'dark';
const devURL = developmentOrigin(process.env.FOX24_DEV_URL, { packaged: app.isPackaged });
const devSocketURL = devURL.replace(/^http:/, 'ws:');
// 每次打开应用都自动加载上次的工程状态，不再弹出「找到上次的工程」确认。
// 打包应用默认开启；开发模式由 dev.mjs 通过 GIFHOP_DEV_AUTO_RESTORE 传入（默认也为开启）。
// 如需临时关闭，显式设置 GIFHOP_DEV_AUTO_RESTORE=0 即可。
const autoRestoreRecovery = app.isPackaged || process.env.GIFHOP_DEV_AUTO_RESTORE !== '0';
const iconRoot = path.join(root, app.isPackaged ? 'dist' : 'public', 'assets/gifmaker-icon');
const windowIcon = path.join(iconRoot, process.platform === 'win32' ? 'windows/icon.ico'
  : process.platform === 'darwin' ? 'macos/icon-1024.png' : 'linux/icon-512.png');
if (smoke) app.setPath('userData', process.env.FOX24_TEST_DATA || path.join(app.getPath('temp'), `fox24-smoke-${process.pid}`));
protocol.registerSchemesAsPrivileged([{ scheme: 'fox24', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.enableSandbox();
let window;
let stoppingDevelopment = false;
let recoveryQueue = Promise.resolve();
let assets;
let recoveryProtected = false;
const codex = new CodexService({
  onProgress: event => { if (window && !window.isDestroyed()) window.webContents.send('codex:progress', event); },
  onDiagnostic: event => atomicWrite(dataPath('last-generation.json'), JSON.stringify(event)),
});
const dataPath = name => path.join(app.getPath('userData'), name);
if (devURL && process.send) {
  let stopTask;
  const checkpointRenderer = () => {
    if (!window || window.isDestroyed() || window.webContents.isLoading()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const finish = error => {
        clearTimeout(timeout);
        ipcMain.off('development:restart-ready', ready);
        if (error) reject(error); else resolve();
      };
      const ready = (event, result) => {
        if (trusted(event) && result?.id === id)
          finish(result.ok ? null : new Error('工程保存失败，已保留当前窗口。'));
      };
      const timeout = setTimeout(() => finish(new Error('界面未完成重启前保存，已保留当前窗口。')), 3000);
      ipcMain.on('development:restart-ready', ready);
      window.webContents.send('development:before-restart', id);
    });
  };
  const stopDevelopment = (restart = false) => {
    if (stopTask) return;
    stopTask = (async () => {
      if (restart) await checkpointRenderer();
      stoppingDevelopment = true;
      codex.cancelAll();
      await recoveryQueue.catch(() => {});
      app.quit();
    })().catch(error => {
      stopTask = null;
      stoppingDevelopment = false;
      process.send?.({ type: 'gifhop:dev-stop-failed', error: safeMessage(error.message) });
    });
  };
  process.on('message', message => {
    if (message?.type === 'gifhop:dev-stop') stopDevelopment(message.restart === true);
  });
  process.once('disconnect', () => stopDevelopment());
}
function trusted(event) {
  try {
    if (!window || window.isDestroyed() || event.sender.isDestroyed()) return false;
    const url = event.senderFrame?.url;
    return event.sender === window.webContents && event.senderFrame === event.sender.mainFrame
      && (devURL ? url === `${devURL}/` : url === 'fox24://app/');
  } catch { return false; }
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) return { ok: false, error: '来源无效。' };
    try { return { ok: true, value: await fn(...args) }; }
    catch (error) { return { ok: false, error: safeMessage(error.message) }; }
  });
}
function setupIpc() {
  handle('codex:status', async () => {
    const status = await codex.status();
    try {
      await atomicWrite(dataPath('last-connection.json'), JSON.stringify({
        ready: status.ready, command: status.command || '', version: status.version || '',
        compatible: status.compatible ?? null, loggedIn: status.loggedIn ?? null,
        model: status.automaticModel || '', message: status.message || '', at: new Date().toISOString(),
      }));
    } catch { /* Connection diagnostics must not block a usable CLI. */ }
    return status;
  });
  handle('codex:reference', input => codex.run('reference', input));
  // Only the prepared square crosses the AI boundary; the editable source stays in the renderer.
  handle('codex:generate', input => codex.run('generate', { id: input?.id, prompt: input?.prompt, referenceImage: input?.referenceImage }));
  handle('codex:ask', input => codex.run('ask', input));
  handle('codex:title', input => input?.target === 'reference'
    ? codex.run('image-title', { id: input.id, referenceImage: input.referenceImage, prompt: '' })
    : codex.run('title', { id: input?.id, referenceImage: input?.referenceImage, prompt: input?.prompt || '' }));
  handle('codex:cancel', id => { if (typeof id === 'string') codex.cancel(id); });
  handle('file:save', async input => {
    if (!input || !validExportFilename(input.name)) throw new Error('导出文件名无效。');
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > MAX_FILE || !input.bytes.byteLength) throw new Error('导出文件无效或过大。');
    const ext = input.name.split('.').at(-1);
    const result = await dialog.showSaveDialog(window, { defaultPath: path.join(app.getPath('downloads'), input.name), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (result.canceled || !result.filePath) return false;
    await atomicWrite(result.filePath, input.bytes);
    return true;
  });
  handle('recovery:read', async () => {
    try {
      if ((await fs.stat(dataPath('recovery.json'))).size > MAX_FILE) throw new Error('恢复文件过大。');
      return await assets.hydrateProject(validateProject(JSON.parse(await fs.readFile(dataPath('recovery.json'), 'utf8'))));
    } catch (error) {
      if (error.code === 'ENOENT') {
        try { await fs.access(dataPath('recovery.json')); } catch { return null; }
      }
      try { await fs.rename(dataPath('recovery.json'), dataPath(`recovery-unreadable-${Date.now()}-${randomUUID()}.json`)); }
      catch { recoveryProtected = true; }
      throw new Error(recoveryProtected ? '恢复文件无法读取，已暂停自动覆盖。请检查本地文件权限。' : '恢复文件无法读取，原文件已备份保留。');
    }
  });
  handle('recovery:write', input => {
    const project = validateProject(input);
    recoveryQueue = recoveryQueue.catch(() => {}).then(async () => {
      if (recoveryProtected) throw new Error('恢复文件尚未备份，已暂停自动覆盖。请检查本地文件权限。');
      const compact = await assets.captureProject(project);
      await atomicWrite(dataPath('recovery.json'), JSON.stringify(compact));
      await assets.prune(compact);
      return { referenceAsset: compact.referenceAsset };
    });
    return recoveryQueue;
  });
}
async function createWindow() {
  window = new BrowserWindow({ width: 1280, height: 900, minWidth: 560, minHeight: 460, show: false,
    backgroundColor: '#222226', title: 'GifHop', icon: windowIcon,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 18, y: 20 } }
      : { autoHideMenuBar: true, titleBarOverlay: { color: '#222226', symbolColor: '#f1f1f3', height: 52 } }),
    webPreferences: { preload: path.join(root, 'desktop/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false,
      additionalArguments: autoRestoreRecovery ? ['--gifhop-dev-auto-restore'] : [], },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => {
    // Permit reloading this exact app page (including Vite's full reload).
    // Other destinations still cannot navigate the privileged renderer.
    if (event.url !== (devURL ? `${devURL}/` : 'fox24://app/')) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { codex.cancelAll(); if (!smoke) dialog.showErrorBox('GifHop', '界面意外关闭，请重新启动。最近的工程会自动恢复。'); });
  window.on('close', event => {
    if (codex.jobs.size && !smoke && !stoppingDevelopment && dialog.showMessageBoxSync(window, { type: 'question', buttons: ['继续等待', '取消任务并退出'], defaultId: 0, cancelId: 0, message: '还有正在运行的 Codex 任务。' }) === 0) event.preventDefault();
    else codex.cancelAll();
  });
  if (!smoke) window.once('ready-to-show', () => window.show());
  await window.loadURL(devURL || 'fox24://app/');
  if (smoke) {
    const evidence = await window.webContents.executeJavaScript(`(async () => {
      let statusError = null, status = null;
      try { status = await window.fox24.status(); } catch (error) { statusError = error.message; }
      return {title:document.title, bridge:typeof window.fox24?.generate, node:typeof window.require, body:document.body.innerText, url:location.href, statusError, codexReady:status?.ready || false};
    })()`);
    console.log(JSON.stringify({ smoke: evidence, sandbox: window.webContents.getLastWebPreferences().sandbox }));
    app.exit(evidence.title === 'GifHop' && evidence.bridge === 'function' && evidence.node === 'undefined' && !evidence.statusError ? 0 : 1);
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (!smoke && window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && !smoke) app.dock?.setIcon(path.join(iconRoot, 'macos/icon-1024.png'));
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    assets = new AssetStore(dataPath('draft-assets'));
    try { codex.command = JSON.parse(await fs.readFile(dataPath('settings.json'), 'utf8')).codexPath || ''; } catch { /* defaults */ }
    protocol.handle('fox24', async request => {
      const file = assetPath(path.join(root, 'dist'), request.url);
      if (!file || request.method !== 'GET') return new Response('Not found', { status: 404 });
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
      try { return new Response(await fs.readFile(file), { headers: { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' } }); }
      catch { return new Response('Not found', { status: 404 }); }
    });
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', event => event.preventDefault());
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url;
      const allowed = url.startsWith('fox24://app/') || url.startsWith('data:') || url.startsWith('blob:fox24://app/')
        || (devURL && (url.startsWith(devURL + '/') || url.startsWith(devSocketURL + '/')));
      callback({ cancel: !allowed });
    });
    ses.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders,
      'Content-Security-Policy': [devURL ? `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' fox24: data: blob:; connect-src 'self' ${devSocketURL}; object-src 'none'; frame-src 'none'` : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' fox24: data: blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"],
      'X-Content-Type-Options': ['nosniff'],
    } }));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: 'GifHop', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] }] : []),
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }, { role: 'close' }] },
    ]));
    setupIpc();
    await createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(() => app.exit(1)); });
  }).catch(error => { console.error(safeMessage(error.message)); app.exit(1); });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || smoke) app.quit(); });

// Finish the queued recovery write before an ordinary application quit as well.
let quitFlushed = false;
let quitFlushTask;
app.on('before-quit', event => {
  if (quitFlushed) return;
  event.preventDefault();
  if (quitFlushTask) return;
  codex.cancelAll();
  quitFlushTask = recoveryQueue.catch(() => {}).then(() => {
    quitFlushed = true; app.quit();
  }).catch(error => {
    console.error(safeMessage(error.message)); quitFlushed = true; app.quit();
  });
});

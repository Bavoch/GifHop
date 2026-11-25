import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import electron from 'electron';
import { developmentPort } from '../desktop/development.mjs';

const root = await realpath(new URL('..', import.meta.url));
const port = developmentPort();
const devURL = `http://127.0.0.1:${port}`;
const smoke = process.argv.includes('--smoke-test');
const sharedRuntimeFiles = ['animation-prompt.mjs', 'animation-title.mjs', 'reference-crop.mjs'];
let child, stopping, restartTimer;
let closing = false;
let restarting = false;
let restartPending = false;
let restartReason = '';

// Own the HTTP lifecycle so Vite cannot exit before Electron finishes saving.
const httpServer = createHttpServer();
const server = await createServer({
  root,
  server: { host: '127.0.0.1', port, middlewareMode: true, hmr: { server: httpServer } },
  plugins: [{
    name: 'gifhop-desktop-watch',
    configureServer(devServer) {
      devServer.watcher.add([path.join(root, 'desktop'), ...sharedRuntimeFiles.map(file => path.join(root, file))]);
      devServer.watcher.on('all', onFileChange);
    },
  }],
});
httpServer.on('request', (request, response) => server.middlewares(request, response));
try {
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', resolve);
  });
} catch (error) {
  await server.close();
  throw error;
}

function launchElectron(restoreRecovery = true) {
  const instance = spawn(electron, [root, ...(smoke ? ['--smoke-test'] : [])], {
    cwd: root,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, FOX24_DEV_URL: devURL, GIFHOP_DEV_AUTO_RESTORE: restoreRecovery ? '1' : '0' },
  });
  child = instance;
  instance.once('error', error => {
    console.error('[dev] Electron 启动失败：', error.message);
    if (child === instance) child = null;
    void shutdown(1);
  });
  instance.once('exit', (code, signal) => {
    if (child === instance) child = null;
    if (!restarting && !closing) {
      if (code === 0) void shutdown();
      else console.error(`[dev] Electron 已退出（${signal || code}），等待桌面代码修改后重新启动。`);
    }
  });
  console.log(`[dev] ${devURL}; Electron PID ${instance.pid}; UI 热更新与桌面代码自动重启已启用。`);
}

function stopElectron(forRestart = false) {
  if (stopping) return stopping;
  const instance = child;
  if (!instance || instance.exitCode !== null || instance.signalCode !== null) return Promise.resolve();
  stopping = new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timeout);
      instance.off('exit', exited);
      instance.off('message', failed);
      if (error) reject(error); else resolve();
    };
    const exited = () => finish();
    const failed = message => {
      if (message?.type === 'gifhop:dev-stop-failed') finish(new Error(message.error));
    };
    const timeout = setTimeout(() => instance.kill('SIGKILL'), 8000);
    instance.once('exit', exited);
    instance.on('message', failed);
    // Let the main process cancel CLI jobs and finish queued recovery writes first.
    if (instance.connected) {
      instance.send({ type: 'gifhop:dev-stop', restart: forRestart }, error => { if (error) instance.kill(); });
    } else instance.kill();
  }).finally(() => { stopping = null; });
  return stopping;
}

async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  clearTimeout(restartTimer);
  server.watcher.off('all', onFileChange);
  await stopElectron();
  await Promise.all([
    server.close(),
    new Promise(resolve => httpServer.close(resolve)),
  ]);
  process.exitCode = code;
}

async function restartElectron() {
  if (closing || restarting) return;
  restarting = true;
  restartPending = false;
  console.log(`[dev] ${restartReason} 已修改，正在重启 Electron…`);
  try {
    await stopElectron(true);
    if (!closing) launchElectron(true);
  } catch (error) {
    console.error('[dev] 自动重启未完成：', error.message);
  } finally {
    restarting = false;
    if (restartPending && !closing) queueRestart();
  }
}

function queueRestart() {
  restartPending = true;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => void restartElectron(), 250);
}

function onFileChange(event, file) {
  if (closing || !['add', 'change', 'unlink'].includes(event)) return;
  const relative = path.relative(root, path.resolve(root, file));
  const desktopCode = relative.startsWith(`desktop${path.sep}`) && /\.(?:[cm]?[jt]s|json)$/.test(relative);
  if (!desktopCode && !sharedRuntimeFiles.includes(relative)) return;
  restartReason = relative;
  queueRestart();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
// 冷启动即自动恢复上次工程（不弹确认）；外部设置 GIFHOP_DEV_AUTO_RESTORE=0 可关闭。
launchElectron(process.env.GIFHOP_DEV_AUTO_RESTORE !== '0');

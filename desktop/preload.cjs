const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('fox24', Object.freeze({
  platform: process.platform,
  autoRestoreRecovery: process.argv.includes('--gifhop-dev-auto-restore'),
  status: () => invoke('codex:status'),
  generate: input => invoke('codex:generate', input),
  generateReference: input => invoke('codex:reference', input),
  ask: input => invoke('codex:ask', input),
  title: input => invoke('codex:title', input),
  cancel: id => invoke('codex:cancel', id),
  saveFile: input => invoke('file:save', input),
  readRecovery: () => invoke('recovery:read'),
  writeRecovery: input => invoke('recovery:write', input),
  onBeforeDevRestart: callback => {
    const listener = (_event, id) => {
      Promise.resolve().then(callback).then(
        () => ipcRenderer.send('development:restart-ready', { id, ok: true }),
        () => ipcRenderer.send('development:restart-ready', { id, ok: false }),
      );
    };
    ipcRenderer.on('development:before-restart', listener);
    return () => ipcRenderer.removeListener('development:before-restart', listener);
  },
  onProgress: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('codex:progress', listener);
    return () => ipcRenderer.removeListener('codex:progress', listener);
  },
}));

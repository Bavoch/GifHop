import { readBrowserRecovery, writeBrowserRecovery } from './browser-recovery';
const unavailable = async () => { throw new Error('请使用 GifHop 桌面应用连接本机 Codex。网页预览仅提供本地动画工具。'); };
export const desktop = {
  autoRestoreRecovery: false, onBeforeDevRestart: () => () => {},
  status: async () => ({ ready: false, mode: 'browser-preview', message: '当前是网页预览，请使用运行后弹出的 GifHop 桌面窗口连接本机 Codex。' }),
  generate: unavailable, generateReference: unavailable, ask: unavailable, title: unavailable,
  cancel: async () => {}, onProgress: () => () => {},
  readRecovery: readBrowserRecovery, writeRecovery: writeBrowserRecovery,
  saveFile: async ({ name, bytes }) => {
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  },
  ...window.fox24,
};

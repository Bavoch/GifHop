export function developmentPort(args = process.argv.slice(2), env = process.env) {
  let value = env.PORT || '5173';
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--port') value = args[++index];
    else if (args[index].startsWith('--port=')) value = args[index].slice(7);
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value) || +value < 1 || +value > 65535)
    throw new Error('开发端口无效，请使用 1–65535 的 PORT 或 --port。');
  return +value;
}

export function developmentOrigin(value, { packaged = false } = {}) {
  if (packaged || !value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch { return ''; }
}

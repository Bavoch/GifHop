// Browser-preview persistence only. Desktop builds use the filesystem-backed bridge instead.
let database;
const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const complete = transaction => new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('本地草稿保存失败。')); });

function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const open = indexedDB.open('gifhop-draft', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('draft', { keyPath: 'id' });
    open.onsuccess = () => { open.result.onversionchange = () => open.result.close(); resolve(open.result); };
    open.onerror = () => reject(open.error);
  });
  return database;
}

// The old material library is gone; drop its database instead of leaving version records behind.
try { indexedDB.deleteDatabase('gifhop-materials'); } catch { /* Browsers without the legacy database ignore this. */ }

export async function readBrowserRecovery() {
  const saved = await request((await db()).transaction('draft').objectStore('draft').get('current'));
  return saved?.project || null;
}

export async function writeBrowserRecovery(project) {
  const transaction = (await db()).transaction('draft', 'readwrite');
  const done = complete(transaction);
  transaction.objectStore('draft').put({ id: 'current', project });
  await done;
  return {};
}

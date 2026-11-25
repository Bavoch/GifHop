import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { imageData, materialAsset, MAX_FILE } from './validation.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const mime = key => key.endsWith('.jpg') ? 'image/jpeg' : `image/${key.split('.').at(-1)}`;
const assetFile = /^[a-f0-9]{64}\.(png|jpg|webp)$/;

async function syncDirectory(directory) {
  let handle;
  try { handle = await fs.open(directory, 'r'); await handle.sync(); }
  catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}

export async function atomicWrite(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await handle?.close(); await fs.rm(temporary, { force: true }); }
}

// Content-addressed cache for the current draft; it keeps recovery.json compact and prunes anything no longer referenced.
export class AssetStore {
  constructor(directory, { write = atomicWrite } = {}) {
    this.directory = directory;
    this.write = write;
    this.ready = fs.mkdir(directory, { recursive: true });
  }
  async put(dataUrl, maximum) {
    await this.ready;
    const image = imageData(dataUrl, maximum);
    const key = `${digest(image.bytes)}.${image.extension}`;
    const file = path.join(this.directory, key);
    try { await this.get(key); }
    catch (error) {
      if (error.code && error.code !== 'ENOENT') throw error;
      await this.write(file, image.bytes);
    }
    return key;
  }
  async get(key) {
    await this.ready;
    materialAsset(key);
    const file = path.join(this.directory, key);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('素材文件无法读取。');
    const bytes = await fs.readFile(file);
    if (digest(bytes) !== key.split('.')[0]) throw new Error('素材文件校验失败。');
    return { bytes, type: mime(key), dataUrl: `data:${mime(key)};base64,${bytes.toString('base64')}` };
  }
  async captureProject(project) {
    const slot = project.slots[0] || {};
    const [referenceAsset, sheetAsset] = await Promise.all([
      project.referenceImage ? this.put(project.referenceImage, 8 * 1024 * 1024) : project.referenceAsset || null,
      slot.sheet ? this.put(slot.sheet) : slot.sheetAsset || null,
    ]);
    return { format: 'fox24', version: 2, prompt: project.prompt, referenceImage: null,
      referenceAsset, referenceCrop: project.referenceCrop, referenceTitle: project.referenceTitle,
      slots: [{ sheet: null, sheetAsset, offsets: slot.offsets || [], title: slot.title || '', prompt: slot.prompt || '' }] };
  }
  async hydrateProject(project) {
    const slot = project.slots[0] || {};
    const [reference, sheet] = await Promise.all([
      project.referenceAsset ? this.get(project.referenceAsset) : null,
      slot.sheetAsset ? this.get(slot.sheetAsset) : null,
    ]);
    return { ...project, referenceImage: project.referenceImage || reference?.dataUrl || null,
      slots: [{ ...slot, sheet: slot.sheet || sheet?.dataUrl || null }] };
  }
  async prune(compact) {
    await this.ready;
    const keep = new Set([compact.referenceAsset, ...compact.slots.map(slot => slot.sheetAsset)].filter(Boolean));
    for (const file of await fs.readdir(this.directory)) {
      if (keep.has(file) || !assetFile.test(file)) continue;
      await fs.rm(path.join(this.directory, file), { force: true }).catch(() => {});
    }
  }
}

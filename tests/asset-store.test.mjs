import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssetStore, atomicWrite } from '../desktop/asset-store.mjs';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
const other = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 224, 7, 9]).toString('base64')}`;
const temp = async () => fs.mkdtemp(path.join(os.tmpdir(), 'gifhop-assets-test-'));

test('draft checkpoints keep assets out of the recovery file and restore the current result', async () => {
  const root = await temp();
  try {
    const store = new AssetStore(root);
    const project = { format: 'fox24', version: 2, prompt: '狐狸挥手', referenceImage: image,
      referenceCrop: { x: 0.2, y: 0.8 }, slots: [{ sheet: image, offsets: [{ dx: 8, dy: -5 }], title: '狐狸挥手', prompt: '旧提示词' }] };
    const compact = await store.captureProject(project);
    assert.ok(!JSON.stringify(compact).includes('data:image'), 'recovery stays compact');
    const restored = await new AssetStore(root).hydrateProject(compact);
    assert.equal(restored.slots[0].sheet, image);
    assert.deepEqual(restored.slots[0].offsets, [{ dx: 8, dy: -5 }]);
    assert.equal(restored.slots[0].title, '狐狸挥手');
    assert.equal(restored.referenceImage, image);
    assert.deepEqual(restored.referenceCrop, { x: 0.2, y: 0.8 });
    assert.equal((await fs.readdir(root)).length, 1, "identical sheet and reference share one asset");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an empty result removes its sheet asset on the next checkpoint', async () => {
  const root = await temp();
  try {
    const store = new AssetStore(root);
    const filled = await store.captureProject({ format: 'fox24', version: 2, prompt: '',
      referenceImage: other, slots: [{ sheet: image, offsets: [] }] });
    await store.prune(filled);
    assert.equal((await fs.readdir(root)).length, 2);
    const cleared = await store.captureProject({ format: 'fox24', version: 2, prompt: '',
      referenceImage: null, slots: [{ sheet: null, offsets: [] }] });
    await store.prune(cleared);
    assert.equal(cleared.referenceAsset, null);
    assert.equal(cleared.slots[0].sheetAsset, null);
    assert.equal((await fs.readdir(root)).length, 0, 'nothing keeps the deleted result on disk');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('corrupted assets are rewritten and invalid keys are rejected', async () => {
  const root = await temp();
  try {
    const store = new AssetStore(root);
    const key = await store.put(image);
    assert.equal((await store.get(key)).dataUrl, image);
    await fs.writeFile(path.join(root, key), 'corrupted');
    await assert.rejects(store.get(key), /校验失败/);
    assert.equal(await store.put(image), key);
    assert.equal((await store.get(key)).dataUrl, image);
    await assert.rejects(store.get('../outside.png'), /无效/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('atomic writes replace the file only after the new bytes are durable', async () => {
  const root = await temp();
  try {
    const file = path.join(root, 'recovery.json');
    await atomicWrite(file, '{"a":1}');
    await atomicWrite(file, '{"a":2}');
    assert.equal(await fs.readFile(file, 'utf8'), '{"a":2}');
    assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith('.tmp')), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

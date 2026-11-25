import { test } from 'node:test';
import assert from 'node:assert/strict';
import { animationFilename, normalizeAnimationTitle, parseAnimationTitle, normalizeReferenceTitle } from '../animation-title.mjs';
import { validExportFilename } from '../desktop/validation.mjs';

test('AI titles stay within twelve Unicode characters and produce portable Chinese filenames', () => {
  const title = normalizeAnimationTitle(' “小猫开心地伸个大懒腰然后挥手” ');
  assert.ok(Array.from(title).length <= 12);
  assert.equal(parseAnimationTitle('{"title":"小猫伸懒腰"}'), '小猫伸懒腰');
  assert.equal(parseAnimationTitle('```json\n{"title":"狐狸挥手"}\n```'), '狐狸挥手');
  for (const reply of ['完成了', '{}', '{"title":null}', '{"title":"///"}']) assert.equal(parseAnimationTitle(reply), '');
  assert.equal(normalizeAnimationTitle('../小猫/挥手:*?'), '小猫挥手');
  assert.equal(normalizeAnimationTitle('CON'), '');
  assert.deepEqual(normalizeReferenceTitle({ imageHash: 'a'.repeat(64), title: '橘猫举旗' }), { imageHash: 'a'.repeat(64), title: '橘猫举旗' });
  assert.equal(normalizeReferenceTitle({ imageHash: 'bad-key', title: '橘猫举旗' }), null);
  assert.equal(normalizeReferenceTitle({ imageHash: 'a'.repeat(64), title: '///' }), null);
  assert.equal(animationFilename('小猫伸懒腰', 512, 'gif'), '小猫伸懒腰-512px.gif');
  assert.throws(() => animationFilename('', 360, 'gif'), /标题/);
  for (const name of ['小猫伸懒腰-360px.gif', '狐狸挥手-原图.png', 'gifhop-version-1.png']) assert.ok(validExportFilename(name));
  for (const name of ['../小猫.gif', 'a\\b.gif', '.gif', 'CON.gif', '小猫.exe', 'a\0.gif', 'a\u202e.gif', '/tmp/a.gif']) assert.equal(validExportFilename(name), false);
});

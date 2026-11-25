import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { imageData, validateJob, validateProject, assetPath } from '../desktop/validation.mjs';
import { compileAnimationPrompt, DEFAULT_ANIMATION_INTENT } from '../animation-prompt.mjs';

export const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
test('untrusted inputs cannot set commands, paths or malformed images', () => {
  assert.equal(imageData(PNG).type, 'png');
  for (const input of [null, {}, { id: '../x', prompt: 'hi' }, { id: 'safe', prompt: '' }, { id: 'safe', prompt: 'hi', model: '--dangerously-bypass-approvals-and-sandbox x' }, { id: 'safe', prompt: 'hi', referenceImage: 'file:///etc/passwd' }]) assert.throws(() => validateJob(input));
  assert.throws(() => imageData(PNG.replace('image/png', 'image/jpeg')));
  assert.throws(() => imageData('data:image/png;base64,YWJj'));
  assert.throws(() => imageData(PNG, 2));
  assert.throws(() => validateProject({ format: 'fox24', version: 1, slots: [{ sheet: 'https://evil.test/image.png' }] }));
  assert.throws(() => validateProject({ format: 'fox24', version: 1, slots: [{ offsets: [{ dx: Infinity, dy: 0 }] }] }));
});
test('custom protocol refuses traversal, credentials and external origins', () => {
  const root = path.resolve('dist');
  assert.equal(assetPath(root, 'fox24://app/'), path.join(root, 'index.html'));
  for (const url of ['https://app/index.html', 'fox24://evil/index.html', 'fox24://u@app/index.html', 'fox24://app/%2e%2e%2fsecret', 'fox24://app/%5csecret', 'fox24://app/%00', 'fox24://app/%zz']) assert.equal(assetPath(root, url), null);
});
test('project preserves frame edits and animation prompt preserves 24 frame contract', () => {
  const project = { format: 'fox24', version: 1, prompt: '狐狸跳舞', referenceImage: PNG, slots: [{ sheet: PNG, offsets: [{ dx: 2, dy: -3 }] }] };
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))), project);
  const a = compileAnimationPrompt('狐狸跳舞', { seed: 1 });
  const b = compileAnimationPrompt('狐狸跳舞', { seed: 2 });
  assert.notEqual(a.prompt, b.prompt); assert.deepEqual(a.spec, b.spec);
  assert.equal(a.spec.frameCount, 24); assert.equal(a.spec.columns, 6); assert.equal(a.spec.rows, 4);
});

test('reference animation preserves appearance and framing without inheriting text-only creative expansion', () => {
  const intent = '固定镜头，轻轻撅嘴吹气，双眼上飘，保持神情与原有发型';
  const reference = compileAnimationPrompt(intent, { seed: 7, hasReference: true });
  const text = compileAnimationPrompt(intent, { seed: 7 });
  assert.equal(reference.spec.sourceMode, 'reference-animation');
  assert.equal(reference.spec.frameCount, 24);
  assert.equal(reference.spec.columns * reference.spec.rows, 24);
  assert.ok(reference.prompt.includes(intent));
  assert.match(reference.prompt, /附件原图本身传给生图工具/);
  assert.match(reference.prompt, /脸型、五官比例与间距/);
  assert.match(reference.prompt, /沿用其机位、视角/);
  assert.match(reference.prompt, /用户明确要求轻微、克制、静止或限定某部位时，严格服从/);
  assert.match(reference.prompt, /固定的是镜头，不是主体姿势/);
  assert.match(reference.prompt, /裁为正方形/);
  assert.match(reference.prompt, /不能还原画幅外被裁去的内容/);
  assert.doesNotMatch(reference.prompt, /原图整体等比缩放|必要时仅延展原有背景/);
  assert.match(reference.prompt, /默认做明显、有力度的主动作/);
  assert.doesNotMatch(reference.prompt, /只能做小幅渐进变化|允许轻微、克制的动作/);
  assert.match(reference.prompt, /用户明确要求改变的部位/);
  assert.doesNotMatch(reference.prompt, /镜头可根据剧情需要|成片必须有强烈的视觉冲击|至少包含三段/);
  assert.equal(text.spec.sourceMode, 'text-animation');
  assert.match(text.prompt, /至少包含三段/);
});

test('blank reference generation is autonomous and does not inherit explicit-edit restrictions', () => {
  const automatic=compileAnimationPrompt('',{seed:8,hasReference:true});
  assert.equal(automatic.spec.sourceMode,'reference-creative');
  assert.equal(automatic.spec.subjectAndIntent,DEFAULT_ANIMATION_INTENT);
  assert.equal(automatic.spec.columns*automatic.spec.rows,24);
  assert.match(automatic.prompt,/动作、节奏和视觉表现由你决定/);
  assert.doesNotMatch(automatic.prompt,/不引入新的外观设计或未指定的动作|固定镜头|脸型、五官比例与间距|严格服从其幅度/);
  assert.match(automatic.prompt,/主体不跨格、不被裁切/);
  assert.match(automatic.prompt,/末帧自然衔接首帧/);
  assert.match(automatic.prompt,/用户选定的输入画幅裁为正方形/);
  const imageOnly={id:'image-only',prompt:'',referenceImage:PNG};
  assert.equal(validateJob(imageOnly,{allowImageOnly:true}).prompt,'');
  assert.throws(()=>validateJob(imageOnly),/提示词/,'polishing still requires text');
  assert.throws(()=>validateJob({id:'empty',prompt:''},{allowImageOnly:true}),/提示词/);
});

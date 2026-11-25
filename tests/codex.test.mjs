import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CodexService, runProcess, safeMessage, resolveCodex, readModels } from '../desktop/codex.mjs';
class FixtureService extends CodexService {
  constructor(options) { super({ imageWaitMs: 0, readModels: async () => [{ id: 'gpt-6-luna', isDefault: true }], ...options }); }
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64');
test('reference download naming inspects a single static image without sprite-sheet or prompt assumptions', async () => {
  const service = new FixtureService({ resolve: async () => '/codex', execute: async (_command, args, options) => {
    assert.ok(args.includes('features.image_generation=false'));
    assert.ok(args.includes('model_reasoning_effort="none"'));
    assert.deepEqual(await fs.readFile(args[args.indexOf('--image') + 1]), png);
    const file = JSON.parse(args.find(value => value.startsWith('model_instructions_file=')).split('=').slice(1).join('='));
    const instructions = await fs.readFile(file, 'utf8');
    assert.match(instructions, /single attached static image/);
    assert.match(options.input, /最多 12 个字/);
    assert.doesNotMatch(instructions + options.input, /6-column|24 帧|无关的当前提示词/);
    options.onEvent({ type: 'item.completed', item: { type: 'agent_message', text: '{"title":"橘猫举旗"}' } });
    options.onEvent({ type: 'turn.completed' });
  } });
  const result = await service.run('image-title', { id: 'reference-image-title', prompt: '无关的当前提示词', referenceImage: `data:image/png;base64,${png.toString('base64')}` });
  assert.equal(result.title, '橘猫举旗');
  await assert.rejects(service.run('image-title', { id: 'missing-static-image', prompt: 'test' }), /参考图片/);
});
test('text-only reference stage creates one static square using the economy image route', async () => {
  const progress = [], diagnostics = [];
  let calls = 0;
  const service = new FixtureService({ resolve: async () => '/codex', onProgress: event => progress.push(event),
    onDiagnostic: event => diagnostics.push(event), execute: async (_command, args, options) => {
      calls++;
      assert.ok(args.includes('features.image_generation=true'));
      assert.ok(args.includes('model_reasoning_effort="low"'));
      assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-luna');
      assert.ok(!args.includes('--image'));
      assert.match(options.input, /只有一个完整的起始画面/);
      assert.match(options.input, /画幅比例严格 1:1/);
      assert.doesNotMatch(options.input, /24 个等大的方形格子|1536×1024/);
      const file = JSON.parse(args.find(value => value.startsWith('model_instructions_file=')).split('=').slice(1).join('='));
      assert.match(await fs.readFile(file, 'utf8'), /不要生成精灵图、多帧/);
      options.onEvent({ type: 'item.completed', item: { type: 'image_generation', result: png.toString('base64') } });
      options.onEvent({ type: 'turn.completed' });
    } });
  const result = await service.run('reference', { id: 'text-reference', prompt: '橘猫举着小旗挥手' });
  assert.equal(result.image, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(calls, 1);
  assert.ok(progress.every(event => event.stage === 'creating-reference'));
  assert.equal(diagnostics[0].promptPolicy, 'reference-still-v1');
  await assert.rejects(service.run('reference', { id: 'empty-reference', prompt: '' }), /提示词/);
  await assert.rejects(service.run('reference', { id: 'reference-with-image', prompt: 'test', referenceImage: result.image }), /只接受文字/);
});
test('generation returns a short title from the same request; legacy naming reads the actual sheet without generating images', async () => {
  let calls = 0;
  const service = new FixtureService({ resolve: async () => '/codex', execute: async (_command, args, options) => {
    calls++;
    const instructions = JSON.parse(args.find(value => value.startsWith('model_instructions_file=')).split('=').slice(1).join('='));
    const guide = await fs.readFile(instructions, 'utf8');
    assert.match(guide, /最多 12 个字/);
    if (args.includes('features.image_generation=true')) {
      assert.match(guide, /never draw the title or JSON/);
      options.onEvent({ type: 'item.completed', item: { type: 'image_generation', result: png.toString('base64') } });
    } else {
      assert.deepEqual(await fs.readFile(args[args.indexOf('--image') + 1]), png);
      assert.ok(args.includes('features.image_generation=false'));
      assert.ok(args.includes('model_reasoning_effort="none"'));
      assert.match(options.input, /画面为准/);
    }
    options.onEvent({ type: 'item.completed', item: { type: 'agent_message', text: '{"title":"小狐狸开心挥手"}' } });
    options.onEvent({ type: 'turn.completed' });
  } });
  const generated = await service.run('generate', { id: 'title-generated', prompt: '狐狸挥手' });
  assert.equal(generated.title, '小狐狸开心挥手');
  assert.equal(calls, 1);
  const named = await service.run('title', { id: 'title-legacy', prompt: '', referenceImage: `data:image/png;base64,${png.toString('base64')}` });
  assert.equal(named.title, generated.title);
  assert.equal(calls, 2);
  await assert.rejects(service.run('title', { id: 'no-sheet', prompt: '不能只按提示词命名' }), /帧图/);
});
test('automatic economy routing ignores saved expensive choices for every task and records the actual model', async () => {
  const runs = [];
  const service = new FixtureService({ resolve: async () => '/codex',
    readModels: async () => [{ id: 'gpt-6-astra', isDefault: true }, { id: 'gpt-5.6-luna' }, { id: 'gpt-6-luna' }],
    execute: async (_command, args, options) => {
      if (args[0] === '--version') return 'codex-cli 0.164.0';
      if (args[0] === 'login') return 'Logged in using ChatGPT';
      runs.push(args);
      options.onEvent({ type: 'item.completed', item: args.includes('features.image_generation=true')
        ? { type: 'image_generation', result: png.toString('base64') }
        : { type: 'agent_message', text: '润色后的动作描述' } });
      options.onEvent({ type: 'turn.completed' });
    },
  });
  const status = await service.status();
  assert.equal(status.automaticModel, 'gpt-6-luna');
  for (const [index, kind] of ['ask', 'generate'].entries()) {
    const result = await service.run(kind, { id: `economy-${index}`, model: 'gpt-6-astra', prompt: '创意动作' });
    assert.equal(result.model, 'gpt-6-luna');
    assert.equal(runs[index][runs[index].indexOf('--model') + 1], 'gpt-6-luna');
    assert.ok(runs[index].includes(`model_reasoning_effort="${kind === 'generate' ? 'low' : 'none'}"`));
    assert.ok(!runs[index].some(value => value.startsWith('service_tier=')), 'no paid priority tier');
    assert.ok(runs[index].some(value => value.startsWith('model_instructions_file=')));
  }
});

test('process handles chunked JSON, EPIPE, nonzero exits, timeout and cancellation', async () => {
  const events = [];
  await runProcess(process.execPath, ['-e', 'process.stdout.write("{\\"ok\\":");setTimeout(()=>process.stdout.write("true}\\n"),10)'], { onEvent: event => events.push(event) });
  assert.deepEqual(events, [{ ok: true }]);
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(7)'], { input: 'x'.repeat(1000000) }), /7/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},100)'], { timeout: 50 }), /超时/);
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},100)'], { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /取消/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("x".repeat(1000))'], { cap: 100 }), /超过/);
});

test('isolated concurrent generations consume only their own validated images', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fox24-unit-'));
  const workspaces = [];
  const service = new FixtureService({ codexHome: home, resolve: async () => 'codex', execute: async (_command, args, options) => {
    assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('read-only')); assert.ok(args.includes('features.shell_tool=false'));
    assert.equal(args.at(-1), '-');
    workspaces.push(options.cwd);
    const thread = randomUUID(); const directory = path.join(home, 'generated_images', thread);
    await fs.mkdir(directory, { recursive: true });
    options.onEvent({ type: 'thread.started', thread_id: thread });
    await fs.writeFile(path.join(directory, 'result.png'), png);
    options.onEvent({ type: 'turn.completed' });
  } });
  try {
    const results = await Promise.all([1, 2, 3, 4].map(id => service.run('generate', { id: `job-${id}`, prompt: '狐狸 $(touch unsafe)' })));
    assert.equal(new Set(workspaces).size, 4);
    for (const result of results) assert.equal(result.image, `data:image/png;base64,${png.toString('base64')}`);
    for (const directory of workspaces) await assert.rejects(fs.access(directory));
    assert.equal(service.jobs.size, 0);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('missing, invalid, stale, symlink images and failed turns never become success', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fox24-unit-'));
  try {
    for (const mode of ['missing', 'invalid', 'stale', ...(process.platform === 'win32' ? [] : ['symlink']), 'failed', 'incomplete']) {
      const service = new FixtureService({ codexHome: home, resolve: async () => 'codex', execute: async (_command, _args, { onEvent }) => {
        const thread = randomUUID(), directory = path.join(home, 'generated_images', thread), file = path.join(directory, 'result.png');
        await fs.mkdir(directory, { recursive: true });
        onEvent({ type: 'thread.started', thread_id: thread });
        if (mode === 'symlink') { const other = path.join(home, 'other.png'); await fs.writeFile(other, png); await fs.symlink(other, file); }
        else if (mode !== 'missing') { await fs.writeFile(file, mode === 'invalid' ? 'not an image' : png); if (mode === 'stale') await fs.utimes(file, 1, 1); }
        onEvent({ type: mode === 'failed' ? 'turn.failed' : mode === 'incomplete' ? 'noop' : 'turn.completed' });
      } });
      await assert.rejects(service.run('generate', { id: mode, prompt: 'test' }));
      assert.equal(service.jobs.size, 0);
    }
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('capacity, duplicate IDs and cancellation protect CLI lifecycle', async () => {
  const service = new FixtureService({ resolve: async () => 'codex', execute: async (_c, _a, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error('已取消'));
    else signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true });
  }) });
  const jobs = [1, 2, 3, 4].map(id => service.run('ask', { id: `job-${id}`, prompt: 'test' }));
  const all = Promise.allSettled(jobs);
  await assert.rejects(service.run('ask', { id: 'job-1', prompt: 'test' }), /重复/);
  await assert.rejects(service.run('ask', { id: 'job-5', prompt: 'test' }), /最多/);
  service.cancelAll();
  assert.ok((await all).every(result => result.status === 'rejected'));
  assert.equal(service.jobs.size, 0);
});
test('discovery reports missing/outdated CLI and refuses API-key authentication', async () => {
  for (const [version, auth, ready] of [['0.164.0', 'Logged in using ChatGPT', true], ['0.100.0', 'Logged in using ChatGPT', false], ['0.164.0', 'Logged in using an API key', false]]) {
    const service = new FixtureService({ resolve: async () => '/codex', readModels: async () => [{id:'gpt-6-luna',isDefault:true}], execute: async (_c, args) => args[0] === '--version' ? `codex-cli ${version}` : auth });
    assert.equal((await service.status()).ready, ready);
  }
  await assert.rejects(resolveCodex('/missing/codex'), /未找到/);
  assert.equal(safeMessage('secret sk-abcdef Bearer abcdef'), 'secret [redacted] [redacted]');
});


test('model catalog includes hidden entries and pages after the default, deduplicates and terminates its process', async () => {
  const fixture = `
    const readline = require('node:readline');
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    let initialized = false;
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') send({ id: request.id, result: {} });
      else if (request.method === 'initialized') initialized = true;
      else if (request.method === 'model/list' && initialized && request.params.includeHidden === true) send({ id: request.id, result: request.params.cursor
        ? { data: [{ model: 'hidden-model', hidden: true }, { model: 'other' }, { model: 'bad model' }, null], nextCursor: null }
        : { data: [{ model: 'actual-default', isDefault: true }, { model: 'other', isDefault: false }], nextCursor: 'page-two' } });
      else send({ id: request.id, error: { message: 'unexpected method' } });
    });
  `;
  let child;
  const spawnProcess = (_command, args, options) => {
    assert.deepEqual(args.slice(0, 3), ['app-server', '--listen', 'stdio://']);
    assert.equal(options.shell, false);
    child = spawn(process.execPath, ['-e', fixture], options);
    return child;
  };
  assert.deepEqual(await readModels('/codex', { spawnProcess }), [{id:'actual-default',isDefault:true},{id:'other',isDefault:false},{id:'hidden-model',isDefault:false}]);
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'metadata process is reaped before resolving');
  for (const fixture of ["setInterval(() => {}, 1000)", "process.exit(0)", "process.stdout.write(JSON.stringify({id:1,error:{message:'unsupported'}})+'\\n');setInterval(()=>{},1000)"]) {
    let child;
    await assert.rejects(readModels('/codex', { timeout: 100, spawnProcess: (_command, _args, options) => (child = spawn(process.execPath, ['-e', fixture], options)) }));
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'failure also reaps the metadata process');
  }
});

test('only documented economy models are eligible; missing catalogues and CLI changes cannot use an expensive default', async () => {
  const calls = [];
  let catalogue = [{ id: 'gpt-6-astra', isDefault: true }, { id: 'gpt-5.6-luna' }];
  let available = true;
  const service = new FixtureService({
    resolve: async command => command || '/codex',
    readModels: async () => { if (!available) throw new Error('offline'); return catalogue; },
    execute: async (_command, args, options) => {
      if (args[0] === '--version') return 'codex-cli 0.164.0';
      if (args[0] === 'login') return 'Logged in using ChatGPT';
      calls.push(args);
      options.onEvent({ type: 'item.completed', item: { type: 'agent_message', text: '动作描述' } });
      options.onEvent({ type: 'turn.completed' });
    },
  });
  assert.equal((await service.status()).automaticModel, 'gpt-5.6-luna');
  assert.equal((await service.run('ask', { id: 'fallback', prompt: '动作' })).model, 'gpt-5.6-luna');
  catalogue = [{ id: 'gpt-6-astra', isDefault: true }];
  service.command = '/different-codex';
  await assert.rejects(service.run('ask', { id: 'changed-cli', prompt: '动作' }), /低成本/);
  assert.equal(calls.length, 1, 'an expensive-only catalogue must not launch a task');
  assert.equal((await service.status()).ready, false);
  available = false;
  const status = await service.status();
  assert.equal(status.ready, false);
  assert.equal(status.automaticModel, '');
  assert.ok(status.modelListError);
  await assert.rejects(service.run('ask', { id: 'offline', prompt: '动作' }), /offline/);
  assert.equal(calls.length, 1);
});

test('late image persistence is recovered without another model request or consuming other threads', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gifhop-late-image-'));
  let write, requests = 0;
  const diagnostics = [];
  try {
    const other = path.join(home, 'generated_images', randomUUID());
    await fs.mkdir(other, { recursive: true }); await fs.writeFile(path.join(other, 'other.png'), png);
    const actual = Buffer.concat([png, Buffer.from('late-image')]);
    const service = new FixtureService({ codexHome: home, imageWaitMs: 800, resolve: async () => '/codex', onDiagnostic: event => diagnostics.push(event),
      execute: async (_command, _args, { onEvent }) => {
        requests++;
        const thread = randomUUID(), directory = path.join(home, 'generated_images', thread);
        onEvent({ type: 'thread.started', thread_id: thread });
        onEvent({ type: 'item.completed', item: { type: 'agent_message', text: '抱歉，工具没有返回图片。' } });
        onEvent({ type: 'turn.completed' });
        write = new Promise((resolve, reject) => setTimeout(async () => {
          try { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'result.png'), actual); resolve(); }
          catch (error) { reject(error); }
        }, 60));
      },
    });
    const result = await service.run('generate', { id: 'late-image', prompt: '参考动画' });
    assert.equal(result.image, `data:image/png;base64,${actual.toString('base64')}`);
    assert.equal(requests, 1, 'waiting for a saved file does not start another paid generation');
    assert.equal(diagnostics[0].outcome, 'generated');
    assert.equal(diagnostics[0].model, 'gpt-6-luna');
    assert.equal(service.jobs.size, 0);
  } finally { await write; await fs.rm(home, { recursive: true, force: true }); }
});

test('no-image responses give accurate recovery copy and metadata-only diagnostics; file waiting remains cancellable', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gifhop-no-image-'));
  const diagnostics = [];
  let calls = 0;
  try {
    const service = new FixtureService({ codexHome: home, imageWaitMs: 100, resolve: async () => '/codex', onDiagnostic: event => diagnostics.push(event),
      execute: async (_command, _args, { onEvent }) => {
        calls++; onEvent({ type: 'thread.started', thread_id: randomUUID() });
        onEvent({ type: 'item.completed', item: { type: 'agent_message', text: '抱歉，当前无法调用图像生成工具。' } });
        onEvent({ type: 'turn.completed' });
      },
    });
    await assert.rejects(service.run('generate', { id: 'empty-image', prompt: '私人创意' }), error => {
      assert.match(error.message, /本次生成未返回新图片/); assert.doesNotMatch(error.message, /升级|账户支持|私人创意/); return true;
    });
    assert.equal(calls, 1);
    assert.equal(diagnostics[0].outcome, 'no_image');
    assert.ok(!JSON.stringify(diagnostics).includes('私人创意'));
    service.imageWaitMs = 2000;
    const waiting = service.run('generate', { id: 'cancel-file-wait', prompt: 'test' });
    setTimeout(() => service.cancel('cancel-file-wait'), 40);
    await assert.rejects(waiting, /已取消/);
    assert.equal(service.jobs.size, 0);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('native reference generation passes original bytes and the preservation policy to the image workflow', async () => {
  const diagnostics = [];
  const intent = '固定镜头，轻轻撅嘴吹气，保持原有发型';
  const service = new FixtureService({ resolve: async () => '/codex', onDiagnostic: event => diagnostics.push(event),
    execute: async (_command, args, options) => {
      const referenceFile = args[args.indexOf('--image') + 1];
      assert.deepEqual(await fs.readFile(referenceFile), png);
      assert.match(options.input, /以附件原图为编辑基底/);
      assert.ok(options.input.includes(intent));
      assert.doesNotMatch(options.input, /镜头可根据剧情需要|成片必须有强烈的视觉冲击/);
      const instructions = JSON.parse(args.find(value => value.startsWith('model_instructions_file=')).split('=').slice(1).join('='));
      assert.ok(options.input.includes(`referenced_image_paths: ${JSON.stringify([referenceFile])}`));
      assert.match(options.input, /tools.image_gen__imagegen/);
      assert.ok((await fs.readFile(instructions, 'utf8')).includes(`referenced_image_paths: ${JSON.stringify([referenceFile])}`));
      assert.match(await fs.readFile(instructions, 'utf8'), /Preserve the original identity/);
      options.onEvent({ type: 'item.completed', item: { type: 'image_generation', result: png.toString('base64') } });
      options.onEvent({ type: 'turn.completed' });
    },
  });
  const result = await service.run('generate', { id: 'preserve-original', prompt: intent, referenceImage: `data:image/png;base64,${png.toString('base64')}` });
  assert.equal(result.model, 'gpt-6-luna');
  assert.equal(diagnostics[0].referenceAttached, true);
  assert.equal(diagnostics[0].promptPolicy, 'preserve-reference-motion-v3');
});

test('retired prompt suggestion tasks cannot launch a model request', async () => {
  let requests=0;
  const service=new FixtureService({execute:async()=>{requests++;}});
  await assert.rejects(service.run('suggest',{id:'removed',prompt:'test'}),/任务类型无效/);
  assert.equal(requests,0);
});

test('an empty motion prompt reaches the autonomous image workflow without restrictive edit instructions', async () => {
  const diagnostics=[];
  const service=new FixtureService({resolve:async()=>'/codex',onDiagnostic:event=>diagnostics.push(event),execute:async(_command,args,options)=>{
    const referenceFile=args[args.indexOf('--image')+1];
    assert.deepEqual(await fs.readFile(referenceFile),png);
    const instructions=JSON.parse(args.find(value=>value.startsWith('model_instructions_file=')).split('=').slice(1).join('='));
    const guide=await fs.readFile(instructions,'utf8');
    assert.match(guide,/motion prompt is empty/);
    assert.match(guide,/choose the action, rhythm and visual expression freely/);
    assert.doesNotMatch(guide,/Explicit subtle or local-motion requests|preserve the fixed camera/);
    assert.ok(options.input.includes(`referenced_image_paths: ${JSON.stringify([referenceFile])}`));
    assert.doesNotMatch(options.input,/不引入新的外观设计或未指定的动作|固定镜头/);
    options.onEvent({type:'item.completed',item:{type:'image_generation',result:png.toString('base64')}});
    options.onEvent({type:'turn.completed'});
  }});
  const result=await service.run('generate',{id:'image-only',prompt:'',referenceImage:`data:image/png;base64,${png.toString('base64')}`});
  assert.equal(result.model,'gpt-6-luna');
  assert.equal(diagnostics[0].promptPolicy,'reference-creative-v1');
});

test('implicit CLI discovery skips outdated launcher dependencies but honors an explicit executable', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gifhop-cli-discovery-'));
  try {
    const dirs=['old-host','new-user'];
    const names=process.platform==='win32'?'codex.exe':'codex';
    for(const dir of dirs){await fs.mkdir(path.join(root,dir));await fs.writeFile(path.join(root,dir,names),'fixture',{mode:0o700});}
    const old=await fs.realpath(path.join(root,dirs[0],names)),current=await fs.realpath(path.join(root,dirs[1],names));
    const calls=[];
    const options={home:root,env:{PATH:[path.dirname(old),path.dirname(old),path.dirname(current)].join(path.delimiter)},
      probe:async file=>{calls.push(file);return file===current?'codex-cli 0.164.0':'codex-cli 0.159.3';}};
    assert.equal(await resolveCodex('',options),current);
    assert.equal(calls.filter(file=>file===old).length,1,'duplicate PATH entries are probed once');
    assert.equal(await resolveCodex(old,options),old,'an explicitly configured executable is not replaced');
    assert.equal(await resolveCodex('',{...options,probe:async()=> 'codex-cli 0.159.3'}),old,'old-only installations retain an actionable upgrade result');
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

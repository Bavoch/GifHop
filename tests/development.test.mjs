import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { developmentPort, developmentOrigin } from '../desktop/development.mjs';

test('PandaGO PORT and explicit CLI ports take precedence over the local fallback', () => {
  assert.equal(developmentPort([], {}), 5173);
  assert.equal(developmentPort([], { PORT: '51269' }), 51269);
  assert.equal(developmentPort(['--port','51268'], { PORT: '51269' }), 51268);
  assert.equal(developmentPort(['--port=51268','--strictPort'], {}), 51268);
  for (const value of ['0','65536','-1','NaN','5173.5','5173; echo unsafe'])
    assert.throws(() => developmentPort([], {PORT:value}), /开发端口/);
  assert.throws(() => developmentPort(['--port'], {}), /开发端口/);
});

test('development trust is restricted to one configured loopback origin and disabled when packaged', () => {
  for (const host of ['127.0.0.1','localhost','[::1]'])
    assert.equal(developmentOrigin(`http://${host}:51269/`), `http://${host}:51269`);
  for (const value of ['https://127.0.0.1:51269','http://example.com:51269','http://localhost.example.com:51269',
    'http://0.0.0.0:51269','http://user@127.0.0.1:51269','http://127.0.0.1:51269/page',
    'http://127.0.0.1:51269/?q=1','http://127.0.0.1:51269/#frame','not-a-url'])
    assert.equal(developmentOrigin(value), '');
  assert.equal(developmentOrigin('http://127.0.0.1:51269',{packaged:true}), '');
});

const freePort = async () => {
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
};
const isListening = port => new Promise(resolve=>{
  const socket=net.connect(port,'127.0.0.1');
  socket.once('connect',()=>{socket.destroy();resolve(true);});
  socket.once('error',()=>{socket.destroy();resolve(false);});
});

test('a random-port development launch has a real preload/IPC bridge and releases its port', {timeout:60_000,skip:process.platform==='linux'&&!process.env.DISPLAY}, async () => {
  const port=await freePort();
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gifhop-dev-port-test-'));
  let child, timer, exit, output='';
  try {
    child=spawn(process.execPath,['scripts/dev.mjs','--smoke-test'],{
      cwd:new URL('..',import.meta.url),
      env:{...process.env,PORT:String(port),FOX24_TEST_DATA:directory},stdio:['ignore','pipe','pipe'],windowsHide:true,
    });
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
    exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
    timer=setTimeout(()=>child.kill('SIGTERM'),45_000);
    assert.equal(await exit,0,output);
    const evidence=output.split('\n').map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(value=>value?.smoke);
    assert.ok(evidence,output);
    assert.equal(evidence.smoke.url,`http://127.0.0.1:${port}/`);
    assert.equal(evidence.smoke.bridge,'function');
    assert.equal(evidence.smoke.statusError,null);
    assert.equal(evidence.smoke.node,'undefined');
    assert.equal(evidence.sandbox,true);
    assert.equal(await isListening(port),false,'temporary development port must be released');
    console.log(`Hidden desktop at port ${port}: bridge and IPC work; Codex ready=${evidence.smoke.codexReady}; temporary port released`);
  } finally {
    clearTimeout(timer);
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exit;}
    await fs.rm(directory,{recursive:true,force:true});
    assert.equal(await isListening(port),false,'no temporary listener remains after cleanup');
  }
});

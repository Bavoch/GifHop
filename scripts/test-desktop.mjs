import { spawn } from 'node:child_process';
import electron from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'fox24-desktop-test-'));
try {
  const executable = process.env.FOX24_TEST_EXECUTABLE || electron;
  const args = process.env.FOX24_TEST_EXECUTABLE ? ['--smoke-test'] : ['.', '--smoke-test'];
  const child = spawn(executable, args, { env: { ...process.env, FOX24_TEST_DATA: userData }, stdio: 'inherit', windowsHide: true });
  const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 45_000);
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); });
  clearTimeout(timeout);
  if (exit !== 0) throw new Error(`Hidden desktop smoke test failed (${exit})`);
} finally { await fs.rm(userData, { recursive: true, force: true }); }

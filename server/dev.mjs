import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = spawn(process.execPath, [path.join(appRoot, 'server/index.mjs')], {
  cwd: appRoot,
  stdio: 'inherit',
});
const vite = spawn(process.execPath, [path.join(appRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], {
  cwd: appRoot,
  stdio: 'inherit',
});

const stop = () => {
  api.kill('SIGTERM');
  vite.kill('SIGTERM');
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
api.on('exit', (code) => {
  if (code && !vite.killed) vite.kill('SIGTERM');
});
vite.on('exit', (code) => {
  if (code && !api.killed) api.kill('SIGTERM');
});


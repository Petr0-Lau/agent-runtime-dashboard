import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = spawn(process.execPath, [path.join(appRoot, 'server/index.mjs')], {
  cwd: appRoot,
  stdio: 'ignore',
});

try {
  let response;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      response = await fetch('http://127.0.0.1:4317/api/state');
      if (response.ok) break;
    } catch {
      // The server may still be binding its local port.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  assert(response?.ok, 'API did not become ready');
  const state = await response.json();
  assert(Array.isArray(state.projects), 'state.projects must be an array');
  assert(Array.isArray(state.availableAgents), 'state.availableAgents must be an array');
  assert(Array.isArray(state.unassignedPorts), 'state.unassignedPorts must be an array');
  assert(typeof state.generatedAt === 'string', 'state.generatedAt must be a timestamp');
  console.log(`check ok: ${state.projects.length} projects discovered`);
} finally {
  server.kill('SIGTERM');
}

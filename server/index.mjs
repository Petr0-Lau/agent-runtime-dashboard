import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import si from 'systeminformation';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(appRoot, 'config/settings.json');
const stateDir = path.join(os.homedir(), '.agent-runtime-dashboard');
const statePath = path.join(stateDir, 'state.json');
const port = Number(process.env.PORT || 4317);
const ignoredDirectories = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);
const projectMarkers = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'Makefile',
];
const runtimePattern = /\b(node|npm|pnpm|yarn|bun|vite|next|python|uvicorn|gunicorn|flask|django|java|docker|redis|postgres|postmaster|mysql|mysqld|cargo|go|deno|ruby)\b/i;
const agentNames = ['agenthud', 'codex', 'claude', 'opencode'];
let lastAgentScan = null;

const json = (value) => JSON.stringify(value, null, 2);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function settings() {
  return readJson(configPath, { scanRoots: ['..'], preferredAgent: 'auto', projects: [] });
}

async function storedState() {
  return readJson(statePath, { projects: {} });
}

function projectId(projectPath) {
  return createHash('sha1').update(projectPath).digest('hex').slice(0, 12);
}

function absoluteFromApp(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(appRoot, value);
}

async function isDirectory(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function hasProjectMarker(directory) {
  for (const marker of projectMarkers) {
    if (existsSync(path.join(directory, marker))) return true;
  }
  return false;
}

async function findProjectDirectories(root, depth = 0) {
  if (!(await isDirectory(root)) || depth > 2) return [];
  const matches = [];
  if (await hasProjectMarker(root)) matches.push(root);
  if (depth === 2) return matches;

  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return matches;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredDirectories.has(entry.name) || entry.name.startsWith('.')) continue;
    matches.push(...await findProjectDirectories(path.join(root, entry.name), depth + 1));
  }
  return matches;
}

function packageManager(projectPath) {
  if (existsSync(path.join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(projectPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(projectPath, 'bun.lockb')) || existsSync(path.join(projectPath, 'bun.lock'))) return 'bun';
  return 'npm';
}

function portHints(text) {
  const ports = new Set();
  for (const match of String(text || '').matchAll(/(?:--port|-p)\s*(?:=|\s)\s*(\d{2,5})\b/gi)) ports.add(Number(match[1]));
  for (const match of String(text || '').matchAll(/\bPORT\s*=\s*(\d{2,5})\b/gi)) ports.add(Number(match[1]));
  for (const match of String(text || '').matchAll(/\bport\s*:\s*(\d{2,5})\b/gi)) ports.add(Number(match[1]));
  return [...ports].filter((value) => value >= 1 && value <= 65535);
}

function normalizeConfiguredPorts(ports) {
  return (Array.isArray(ports) ? ports : [])
    .map((item) => typeof item === 'number' ? { port: item, source: 'settings' } : item)
    .filter((item) => Number.isInteger(Number(item?.port)) && Number(item.port) > 0)
    .map((item) => ({ port: Number(item.port), source: item.source || 'settings', protocol: item.protocol || 'http' }));
}

async function projectInfo(projectPath, configProject = {}) {
  const packageJson = await readJson(path.join(projectPath, 'package.json'), null);
  const scripts = packageJson?.scripts || {};
  const scriptName = ['dev', 'start', 'serve'].find((name) => typeof scripts[name] === 'string');
  const configuredStart = typeof configProject.startCommand === 'string' && configProject.startCommand.trim();
  const startCommand = configuredStart || (scriptName ? `${packageManager(projectPath)} run ${scriptName}` : null);
  const scriptText = Object.values(scripts).join(' ');
  const configuredPorts = normalizeConfiguredPorts(configProject.ports);
  const configText = (await Promise.all(['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'next.config.js', 'next.config.mjs', '.env', '.env.local'].map(async (file) => {
    try { return await readFile(path.join(projectPath, file), 'utf8'); } catch { return ''; }
  }))).join('\n');
  const explicitHints = portHints(`${scriptText}\n${configText}`);
  const hintedPorts = explicitHints.map((port) => ({ port, source: configText.includes(String(port)) ? 'project config' : 'package.json', protocol: 'http' }));
  const dependencies = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
  if (!configuredPorts.length && !hintedPorts.length) {
    const frameworkDefault = dependencies.vite ? 5173 : dependencies.next ? 3000 : dependencies['react-scripts'] ? 3000 : null;
    if (frameworkDefault) hintedPorts.push({ port: frameworkDefault, source: 'framework default', protocol: 'http' });
  }
  const name = configProject.name || packageJson?.name || path.basename(projectPath);

  return {
    id: projectId(projectPath),
    name,
    path: projectPath,
    package: packageJson ? { name: packageJson.name || null, scripts: Object.keys(scripts) } : null,
    configuredPorts,
    hintedPorts,
    openUrl: configProject.openUrl || null,
    start: startCommand ? { enabled: true, command: startCommand, source: configuredStart ? 'settings' : 'package.json' } : { enabled: false, command: null, source: null },
  };
}

async function discoverProjects(config) {
  const paths = new Set();
  for (const root of Array.isArray(config.scanRoots) ? config.scanRoots : []) {
    for (const projectPath of await findProjectDirectories(absoluteFromApp(root))) paths.add(path.normalize(projectPath));
  }
  const configured = Array.isArray(config.projects) ? config.projects : [];
  for (const item of configured) {
    if (typeof item === 'string') paths.add(absoluteFromApp(item));
    else if (item?.path) paths.add(absoluteFromApp(item.path));
  }
  const configByPath = new Map(configured.filter((item) => item && typeof item === 'object' && item.path).map((item) => [absoluteFromApp(item.path), item]));
  return Promise.all([...paths].sort().map((projectPath) => projectInfo(projectPath, configByPath.get(projectPath) || {})));
}

function execFileText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, maxBuffer: options.maxBuffer || 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function spawnFileText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      if (!settled) {
        settled = true;
        const error = new Error(`command timed out after ${options.timeout || 45000}ms`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    }, options.timeout || 45000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const error = new Error(`command exited with ${signal || code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end();
  });
}

async function which(command) {
  try {
    const result = await execFileText('which', [command], { timeout: 2000, maxBuffer: 20000 });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function availableAgents() {
  return Promise.all(agentNames.map(async (name) => ({ name, path: await which(name) })));
}

function agentEnvironment() {
  const inheritedSessionKeys = new Set([
    'CODEX_APP_TOOLS_PIPE_PATH',
    'CODEX_THREAD_ID',
    'CODEX_SESSION_ID',
    'CODEX_SHELL',
    'CODEX_PERMISSION_PROFILE',
    'CODEX_MCP_NODE_PATH',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  ]);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !inheritedSessionKeys.has(key)));
}

async function processCwd(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const result = await execFileText('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 1200, maxBuffer: 20000 });
    const line = result.stdout.split('\n').find((item) => item.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

function normalizeProcess(item) {
  const pid = Number(item.pid);
  return {
    pid,
    ppid: Number(item.parentPid || item.ppid || 0),
    name: item.name || item.command || 'unknown',
    command: [item.command, item.params].filter(Boolean).join(' ').trim(),
    cwd: item.cwd || null,
    cpu: Number.isFinite(Number(item.cpu)) ? Number(item.cpu) : null,
    rssMb: Number.isFinite(Number(item.memRss)) ? Number(item.memRss) / 1024 : null,
    started: item.started || null,
  };
}

function normalizeConnection(item) {
  const localPort = Number(item.localPort);
  return {
    pid: Number(item.pid || 0),
    port: localPort,
    address: item.localAddress || item.localaddress || '*',
    protocol: item.protocol || item.protocolFamily || 'tcp',
    state: String(item.state || '').toUpperCase(),
    process: item.process || null,
  };
}

function belongs(cwd, projectPath) {
  return cwd === projectPath || Boolean(cwd && cwd.startsWith(`${projectPath}${path.sep}`));
}

function localUrl(address, portNumber) {
  if (!portNumber) return null;
  const host = !address || address === '*' || address === '0.0.0.0' || address === '::' || address === 'localhost' ? '127.0.0.1' : address;
  return `http://${host}:${portNumber}`;
}

async function runtimeSnapshot(projects) {
  let processResult = { list: [] };
  let connectionResult = [];
  const errors = [];
  try {
    processResult = await si.processes();
  } catch (error) {
    errors.push(`process scan: ${error.message}`);
  }
  try {
    connectionResult = await si.networkConnections();
  } catch (error) {
    errors.push(`port scan: ${error.message}`);
  }

  const processes = (processResult.list || []).map(normalizeProcess).filter((item) => item.pid > 0);
  const connections = (Array.isArray(connectionResult) ? connectionResult : []).map(normalizeConnection).filter((item) => item.port > 0 && (item.state === 'LISTEN' || item.state === 'LISTENING' || !item.state));
  const processByPid = new Map(processes.map((item) => [item.pid, item]));
  const candidatePids = new Set(connections.map((item) => item.pid).filter(Boolean));
  for (const item of processes) {
    if (runtimePattern.test(`${item.name} ${item.command}`)) candidatePids.add(item.pid);
  }
  const cwdByPid = new Map();
  await Promise.all([...candidatePids].slice(0, 180).map(async (pid) => {
    const cwd = processByPid.get(pid)?.cwd || await processCwd(pid);
    if (cwd) {
      cwdByPid.set(pid, cwd);
      if (processByPid.has(pid)) processByPid.get(pid).cwd = cwd;
    }
  }));

  const processProject = new Map();
  for (const process of processes) {
    const cwd = process.cwd || cwdByPid.get(process.pid);
    const owner = projects.find((project) => belongs(cwd, project.path));
    if (owner) processProject.set(process.pid, owner.id);
  }
  for (const connection of connections) {
    if (!processProject.has(connection.pid)) {
      const cwd = cwdByPid.get(connection.pid) || await processCwd(connection.pid);
      const owner = projects.find((project) => belongs(cwd, project.path));
      if (owner) processProject.set(connection.pid, owner.id);
    }
  }

  const byProject = new Map(projects.map((project) => [project.id, { processes: [], ports: [] }]));
  for (const process of processes) {
    const owner = processProject.get(process.pid);
    if (owner && byProject.has(owner)) byProject.get(owner).processes.push(process);
  }
  for (const connection of connections) {
    const owner = processProject.get(connection.pid);
    if (owner && byProject.has(owner)) byProject.get(owner).ports.push({ ...connection, url: localUrl(connection.address, connection.port) });
  }
  return { byProject, errors };
}

function uniquePortRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = row.port;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function scanState() {
  const config = await settings();
  const previous = await storedState();
  const metadata = await discoverProjects(config);
  const { byProject, errors } = await runtimeSnapshot(metadata);
  const now = new Date().toISOString();
  const nextStored = { projects: { ...(previous.projects || {}) } };
  const projects = metadata.map((item) => {
    const runtime = byProject.get(item.id) || { processes: [], ports: [] };
    const previousProject = previous.projects?.[item.id] || {};
    const livePorts = runtime.ports.map((row) => ({
      port: row.port,
      protocol: row.protocol,
      address: row.address,
      url: row.url,
      running: true,
      source: 'listening process',
      pid: row.pid,
      process: row.process,
    }));
    const knownRows = [...item.configuredPorts, ...item.hintedPorts, ...(previousProject.ports || [])]
      .map((row) => ({ ...row, running: false, url: localUrl(null, Number(row.port)) }));
    const ports = uniquePortRows([...livePorts, ...knownRows]);
    const running = runtime.processes.length > 0 || livePorts.length > 0;
    if (running) nextStored.projects[item.id] = { ports: livePorts.map((row) => ({ port: row.port, protocol: row.protocol, source: 'last seen' })), lastSeen: now };
    return {
      id: item.id,
      name: item.name,
      path: item.path,
      status: running ? 'running' : 'stopped',
      processCount: runtime.processes.length,
      processes: runtime.processes.slice(0, 80).map((process) => ({ ...process, cwd: process.cwd || null })),
      ports,
      openUrl: item.openUrl || livePorts[0]?.url || null,
      start: item.start,
      package: item.package,
      lastSeen: running ? now : previousProject.lastSeen || null,
    };
  });
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(statePath, json(nextStored));
  } catch (error) {
    errors.push(`state persistence: ${error.message}`);
  }
  return {
    generatedAt: now,
    scanRoots: (config.scanRoots || []).map(absoluteFromApp),
    projects,
    availableAgents: await availableAgents(),
    agentScan: lastAgentScan,
    errors,
  };
}

const agentPrompt = (root) => `You are running a read-only local developer-runtime scan for ${root}. Do not modify files, start processes, stop processes, inspect repository contents, or access secrets. Run at most these three commands: (1) lsof -nP -iTCP -sTCP:LISTEN, (2) ps -axo pid=,ppid=,comm=,args= and filter only common dev runtimes such as node, npm, pnpm, bun, python, java, docker, redis, postgres, mysql, (3) use lsof cwd only for the relevant dev-runtime PIDs if needed. Then immediately return a concise report with process, PID, port, and URL. Do not do any other investigation.`;

function parseJsonLines(output) {
  return String(output || '').split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function extractAgentText(output) {
  const events = parseJsonLines(output);
  const messages = events.flatMap((event) => {
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') return [event.item.text || event.item.content || ''];
    if (event.type === 'message' && typeof event.text === 'string') return [event.text];
    return [];
  }).filter(Boolean);
  return { events, text: messages.at(-1) || String(output || '').trim() };
}

async function runAgentScan() {
  const config = await settings();
  const root = absoluteFromApp(config.scanRoots?.[0] || '..');
  const agents = await availableAgents();
  const selected = config.preferredAgent && config.preferredAgent !== 'auto'
    ? agents.find((agent) => agent.name === config.preferredAgent && agent.path)
    : agents.find((agent) => agent.name === 'agenthud' && agent.path) || agents.find((agent) => agent.name === 'codex' && agent.path) || agents.find((agent) => agent.path);
  if (!selected) {
    lastAgentScan = { status: 'unavailable', message: '没有检测到 agenthud、codex、claude 或 opencode。', finishedAt: new Date().toISOString() };
    return lastAgentScan;
  }

  const startedAt = new Date().toISOString();
  let args;
  if (selected.name === 'agenthud') args = ['follow', '--json', '--once'];
  else if (selected.name === 'codex') args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', root, agentPrompt(root)];
  else if (selected.name === 'claude') args = ['-p', agentPrompt(root), '--output-format', 'text'];
  else args = ['run', agentPrompt(root)];

  try {
    const result = await spawnFileText(selected.path, args, { cwd: root, timeout: 60000, env: agentEnvironment() });
    const parsed = extractAgentText(result.stdout);
    lastAgentScan = { status: 'ok', agent: selected.name, path: selected.path, startedAt, finishedAt: new Date().toISOString(), text: parsed.text.slice(-12000), eventCount: parsed.events.length };
  } catch (error) {
    lastAgentScan = { status: 'error', agent: selected.name, path: selected.path, startedAt, finishedAt: new Date().toISOString(), message: error.message, output: String(error.stdout || error.stderr || '').slice(-4000) };
  }
  return lastAgentScan;
}

async function startProject(id) {
  const state = await scanState();
  const project = state.projects.find((item) => item.id === id);
  if (!project) throw new Error('项目不存在或不在当前扫描范围内');
  if (!project.start?.enabled || !project.start.command) throw new Error('项目没有可执行的启动脚本');
  const child = spawn(project.start.command, {
    cwd: project.path,
    detached: true,
    stdio: 'ignore',
    shell: true,
    env: process.env,
  });
  child.unref();
  return { pid: child.pid, command: project.start.command };
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function send(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    if (request.method === 'GET' && url.pathname === '/api/state') return send(response, 200, await scanState());
    if (request.method === 'POST' && url.pathname === '/api/scan/agent') return send(response, 200, { agentScan: await runAgentScan(), state: await scanState() });
    const startMatch = url.pathname.match(/^\/api\/projects\/([a-f0-9]+)\/start$/);
    if (request.method === 'POST' && startMatch) return send(response, 200, { started: await startProject(startMatch[1]) });
    if (request.method === 'GET' && url.pathname === '/api/health') return send(response, 200, { ok: true });
    send(response, 404, { error: 'Not found' });
  } catch (error) {
    send(response, 400, { error: error.message || 'Request failed' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Agent Runtime API: http://127.0.0.1:${port}`);
});

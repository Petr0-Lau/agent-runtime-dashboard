import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
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
const agentNames = ['codex', 'claude', 'opencode'];
let agentDiscovery = { status: 'idle', startedAt: null, finishedAt: null, reports: [], errors: [] };
let agentInventory = new Map();
let agentUnassignedPorts = [];
let agentScanPromise = null;

const json = (value) => JSON.stringify(value, null, 2);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function settings() {
  return readJson(configPath, { scanRoots: ['~'], preferredAgent: 'auto', projects: [] });
}

async function storedState() {
  return readJson(statePath, { projects: {}, agentInventory: [], agentUnassignedPorts: [] });
}

function projectId(projectPath) {
  return createHash('sha1').update(projectPath).digest('hex').slice(0, 12);
}

function absoluteFromApp(value) {
  const raw = String(value || '');
  if (raw.startsWith('file://')) {
    try { return path.normalize(fileURLToPath(raw)); } catch { return raw; }
  }
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(appRoot, raw);
}

function packageManager(projectPath) {
  if (existsSync(path.join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(projectPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(projectPath, 'bun.lockb')) || existsSync(path.join(projectPath, 'bun.lock'))) return 'bun';
  return 'npm';
}

function normalizeConfiguredPorts(ports) {
  return (Array.isArray(ports) ? ports : [])
    .map((item) => typeof item === 'number' ? { port: item, source: 'settings' } : item)
    .filter((item) => Number.isInteger(Number(item?.port)) && Number(item.port) > 0)
    .map((item) => ({ port: Number(item.port), source: item.source || 'settings', protocol: item.protocol || 'http' }));
}

function normalizeAgentPorts(ports) {
  return (Array.isArray(ports) ? ports : [])
    .map((item) => typeof item === 'number' ? { port: item } : item)
    .filter((item) => Number.isInteger(Number(item?.port)) && Number(item.port) > 0 && Number(item.port) <= 65535)
    .map((item) => ({
      port: Number(item.port),
      protocol: item.protocol || 'tcp',
      address: item.address || '*',
      url: item.url || localUrl(item.address, Number(item.port)),
      running: Boolean(item.running),
      source: item.source || 'Agent CLI',
      pid: Number(item.pid) || null,
      process: item.process || null,
    }));
}

async function projectInfo(projectPath, configProject = {}, agentProject = null, sources = []) {
  const packageJson = await readJson(path.join(projectPath, 'package.json'), null);
  const scripts = packageJson?.scripts || {};
  const scriptName = ['dev', 'start', 'serve'].find((name) => typeof scripts[name] === 'string');
  const configuredStart = typeof configProject.startCommand === 'string' && configProject.startCommand.trim();
  const startCommand = configuredStart || (scriptName ? `${packageManager(projectPath)} run ${scriptName}` : null);
  const configuredPorts = normalizeConfiguredPorts(configProject.ports);
  const name = configProject.name || packageJson?.name || path.basename(projectPath);

  return {
    id: projectId(projectPath),
    name,
    path: projectPath,
    agents: agentProject ? [...new Set(agentProject.agents)].sort() : [],
    sessionCount: agentProject?.sessionCount || 0,
    agentLastSeen: agentProject?.lastSeen || null,
    agentStatus: agentProject?.status || null,
    reportedPorts: normalizeAgentPorts(agentProject?.ports),
    evidence: agentProject?.evidence || [],
    sources: [...new Set(sources)],
    package: packageJson ? { name: packageJson.name || null, scripts: Object.keys(scripts) } : null,
    configuredPorts,
    openUrl: configProject.openUrl || null,
    start: startCommand ? { enabled: true, command: startCommand, source: configuredStart ? 'settings' : 'package.json' } : { enabled: false, command: null, source: null },
  };
}

async function canonicalProjectPath(value) {
  const projectPath = absoluteFromApp(value);
  if (!path.isAbsolute(projectPath) || projectPath === path.parse(projectPath).root || projectPath === os.homedir()) return null;
  try { return await realpath(projectPath); } catch { return path.normalize(projectPath); }
}

function parseJsonObject(text) {
  const value = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  for (const candidate of [value, value.slice(value.indexOf('{'), value.lastIndexOf('}') + 1)]) {
    if (!candidate || !candidate.startsWith('{')) continue;
    try { return JSON.parse(candidate); } catch { /* Agent may have added a short preamble. */ }
  }
  return null;
}

async function normalizeAgentReport(report, agent, finishedAt) {
  const projects = [];
  for (const item of Array.isArray(report?.projects) ? report.projects : []) {
    const projectPath = await canonicalProjectPath(item?.path || item?.cwd || item?.projectPath);
    if (!projectPath) continue;
    const ports = normalizeAgentPorts(item.ports);
    const status = ['running', 'stopped', 'missing'].includes(item.status)
      ? item.status
      : ports.some((port) => port.running) ? 'running' : existsSync(projectPath) ? 'stopped' : 'missing';
    projects.push({
      path: projectPath,
      name: item.name || path.basename(projectPath),
      agents: [agent],
      sessionCount: Number(item.sessionCount) || 1,
      lastSeen: item.lastSeen || finishedAt,
      status,
      ports,
      evidence: Array.isArray(item.evidence) ? item.evidence.filter(Boolean).slice(0, 12) : [],
    });
  }
  return {
    projects,
    unassignedPorts: normalizeAgentPorts(report?.unassignedPorts),
  };
}

function mergeAgentInventory(results) {
  const projects = new Map();
  const unassigned = new Map();
  for (const result of results) {
    for (const item of result.inventory.projects) {
      const current = projects.get(item.path) || { ...item, agents: [], ports: [] };
      current.agents = [...new Set([...current.agents, ...item.agents])];
      current.sessionCount += item.sessionCount;
      if (!current.lastSeen || item.lastSeen > current.lastSeen) current.lastSeen = item.lastSeen;
      if (current.status !== 'running' && item.status === 'running') current.status = 'running';
      if (current.status === 'missing' && item.status !== 'missing') current.status = item.status;
      current.evidence = [...new Set([...current.evidence, ...item.evidence])].slice(0, 12);
      current.ports.push(...item.ports);
      projects.set(item.path, current);
    }
    for (const port of result.inventory.unassignedPorts) {
      const key = `${port.pid || ''}:${port.address}:${port.port}`;
      unassigned.set(key, port);
    }
  }
  for (const item of projects.values()) item.ports = uniquePortRows(item.ports);
  return { projects, unassignedPorts: [...unassigned.values()] };
}

const agentPrompt = (agent) => `Start a fresh read-only local inventory session as ${agent}. Independently discover the local coding-agent projects and their ports for the current user on this Mac.

Use your own Agent project/session index or metadata first; do not recursively read raw session transcripts, crawl arbitrary home-directory files, invoke another Agent, or dump large command outputs into your context. Use no more than five read-only shell commands and do not retry failed command variants. Then verify only candidate project roots and current process/socket ownership. Inspect project manifests only when needed to identify an explicit stopped port. Do not rely on this dashboard's previous output. Do not modify files, install anything, start or stop processes, read source code or secrets, or assume a directory is a project from its name alone.

Return ONLY one JSON object, with this exact shape and no markdown:
{"projects":[{"path":"/absolute/project/root","name":"name","status":"running|stopped|missing","ports":[{"port":5173,"url":"http://127.0.0.1:5173","running":true,"pid":123,"process":"node","evidence":"why this port belongs to this project"}],"evidence":["how the project was found"]}],"unassignedPorts":[{"port":1234,"url":"http://127.0.0.1:1234","running":true,"pid":123,"process":"node","evidence":"why ownership is unknown"}],"notes":["optional limitations"]}

Rules: path must be an absolute project/workspace root, not an Agent cache, plugin, skill, session, log, or config directory; include stopped projects learned from Agent metadata and mark deleted ones as missing; include a port only when you observed it in a process/socket or an explicit project configuration; tie a running port to a project only with process cwd/parent-process or equivalent evidence; otherwise put it in unassignedPorts. Deduplicate paths yourself before returning. Finish promptly; if an index or ownership check is unavailable, return the verified partial result with a note instead of waiting indefinitely.`;

function agentCommand(agent, prompt, root) {
  if (agent.name === 'codex') return ['--ask-for-approval', 'never', 'exec', '--ignore-user-config', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', root, prompt];
  if (agent.name === 'claude') return ['-p', prompt, '--output-format', 'text'];
  return ['run', prompt];
}

async function runOneAgent(agent, root) {
  const startedAt = new Date().toISOString();
  try {
    const result = await spawnFileText(agent.path, agentCommand(agent, agentPrompt(agent.name), root), { cwd: root, timeout: 180000, env: agentEnvironment() });
    const parsed = extractAgentText(result.stdout);
    const report = parseJsonObject(parsed.text);
    if (!report) throw new Error('Agent CLI 没有返回可解析的 JSON inventory');
    const finishedAt = new Date().toISOString();
    const inventory = await normalizeAgentReport(report, agent.name, finishedAt);
    return {
      summary: { status: 'ok', agent: agent.name, path: agent.path, startedAt, finishedAt, projectCount: inventory.projects.length, unassignedPortCount: inventory.unassignedPorts.length, text: parsed.text.slice(-12000) },
      inventory,
    };
  } catch (error) {
    return { summary: { status: 'error', agent: agent.name, path: agent.path, startedAt, finishedAt: new Date().toISOString(), message: error.message, output: String(error.stdout || error.stderr || '').slice(-4000) }, inventory: { projects: [], unassignedPorts: [] } };
  }
}

async function runAgentScans() {
  const config = await settings();
  const root = absoluteFromApp(config.scanRoots?.[0] || '~');
  const agents = (await availableAgents()).filter((agent) => agent.path);
  if (!agents.length) {
    return { summaries: [{ status: 'unavailable', message: '没有检测到可执行的 codex、claude 或 opencode CLI。' }], inventory: { projects: new Map(), unassignedPorts: [] } };
  }
  const results = await Promise.all(agents.map((agent) => runOneAgent(agent, root)));
  return { summaries: results.map((result) => result.summary), inventory: mergeAgentInventory(results) };
}

function startAgentDiscovery(force = false) {
  if (agentScanPromise) return agentScanPromise;
  if (!force && agentDiscovery.status !== 'idle') return Promise.resolve(agentDiscovery);
  const startedAt = new Date().toISOString();
  agentDiscovery = { status: 'running', startedAt, finishedAt: null, reports: [], errors: [] };
  agentScanPromise = runAgentScans().then((result) => {
    if (result.summaries.some((summary) => summary.status === 'ok')) {
      agentInventory = result.inventory.projects;
      agentUnassignedPorts = result.inventory.unassignedPorts;
    }
    agentDiscovery = {
      status: result.summaries.some((summary) => summary.status === 'ok') ? 'ok' : result.summaries.some((summary) => summary.status === 'error') ? 'error' : 'unavailable',
      startedAt,
      finishedAt: new Date().toISOString(),
      reports: result.summaries,
      errors: result.summaries.filter((summary) => summary.status === 'error').map((summary) => `${summary.agent}: ${summary.message}`),
    };
    return agentDiscovery;
  }).catch((error) => {
    agentDiscovery = { status: 'error', startedAt, finishedAt: new Date().toISOString(), reports: [], errors: [error.message] };
    return agentDiscovery;
  }).finally(() => { agentScanPromise = null; });
  return agentScanPromise;
}

async function discoverProjects(config) {
  const paths = new Map();
  const configured = Array.isArray(config.projects) ? config.projects : [];
  for (const item of configured) {
    const configuredPath = typeof item === 'string' ? absoluteFromApp(item) : item?.path ? absoluteFromApp(item.path) : null;
    if (configuredPath) paths.set(path.normalize(configuredPath), { sources: ['settings'] });
  }
  const configByPath = new Map(configured.filter((item) => item && typeof item === 'object' && item.path).map((item) => [absoluteFromApp(item.path), item]));
  for (const [projectPath, agentProject] of agentInventory) {
    const sources = [...new Set([...(paths.get(projectPath)?.sources || []), ...agentProject.agents.map((agent) => `agent:${agent}`)])];
    paths.set(projectPath, { sources });
  }
  return Promise.all([...paths.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([projectPath, meta]) => projectInfo(projectPath, configByPath.get(projectPath) || {}, agentInventory.get(projectPath) || null, meta.sources)));
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
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !inheritedSessionKeys.has(key))), PATH: [process.env.PATH, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':') };
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
  const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${displayHost}:${portNumber}`;
}

async function runtimeProjectRoot(cwd) {
  if (!cwd || !path.isAbsolute(cwd) || cwd === os.homedir() || cwd === path.parse(cwd).root) return null;
  try {
    const result = await execFileText('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 1200, maxBuffer: 20000 });
    const root = result.stdout.trim();
    if (root && root !== os.homedir() && root !== path.parse(root).root) return path.normalize(root);
  } catch {
    if (existsSync(path.join(cwd, 'package.json'))) return path.normalize(cwd);
  }
  return null;
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
  for (const pid of [...candidatePids]) {
    let current = processByPid.get(pid);
    while (current?.ppid && processByPid.has(current.ppid)) {
      candidatePids.add(current.ppid);
      current = processByPid.get(current.ppid);
    }
  }
  const cwdByPid = new Map();
  await Promise.all([...candidatePids].slice(0, 300).map(async (pid) => {
    const cwd = processByPid.get(pid)?.cwd || await processCwd(pid);
    if (cwd) {
      cwdByPid.set(pid, cwd);
      if (processByPid.has(pid)) processByPid.get(pid).cwd = cwd;
    }
  }));

  const runtimePaths = new Set();
  await Promise.all([...new Set([...cwdByPid.values(), ...processes.map((process) => process.cwd).filter(Boolean)])].map(async (cwd) => {
    const root = await runtimeProjectRoot(cwd);
    if (root && !projects.some((project) => project.path === root)) runtimePaths.add(root);
  }));
  const candidates = [...projects, ...[...runtimePaths].map((projectPath) => ({ id: projectId(projectPath), path: projectPath }))];
  const ownerForCwd = (cwd) => {
    if (!cwd) return null;
    return candidates.filter((project) => project.path !== os.homedir() && belongs(cwd, project.path)).sort((left, right) => right.path.length - left.path.length)[0] || null;
  };
  const processProject = new Map();
  for (const process of processes) {
    const cwd = process.cwd || cwdByPid.get(process.pid);
    const owner = ownerForCwd(cwd);
    if (owner) processProject.set(process.pid, owner.id);
  }
  const ownerForPid = (pid, visited = new Set()) => {
    if (!pid || visited.has(pid)) return null;
    visited.add(pid);
    if (processProject.has(pid)) return { id: processProject.get(pid) };
    const process = processByPid.get(pid);
    const cwdOwner = ownerForCwd(cwdByPid.get(pid) || process?.cwd);
    if (cwdOwner) {
      processProject.set(pid, cwdOwner.id);
      return cwdOwner;
    }
    return process?.ppid ? ownerForPid(process.ppid, visited) : null;
  };
  for (const process of processes) ownerForPid(process.pid);
  for (const connection of connections) {
    if (!processProject.has(connection.pid)) ownerForPid(connection.pid);
  }

  const byProject = new Map(candidates.map((project) => [project.id, { processes: [], ports: [] }]));
  for (const process of processes) {
    const owner = processProject.get(process.pid);
    if (owner && byProject.has(owner)) byProject.get(owner).processes.push(process);
  }
  for (const connection of connections) {
    const owner = processProject.get(connection.pid);
    if (owner && byProject.has(owner)) byProject.get(owner).ports.push({ ...connection, url: localUrl(connection.address, connection.port) });
  }
  const unassignedPorts = connections.filter((connection) => !processProject.has(connection.pid)).map((connection) => ({ ...connection, url: localUrl(connection.address, connection.port) }));
  return { byProject, errors, extraPaths: [...runtimePaths], unassignedPorts };
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

function uniqueSocketRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.pid || ''}:${row.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function scanState() {
  const config = await settings();
  startAgentDiscovery();
  const previous = await storedState();
  if (!agentInventory.size && Array.isArray(previous.agentInventory)) {
    agentInventory = new Map(previous.agentInventory.filter((item) => item?.path).map((item) => [item.path, item]));
    agentUnassignedPorts = Array.isArray(previous.agentUnassignedPorts) ? previous.agentUnassignedPorts : [];
  }
  const metadata = await discoverProjects(config);
  const runtime = await runtimeSnapshot(metadata);
  const knownPaths = new Set(metadata.map((item) => item.path));
  const runtimeProjects = await Promise.all(runtime.extraPaths.filter((projectPath) => !knownPaths.has(projectPath)).map((projectPath) => projectInfo(projectPath, {}, null, ['runtime'])));
  const allMetadata = [...metadata, ...runtimeProjects];
  const { byProject, errors = [], unassignedPorts: runtimeUnassignedPorts = [] } = runtime;
  const now = new Date().toISOString();
  const nextStored = { projects: { ...(previous.projects || {}) }, agentInventory: [...agentInventory.values()], agentUnassignedPorts };
  const projects = allMetadata.map((item) => {
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
    const reportedRows = item.reportedPorts.map((row) => ({ ...row, url: row.url || localUrl(row.address, Number(row.port)) }));
    const knownRows = [...reportedRows, ...item.configuredPorts, ...(previousProject.ports || [])]
      .map((row) => ({ ...row, running: Boolean(row.running), url: row.url || localUrl(null, Number(row.port)) }));
    const ports = uniquePortRows([...livePorts, ...knownRows]);
    const running = runtime.processes.length > 0 || livePorts.length > 0 || item.agentStatus === 'running' || reportedRows.some((row) => row.running);
    const exists = existsSync(item.path);
    if (running) nextStored.projects[item.id] = { ports: livePorts.map((row) => ({ port: row.port, protocol: row.protocol, source: 'last seen' })), lastSeen: now };
    return {
      id: item.id,
      name: item.name,
      path: item.path,
      status: running ? 'running' : exists ? 'stopped' : 'missing',
      agents: item.agents,
      sessionCount: item.sessionCount,
      sources: item.sources,
      processCount: runtime.processes.length,
      processes: runtime.processes.slice(0, 80).map((process) => ({ ...process, cwd: process.cwd || null })),
      ports,
      openUrl: item.openUrl || livePorts[0]?.url || reportedRows.find((row) => row.url)?.url || null,
      start: item.start,
      package: item.package,
      lastSeen: running ? now : item.agentLastSeen || previousProject.lastSeen || null,
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
    agentDiscovery,
    agentScans: agentDiscovery.reports,
    unassignedPorts: uniqueSocketRows([...agentUnassignedPorts, ...runtimeUnassignedPorts]),
    errors: [...agentDiscovery.errors, ...errors],
  };
}

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
    if (request.method === 'POST' && url.pathname === '/api/scan/agent') return send(response, 200, { agentDiscovery: await startAgentDiscovery(true), state: await scanState() });
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

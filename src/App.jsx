import { useCallback, useEffect, useMemo, useState } from 'react';

const emptyState = { generatedAt: null, scanRoots: [], projects: [], availableAgents: [], agentDiscovery: { status: 'idle' }, agentScans: [], unassignedPorts: [], errors: [] };

async function request(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}

function formatTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

function Status({ status }) {
  const label = status === 'running' ? '运行中' : status === 'missing' ? '路径不存在' : '未运行';
  return <span className={`status status-${status}`}><i />{label}</span>;
}

function PortList({ project }) {
  if (!project.ports.length) return <span className="muted">未登记</span>;
  return (
    <div className="port-list">
      {project.ports.map((port) => (
        <span className={`port ${port.running ? 'port-live' : 'port-known'}`} key={port.port}>
          {port.port}
          <small>{port.running ? 'LISTEN' : '已知'}</small>
        </span>
      ))}
    </div>
  );
}

function ProjectRow({ project, onStart, starting }) {
  const open = () => project.openUrl && window.open(project.openUrl, '_blank', 'noopener,noreferrer');
  return (
    <article className="project-row">
      <div className="project-main">
        <div className="project-title-line">
          <h3>{project.name}</h3>
          <Status status={project.status} />
        </div>
        <p className="project-path" title={project.path}>{project.path}</p>
        <div className="project-meta">
          <span>{project.processCount} 个进程</span>
          {project.agents?.length > 0 && <span>{project.agents.join(' · ')}</span>}
          <span>最后发现 {formatTime(project.lastSeen)}</span>
        </div>
      </div>
      <div className="project-ports">
        <span className="label">端口</span>
        <PortList project={project} />
        <span className="port-url">{project.openUrl || (project.ports[0] ? `${project.ports[0].url} · 当前未运行` : '没有可打开的 URL')}</span>
      </div>
      <div className="project-actions">
        <button className="button button-primary" disabled={!project.start.enabled || starting} onClick={() => onStart(project)}>
          {starting ? '启动中…' : project.status === 'running' ? '已运行' : project.start.enabled ? '启动' : '未配置启动'}
        </button>
        <button className="button button-quiet" disabled={!project.openUrl} onClick={open}>打开网页</button>
      </div>
    </article>
  );
}

function AgentResult({ scans, discovery }) {
  if (!scans?.length) return <div className="empty-agent">{discovery?.status === 'running' ? '每个可用 Agent CLI 正在执行只读发现会话…' : discovery?.status === 'unavailable' ? '没有检测到可执行的 codex、claude 或 opencode CLI。' : '等待 Agent CLI 返回项目清单。'}</div>;
  return <div className="agent-results">{scans.map((scan) => <div className="agent-result" key={`${scan.agent || 'agent'}-${scan.startedAt || scan.finishedAt}`}><div className="agent-result-head"><span className={`result-dot result-${scan.status}`} /><strong>{scan.agent || 'Agent CLI'} · {scan.status === 'ok' ? `扫描完成 · ${scan.projectCount} 个项目` : '扫描失败'}</strong><span className="muted">{formatTime(scan.finishedAt)}</span></div><pre>{scan.text || scan.message || scan.output || '没有输出'}</pre></div>)}</div>;
}

function UnassignedPorts({ ports }) {
  if (!ports?.length) return null;
  return (
    <section className="unassigned-section">
      <div className="section-head"><div><h2>未归属监听端口</h2><p>进程可见，但 macOS 没有提供足够的 cwd 信息来判断它属于哪个项目。</p></div></div>
      <div className="unassigned-list">
        {ports.map((port) => <article className="unassigned-port" key={`${port.pid}-${port.port}-${port.address}`}><strong>{port.port}</strong><span>{port.url}</span><small>{port.process || `PID ${port.pid}`} · {port.address}</small></article>)}
      </div>
    </section>
  );
}

export default function App() {
  const [state, setState] = useState(emptyState);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [agentLoading, setAgentLoading] = useState(false);
  const [startingId, setStartingId] = useState(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setState(await request('/api/state'));
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => refresh(true), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const projects = useMemo(() => state.projects
    .filter((project) => filter === 'all' || project.status === filter)
    .filter((project) => `${project.name} ${project.path} ${(project.agents || []).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((left, right) => Number(right.status === 'running') - Number(left.status === 'running') || left.path.localeCompare(right.path)), [filter, query, state.projects]);
  const running = state.projects.filter((project) => project.status === 'running').length;
  const livePorts = state.projects.flatMap((project) => project.ports.filter((port) => port.running)).length;
  const visibleLivePorts = livePorts + (state.unassignedPorts?.length || 0);
  const availableAgentNames = state.availableAgents.filter((agent) => agent.path).map((agent) => agent.name);
  const agentRunning = agentLoading || state.agentDiscovery?.status === 'running';

  const startProject = async (project) => {
    setStartingId(project.id);
    try {
      await request(`/api/projects/${project.id}/start`, { method: 'POST' });
      await refresh(true);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setStartingId(null);
    }
  };

  const scanWithAgent = async () => {
    setAgentLoading(true);
    try {
      const result = await request('/api/scan/agent', { method: 'POST' });
      setState(result.state);
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setAgentLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">⌁</span><span>Agent Runtime</span></div>
        <div className="sidebar-caption">GLOBAL LOCAL SCAN</div>
        <div className="root-path" title={state.scanRoots.join('\n')}>{state.scanRoots[0] || '扫描目录加载中…'}</div>
        <nav className="sidebar-nav"><button className="nav-item nav-active"><span>◈</span>项目总览 <b>{state.projects.length}</b></button></nav>
        <div className="sidebar-footer">
          <div className="cli-label">Agent CLI</div>
          <div className="cli-list">
            {state.availableAgents.map((agent) => <span className={agent.path ? 'cli cli-on' : 'cli'} key={agent.name}><i />{agent.name}</span>)}
          </div>
          <p>项目清单由只读 Agent CLI 会话返回。</p>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div><p className="eyebrow">RUNTIME INVENTORY</p><h1>项目总览</h1></div>
          <div className="top-actions">
            <span className="updated">更新于 {formatTime(state.generatedAt)}</span>
            <button className="button button-quiet" onClick={() => refresh()} disabled={loading}>{loading ? '扫描中…' : '重新扫描'}</button>
            <button className="button button-agent" onClick={scanWithAgent} disabled={agentRunning || !availableAgentNames.length}>{agentRunning ? 'Agent 扫描中…' : '重新询问 Agent'}</button>
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}
        {state.errors?.length > 0 && <div className="warning-banner">{state.errors.join(' · ')}</div>}

        <section className="summary-grid" aria-label="运行摘要">
          <div className="summary-item"><span>全部项目</span><strong>{state.projects.length}</strong><small>已发现的项目目录</small></div>
          <div className="summary-item summary-running"><span>运行中</span><strong>{running}</strong><small>当前有进程或监听端口</small></div>
          <div className="summary-item"><span>未运行</span><strong>{state.projects.length - running}</strong><small>保留已知端口信息</small></div>
          <div className="summary-item"><span>监听端口</span><strong>{visibleLivePorts}</strong><small>项目归属 + 未归属 LISTEN</small></div>
        </section>

        <section className="section-head"><div><h2>项目</h2><p>项目清单由每个可用 Agent CLI 的只读会话返回，本地只按规范化路径去重并核对运行端口。</p>{state.unassignedPorts?.length > 0 && <p className="unassigned-note">另有 {state.unassignedPorts.length} 个监听端口无法从进程 cwd 归属到项目，已保留为未归属端口。</p>}</div><div className="project-controls"><input aria-label="搜索项目" placeholder="搜索项目或路径" value={query} onChange={(event) => setQuery(event.target.value)} /><div className="filters"><button className={filter === 'all' ? 'filter-active' : ''} onClick={() => setFilter('all')}>全部</button><button className={filter === 'running' ? 'filter-active' : ''} onClick={() => setFilter('running')}>运行中</button><button className={filter === 'stopped' ? 'filter-active' : ''} onClick={() => setFilter('stopped')}>未运行</button></div></div></section>

        <section className="project-list">
          {loading && !state.projects.length ? <div className="loading-state">正在读取本机项目和端口…</div> : projects.length ? projects.map((project) => <ProjectRow key={project.id} project={project} onStart={startProject} starting={startingId === project.id} />) : <div className="loading-state">当前筛选条件下没有项目。</div>}
        </section>

        <UnassignedPorts ports={state.unassignedPorts} />

        <section className="agent-section"><div className="section-head"><div><h2>Agent CLI 输出</h2><p>启动时自动询问每个可用 CLI；按钮可重新执行一次只读发现会话。</p></div></div><AgentResult scans={state.agentScans} discovery={state.agentDiscovery} /></section>
      </main>
    </div>
  );
}

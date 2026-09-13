import { useCallback, useEffect, useMemo, useState } from 'react';

const emptyState = { generatedAt: null, scanRoots: [], projects: [], availableAgents: [], agentScan: null, errors: [] };

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
  return <span className={`status status-${status}`}><i />{status === 'running' ? '运行中' : '未运行'}</span>;
}

function PortList({ project }) {
  if (!project.ports.length) return <span className="muted">未登记</span>;
  return (
    <div className="port-list">
      {project.ports.map((port) => (
        <span className={`port ${port.running ? 'port-live' : 'port-known'}`} key={`${port.protocol}-${port.port}`}>
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

function AgentResult({ scan }) {
  if (!scan) return <div className="empty-agent">点击“调用 Agent CLI”后，结果会显示在这里。</div>;
  if (scan.status === 'unavailable') return <div className="empty-agent">{scan.message}</div>;
  return (
    <div className="agent-result">
      <div className="agent-result-head">
        <span className={`result-dot result-${scan.status}`} />
        <strong>{scan.agent || 'Agent CLI'} · {scan.status === 'ok' ? '扫描完成' : '扫描失败'}</strong>
        <span className="muted">{formatTime(scan.finishedAt)}</span>
      </div>
      <pre>{scan.text || scan.message || scan.output || '没有输出'}</pre>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState(emptyState);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [agentLoading, setAgentLoading] = useState(false);
  const [startingId, setStartingId] = useState(null);
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

  const projects = useMemo(() => state.projects.filter((project) => filter === 'all' || project.status === filter), [filter, state.projects]);
  const running = state.projects.filter((project) => project.status === 'running').length;
  const livePorts = state.projects.flatMap((project) => project.ports.filter((port) => port.running)).length;
  const availableAgentNames = state.availableAgents.filter((agent) => agent.path).map((agent) => agent.name);

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
        <div className="sidebar-caption">LOCAL WORKSPACE</div>
        <div className="root-path" title={state.scanRoots.join('\n')}>{state.scanRoots[0] || '扫描目录加载中…'}</div>
        <nav className="sidebar-nav"><button className="nav-item nav-active"><span>◈</span>项目总览 <b>{state.projects.length}</b></button></nav>
        <div className="sidebar-footer">
          <div className="cli-label">Agent CLI</div>
          <div className="cli-list">
            {state.availableAgents.map((agent) => <span className={agent.path ? 'cli cli-on' : 'cli'} key={agent.name}><i />{agent.name}</span>)}
          </div>
          <p>核心扫描不依赖 Agent CLI。</p>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div><p className="eyebrow">RUNTIME INVENTORY</p><h1>项目总览</h1></div>
          <div className="top-actions">
            <span className="updated">更新于 {formatTime(state.generatedAt)}</span>
            <button className="button button-quiet" onClick={() => refresh()} disabled={loading}>{loading ? '扫描中…' : '重新扫描'}</button>
            <button className="button button-agent" onClick={scanWithAgent} disabled={agentLoading || !availableAgentNames.length}>{agentLoading ? 'Agent 扫描中…' : '调用 Agent CLI'}</button>
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}
        {state.errors?.length > 0 && <div className="warning-banner">{state.errors.join(' · ')}</div>}

        <section className="summary-grid" aria-label="运行摘要">
          <div className="summary-item"><span>全部项目</span><strong>{state.projects.length}</strong><small>已发现的项目目录</small></div>
          <div className="summary-item summary-running"><span>运行中</span><strong>{running}</strong><small>当前有进程或监听端口</small></div>
          <div className="summary-item"><span>未运行</span><strong>{state.projects.length - running}</strong><small>保留已知端口信息</small></div>
          <div className="summary-item"><span>监听端口</span><strong>{livePorts}</strong><small>来自当前 LISTEN 进程</small></div>
        </section>

        <section className="section-head"><div><h2>项目</h2><p>项目状态和端口来自本机实时扫描；已知端口会保留在未运行项目中。</p></div><div className="filters"><button className={filter === 'all' ? 'filter-active' : ''} onClick={() => setFilter('all')}>全部</button><button className={filter === 'running' ? 'filter-active' : ''} onClick={() => setFilter('running')}>运行中</button><button className={filter === 'stopped' ? 'filter-active' : ''} onClick={() => setFilter('stopped')}>未运行</button></div></section>

        <section className="project-list">
          {loading && !state.projects.length ? <div className="loading-state">正在读取本机项目和端口…</div> : projects.length ? projects.map((project) => <ProjectRow key={project.id} project={project} onStart={startProject} starting={startingId === project.id} />) : <div className="loading-state">当前筛选条件下没有项目。</div>}
        </section>

        <section className="agent-section"><div className="section-head"><div><h2>Agent CLI 输出</h2><p>只读调用，优先 AgentHUD；否则使用 Codex CLI。</p></div></div><AgentResult scan={state.agentScan} /></section>
      </main>
    </div>
  );
}

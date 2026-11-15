import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, ApprovalRequest, Chat, ModelInfo, Msg, Settings, Topic, UpdateState } from '../../shared/types';
import { api, onEvent } from './api';
import logo from './assets/icon.png';
import { ChatView } from './Chat';
import { ContextPanel, LogPanel } from './Panels';
import { SettingsModal } from './Settings';

export interface Toast {
  id: number;
  text: string;
  err?: boolean;
}
let toastId = 1;

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Msg[]>([]);
  const [stream, setStream] = useState({ text: '', thinking: '' });
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [usage, setUsage] = useState({ used: 0, limit: 0 });
  const [panel, setPanel] = useState<'context' | 'log' | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ollama, setOllama] = useState<any>({ running: false, loaded: [] });
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle', current: '' });
  const [updateDismissed, setUpdateDismissed] = useState('');
  useEffect(() => {
    void api('app:info').then((i) => setUpdate({ ...i.update, current: i.version }));
  }, []);
  const [ctxVersion, setCtxVersion] = useState(0);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const toast = useCallback((text: string, err = false) => {
    const id = toastId++;
    setToasts((t) => [...t, { id, text, err }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), err ? 8000 : 4000);
  }, []);
  const guard = useCallback(<T,>(p: Promise<T>) => p.catch((e) => (toast(e.message, true), undefined as T | undefined)), [toast]);

  const reload = useCallback(async () => {
    const [t, c] = await Promise.all([api<Topic[]>('topics:list'), api<Chat[]>('chats:list')]);
    setTopics(t);
    setChats(c);
    return c;
  }, []);
  const loadModels = useCallback(async () => {
    const r = await api<{ models: ModelInfo[]; errors: Record<string, string> }>('models:list');
    setModels(r.models);
    setModelErrors(r.errors);
  }, []);
  const refreshUsage = useCallback(async (id: string | null = activeRef.current) => {
    if (!id) return;
    const m = await api('chats:measure', id).catch(() => null);
    if (m && activeRef.current === id) setUsage({ used: m.used, limit: m.limit });
  }, []);

  const openChat = useCallback(
    async (id: string | null) => {
      setActiveId(id);
      activeRef.current = id;
      setStream({ text: '', thinking: '' });
      setStatus('');
      setMessages(id ? await api<Msg[]>('chats:messages', id) : []);
      void refreshUsage(id);
    },
    [refreshUsage],
  );

  // initial load
  useEffect(() => {
    void (async () => {
      const s = await api<Settings>('settings:get');
      setSettings(s);
      document.documentElement.dataset.theme = s.theme;
      const c = await reload();
      await loadModels();
      if (c[0]) await openChat(c[0].id);
    })();
  }, []);

  // Ollama status poll (cheap local call)
  useEffect(() => {
    const tick = () => api('ollama:status').then(setOllama).catch(() => {});
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, []);
  // models appear once Ollama comes up
  const wasRunning = useRef(false);
  useEffect(() => {
    if (ollama.running && !wasRunning.current) void loadModels();
    wasRunning.current = ollama.running;
  }, [ollama.running]);

  // agent events
  useEffect(
    () =>
      onEvent((e: AgentEvent) => {
        const active = e.chatId === activeRef.current;
        switch (e.type) {
          case 'start':
            setRunning((r) => new Set(r).add(e.chatId));
            break;
          case 'delta':
            if (active) setStream((s) => ({ ...s, text: s.text + e.text }));
            break;
          case 'thinking':
            if (active) setStream((s) => ({ ...s, thinking: s.thinking + e.text }));
            break;
          case 'reset-stream':
            if (active) setStream({ text: '', thinking: '' });
            break;
          case 'message':
            if (active) setMessages((m) => (m.some((x) => x.id === e.message.id) ? m : [...m, e.message]));
            break;
          case 'status':
            if (active) setStatus(e.text);
            break;
          case 'approval':
            setApprovals((a) => [...a, e.request]);
            break;
          case 'approval-done':
            setApprovals((a) => a.filter((x) => x.id !== e.id));
            break;
          case 'usage':
            if (active) setUsage({ used: e.used, limit: e.limit });
            break;
          case 'chat-updated':
            void reload();
            if (active) void api<Msg[]>('chats:messages', e.chatId).then((m) => activeRef.current === e.chatId && setMessages(m));
            break;
          case 'update':
            setUpdate(e.state);
            break;
          case 'done':
            setRunning((r) => {
              const n = new Set(r);
              n.delete(e.chatId);
              return n;
            });
            setApprovals((a) => a.filter((x) => x.chatId !== e.chatId));
            if (active) {
              setStream({ text: '', thinking: '' });
              setStatus('');
            }
            void reload();
            break;
        }
      }),
    [reload],
  );

  const newChat = async (topicId: string | null) => {
    const c = await guard(api<Chat>('chats:create', topicId));
    if (!c) return;
    await reload();
    await openChat(c.id);
    setPanel('context'); // new chats start by choosing context
  };
  const updateChat = async (id: string, patch: Partial<Chat>) => {
    await guard(api('chats:update', id, patch));
    await reload();
    if (id === activeRef.current) void refreshUsage(id);
  };
  const saveSettings = async (patch: Partial<Settings>) => {
    const s = await guard(api<Settings>('settings:set', patch));
    if (s) {
      setSettings(s);
      document.documentElement.dataset.theme = s.theme;
      void refreshUsage();
    }
  };
  const pickFolder = async () => {
    const s = await guard(api<Settings | null>('folder:pick'));
    if (s) {
      setSettings(s);
      setCtxVersion((v) => v + 1);
      toast(`Work folder: ${s.workFolder}`);
    }
  };

  if (!settings) return <div className="empty">Loading…</div>;
  const chat = chats.find((c) => c.id === activeId) || null;

  return (
    <div className="app">
      <Sidebar
        settings={settings}
        topics={topics}
        chats={chats}
        activeId={activeId}
        running={running}
        ollama={ollama}
        version={update.current}
        onOpen={openChat}
        onNew={newChat}
        onPickFolder={pickFolder}
        onSettings={() => setShowSettings(true)}
        onChanged={async () => {
          const c = await reload();
          setCtxVersion((v) => v + 1);
          if (activeId && !c.some((x) => x.id === activeId)) await openChat(c[0]?.id || null);
        }}
        updateChat={updateChat}
        guard={guard}
      />
      <div className="main">
        {chat ? (
          <ChatView
            key={chat.id}
            chat={chat}
            messages={messages}
            stream={stream}
            running={running.has(chat.id)}
            status={status}
            approvals={approvals.filter((a) => a.chatId === chat.id)}
            usage={usage}
            models={models}
            modelErrors={modelErrors}
            settings={settings}
            panel={panel}
            setPanel={setPanel}
            update={(p) => updateChat(chat.id, p)}
            reloadMessages={async () => {
              setMessages(await api<Msg[]>('chats:messages', chat.id));
              void refreshUsage(chat.id);
            }}
            refreshModels={loadModels}
            toast={toast}
          />
        ) : (
          <div className="empty">
            <img src={logo} alt="" width={96} height={96} />
            <h2 style={{ margin: 0, color: 'var(--text)' }}>Pal Pal</h2>
            <div>Start a chat to talk to a local Ollama model or an OpenRouter model.</div>
            <button className="primary" onClick={() => newChat(null)}>
              New chat
            </button>
          </div>
        )}
      </div>
      {chat && panel === 'context' && <ContextPanel key={chat.id + ctxVersion} chat={chat} update={(p) => updateChat(chat.id, p)} usage={usage} onClose={() => setPanel(null)} />}
      {chat && panel === 'log' && <LogPanel key={chat.id} chatId={chat.id} running={running.has(chat.id)} onClose={() => setPanel(null)} />}
      {showSettings && (
        <SettingsModal
          settings={settings}
          models={models}
          save={saveSettings}
          onClose={() => {
            setShowSettings(false);
            void loadModels();
            void refreshUsage();
            setCtxVersion((v) => v + 1);
          }}
          pickFolder={pickFolder}
          toast={toast}
        />
      )}
      {(update.status === 'available' || update.status === 'downloading' || update.status === 'ready') && updateDismissed !== update.latest && (
        <UpdatePrompt update={update} onLater={() => setUpdateDismissed(update.latest || 'x')} busy={running.size > 0} />
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={'toast' + (t.err ? ' err' : '')}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ sidebar
function Sidebar(p: {
  settings: Settings;
  topics: Topic[];
  chats: Chat[];
  activeId: string | null;
  running: Set<string>;
  ollama: any;
  version: string;
  onOpen: (id: string) => void;
  onNew: (topicId: string | null) => void;
  onPickFolder: () => void;
  onSettings: () => void;
  onChanged: () => Promise<void>;
  updateChat: (id: string, patch: Partial<Chat>) => Promise<void>;
  guard: <T>(p: Promise<T>) => Promise<T | undefined>;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [hits, setHits] = useState<any[]>([]);
  const [editing, setEditing] = useState<{ kind: 'topic' | 'chat' | 'new-topic'; id?: string; value: string } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [filesFor, setFilesFor] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) return setHits([]);
    const t = setTimeout(() => api('chats:search', query, filter).then(setHits).catch(() => setHits([])), 180);
    return () => clearTimeout(t);
  }, [query, filter, p.chats]);

  const commitEdit = async () => {
    if (!editing) return;
    const v = editing.value.trim();
    setEditing(null);
    if (!v) return;
    if (editing.kind === 'new-topic') await p.guard(api('topics:create', v));
    else if (editing.kind === 'topic') await p.guard(api('topics:rename', editing.id, v));
    else await p.guard(api('chats:update', editing.id, { title: v }));
    await p.onChanged();
  };
  const editor = (
    <input
      type="text"
      autoFocus
      className="grow"
      value={editing?.value || ''}
      onChange={(e) => setEditing((s) => s && { ...s, value: e.target.value })}
      onBlur={commitEdit}
      onKeyDown={(e) => (e.key === 'Enter' ? commitEdit() : e.key === 'Escape' && setEditing(null))}
      onClick={(e) => e.stopPropagation()}
    />
  );

  const drop = async (e: React.DragEvent, topicId: string | null) => {
    e.preventDefault();
    setDropOn(null);
    const id = e.dataTransfer.getData('text/chat-id');
    if (id) await p.updateChat(id, { topicId });
  };
  const section = (topicId: string | null, name: string, topic?: Topic) => {
    const key = topicId || 'none';
    const list = p.chats.filter((c) => (c.topicId || null) === topicId);
    const isCollapsed = collapsed.has(key);
    return (
      <div key={key}>
        <div
          className={'topic-head' + (dropOn === key ? ' drop' : '')}
          onDragOver={(e) => (e.preventDefault(), setDropOn(key))}
          onDragLeave={() => setDropOn(null)}
          onDrop={(e) => drop(e, topicId)}
        >
          <span
            style={{ cursor: 'pointer', width: 12 }}
            onClick={() =>
              setCollapsed((s) => {
                const n = new Set(s);
                n.has(key) ? n.delete(key) : n.add(key);
                return n;
              })
            }
          >
            {isCollapsed ? '▸' : '▾'}
          </span>
          {editing?.kind === 'topic' && editing.id === topicId ? editor : <span className="grow ellipsis">{name}</span>}
          <span className="muted">{list.length}</span>
          <span className="acts">
            <button className="ghost" title="New chat here" onClick={() => p.onNew(topicId)}>
              +
            </button>
            {topic && (
              <>
                <button className="ghost" title="Topic context files" onClick={() => setFilesFor(topic.id)}>
                  📎{topic.files.length || ''}
                </button>
                <button className="ghost" title="Rename topic" onClick={() => setEditing({ kind: 'topic', id: topic.id, value: topic.name })}>
                  ✎
                </button>
                <button
                  className="ghost"
                  title="Delete topic"
                  onClick={async () => {
                    if (!confirm(`Delete topic "${topic.name}"? Its ${list.length} chat(s) are kept and move to "No topic".`)) return;
                    await p.guard(api('topics:delete', topic.id));
                    await p.onChanged();
                  }}
                >
                  🗑
                </button>
              </>
            )}
          </span>
        </div>
        {!isCollapsed &&
          list.map((c) => (
            <div
              key={c.id}
              className={'chat-item' + (c.id === p.activeId ? ' active' : '')}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/chat-id', c.id)}
              onClick={() => p.onOpen(c.id)}
            >
              {p.running.has(c.id) && <span className="dot run" />}
              {editing?.kind === 'chat' && editing.id === c.id ? editor : <span className="grow ellipsis" title={c.title}>{c.title}</span>}
              <span className="acts">
                <button className="ghost" title="Rename" onClick={(e) => (e.stopPropagation(), setEditing({ kind: 'chat', id: c.id, value: c.title }))}>
                  ✎
                </button>
                <button
                  className="ghost"
                  title="Delete chat"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete chat "${c.title}" and its log and checkpoints?`)) return;
                    await p.guard(api('chats:delete', c.id));
                    await p.onChanged();
                  }}
                >
                  🗑
                </button>
              </span>
            </div>
          ))}
      </div>
    );
  };

  const loaded = p.ollama.loaded?.[0];
  const filesTopic = p.topics.find((t) => t.id === filesFor);
  return (
    <div className="sidebar">
      <div className="head">
        <div className="row">
          <img src={logo} alt="" width={26} height={26} />
          <strong>Pal Pal</strong>
          <span className="grow muted small" title="Installed version">
            {p.version ? 'v' + p.version : ''}
          </span>
          <button className="ghost" title="Settings" onClick={p.onSettings}>
            ⚙
          </button>
        </div>
        <div className="row folder" title={p.settings.workFolder || 'No work folder selected'}>
          <span>📁</span>
          <span className="grow ellipsis">{p.settings.workFolder ? p.settings.workFolder.split(/[\\/]/).filter(Boolean).pop() : <em>No work folder</em>}</span>
          <button className="ghost small" onClick={p.onPickFolder}>
            {p.settings.workFolder ? 'Switch' : 'Choose'}
          </button>
        </div>
        <div className="row">
          <button className="primary grow" onClick={() => p.onNew(null)}>
            + New chat
          </button>
          <button title="New topic" onClick={() => setEditing({ kind: 'new-topic', value: '' })}>
            + Topic
          </button>
        </div>
        {editing?.kind === 'new-topic' && <div className="row">{editor}</div>}
        <div className="row">
          <input type="text" className="grow" placeholder="Search chats…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button className="ghost" onClick={() => setQuery('')}>
              ✕
            </button>
          )}
        </div>
        {query.trim() && (
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All topics</option>
            <option value="none">No topic</option>
            {p.topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="list">
        {query.trim() ? (
          hits.length === 0 ? (
            <div className="muted small" style={{ padding: 8 }}>
              No chats match “{query}”.
            </div>
          ) : (
            hits.map((h) => (
              <div key={h.chatId} className="hit" onClick={() => p.onOpen(h.chatId)}>
                <div className="row">
                  <span className="grow ellipsis">{h.title}</span>
                  <span className="badge">{h.topicName}</span>
                </div>
                {h.snippets.map((s: string, i: number) => (
                  <div key={i} className="snip">
                    <Highlight text={s} q={query} />
                  </div>
                ))}
                {h.snippets.length === 0 && <div className="snip">Title match</div>}
              </div>
            ))
          )
        ) : (
          <>
            {p.topics.map((t) => section(t.id, t.name, t))}
            {section(null, 'No topic')}
          </>
        )}
      </div>
      <div className="status-bar" title={p.ollama.running ? `Ollama ${p.ollama.version || ''}` : 'Ollama is not reachable'}>
        <div className="row">
          <span className={'dot ' + (p.ollama.running ? 'ok' : 'err')} />
          <span className="grow ellipsis">
            {!p.ollama.running ? 'Ollama not running' : loaded ? loaded.name : 'Ollama ready - no model loaded'}
          </span>
        </div>
        {p.ollama.running &&
          p.ollama.loaded.map((m: any) => {
            const ram = Math.max(0, m.sizeMB - m.vramMB);
            return (
              <div key={m.name} className="muted" style={{ paddingLeft: 16 }}>
                {p.ollama.loaded.length > 1 && m.name + ': '}VRAM {(m.vramMB / 1024).toFixed(1)} GB
                {ram > 50 ? <span style={{ color: 'var(--warn)' }}> · RAM {(ram / 1024).toFixed(1)} GB (spilled)</span> : ' · RAM 0'}
                {m.ctx ? ` · ctx ${m.ctx}` : ''}
              </div>
            );
          })}
      </div>
      {filesTopic && (
        <div className="overlay" onClick={() => setFilesFor(null)}>
          <div className="modal smallm" onClick={(e) => e.stopPropagation()}>
            <div className="mhead">
              <span className="grow">Context files for topic “{filesTopic.name}”</span>
              <button className="ghost" onClick={() => setFilesFor(null)}>
                ✕
              </button>
            </div>
            <div className="pane">
              <div className="muted small" style={{ marginBottom: 8 }}>
                New chats in this topic start with these files checked. Each chat can uncheck them in its Context panel. Files stay where they are on disk.
              </div>
              {filesTopic.files.length === 0 && <div className="muted">No files attached.</div>}
              {filesTopic.files.map((f) => (
                <div key={f.id} className="row" style={{ padding: '2px 0' }}>
                  <span className="grow ellipsis" title={f.path}>
                    {f.path}
                  </span>
                  <button
                    className="ghost"
                    onClick={async () => {
                      await p.guard(api('topics:removeFile', f.id));
                      await p.onChanged();
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                style={{ marginTop: 10 }}
                onClick={async () => {
                  const paths = await p.guard(api<string[]>('files:pick'));
                  if (paths?.length) {
                    await p.guard(api('topics:addFiles', filesTopic.id, paths));
                    await p.onChanged();
                  }
                }}
              >
                + Add files…
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function UpdatePrompt({ update, onLater, busy }: { update: UpdateState; onLater: () => void; busy: boolean }) {
  return (
    <div className="overlay">
      <div className="modal smallm">
        <div className="mhead">
          <img src={logo} alt="" width={28} height={28} style={{ marginRight: 8 }} />A new version of Pal Pal is available
        </div>
        <div className="pane">
          <p style={{ marginTop: 0 }}>
            Version <b>{update.latest}</b> is available. You have version <b>{update.current}</b>. Would you like to update now?
          </p>
          {update.notes && <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto', background: 'var(--bg)', padding: 8, borderRadius: 6, fontSize: 12 }}>{update.notes}</pre>}
          {update.status === 'downloading' && (
            <div className="meter" style={{ margin: '10px 0' }}>
              <span className="bar" style={{ width: '100%' }}>
                <div style={{ width: (update.percent || 0) + '%' }} />
              </span>
              {update.percent || 0}%
            </div>
          )}
          {update.status === 'ready' && (
            <p>
              The update has downloaded. Pal Pal will close, install it and reopen.{busy ? ' A chat is still running and will be stopped.' : ''}
            </p>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            {update.status !== 'downloading' && <button onClick={onLater}>Later</button>}
            {update.status === 'available' && (
              <button className="primary" onClick={() => void api('update:download')}>
                Update now
              </button>
            )}
            {update.status === 'downloading' && <button disabled>Downloading…</button>}
            {update.status === 'ready' && (
              <button className="primary" onClick={() => void api('update:install')}>
                Restart and install
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.trim().length)}</mark>
      {text.slice(i + q.trim().length)}
    </>
  );
}

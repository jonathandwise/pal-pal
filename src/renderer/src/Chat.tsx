import { memo, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ApprovalMode, ApprovalRequest, Chat, Checkpoint, Effort, ModelInfo, Msg, OutsideAccess, Settings, ToolCall } from '../../shared/types';
import { api, fmtTokens } from './api';

function Pre(props: any) {
  const ref = useRef<HTMLPreElement>(null);
  const [done, setDone] = useState(false);
  return (
    <pre ref={ref}>
      {props.children}
      <button
        className="copy"
        onClick={() => {
          void navigator.clipboard.writeText(ref.current?.querySelector('code')?.innerText || '');
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }}
      >
        {done ? 'Copied' : 'Copy'}
      </button>
    </pre>
  );
}
const mdComponents = { pre: Pre, a: (p: any) => <a {...p} target="_blank" rel="noreferrer" /> };
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

const argPreview = (args: Record<string, unknown>) => {
  const v = args.path ?? args.command ?? args.query ?? args.url ?? args.fact ?? Object.values(args)[0];
  const s = typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
  return s.length > 90 ? s.slice(0, 90) + '…' : s;
};

const Step = memo(function Step({ call, result }: { call: ToolCall; result?: Msg }) {
  const blocked = result?.kind === 'blocked';
  const icon = !result ? '⏳' : blocked ? '⛔' : result.isError ? '✗' : '✓';
  const color = !result ? 'var(--muted)' : result.isError ? 'var(--err)' : 'var(--ok)';
  return (
    <details className={'step' + (blocked ? ' blocked' : '')}>
      <summary>
        <span style={{ color }}>{icon}</span>
        <strong>{call.name}</strong>
        <span className="muted grow ellipsis">{argPreview(call.args)}</span>
        {blocked && <span className="badge err">Blocked by guardrail</span>}
      </summary>
      <div className="body">
        <div className="muted small">Arguments</div>
        <pre>{JSON.stringify(call.args, null, 2)}</pre>
        <div className="muted small">Result</div>
        <pre>{result ? result.content : 'Running…'}</pre>
      </div>
    </details>
  );
});

const MessageItem = memo(function MessageItem({ m, results, canRollback, onRollback }: { m: Msg; results: Map<string, Msg>; canRollback: boolean; onRollback: (m: Msg) => void }) {
  if (m.role === 'user')
    return (
      <div className="msg user" style={m.compacted ? { opacity: 0.55 } : undefined}>
        <div className="bubble">
          {m.content}
          {m.images?.length ? (
            <div>
              {m.images.map((src, i) => (
                <img key={i} className="att" src={src} />
              ))}
            </div>
          ) : null}
        </div>
        <div className="meta">
          <span>Turn {m.turn}</span>
          {m.compacted && <span>summarized</span>}
          {canRollback && (
            <button className="ghost small" title="Restore files changed from this turn onward and remove this turn and later ones" onClick={() => onRollback(m)}>
              ↶ Roll back to before this turn
            </button>
          )}
        </div>
      </div>
    );
  if (m.role === 'assistant')
    return (
      <div className="msg assistant" style={m.compacted ? { opacity: 0.55 } : undefined}>
        {m.thinking && (
          <details className="step">
            <summary>
              <span className="muted">💭 Thinking</span>
            </summary>
            <div className="body">
              <div className="thinking">{m.thinking}</div>
            </div>
          </details>
        )}
        {m.content && <Markdown text={m.content} />}
        {m.toolCalls?.map((c) => <Step key={c.id} call={c} result={results.get(c.id)} />)}
        {m.usage && (m.usage.prompt || m.usage.ms) ? (
          <div className="meta">
            {m.usage.prompt ? <span>{m.usage.prompt} in / {m.usage.completion ?? '?'} out tokens</span> : null}
            {m.usage.ms ? <span>{(m.usage.ms / 1000).toFixed(1)}s</span> : null}
            {m.usage.completion && m.usage.ms ? <span>{((m.usage.completion / m.usage.ms) * 1000).toFixed(1)} tok/s</span> : null}
          </div>
        ) : null}
      </div>
    );
  if (m.role === 'tool')
    return (
      <div className="msg">
        <Step call={{ id: m.id, name: m.toolName || 'tool', args: {} }} result={m} />
      </div>
    );
  if (m.kind === 'compaction')
    return (
      <div className="msg">
        <details className="note compaction">
          <summary style={{ cursor: 'pointer' }}>🗜 Older turns were summarized - click to see the summary</summary>
          <Markdown text={m.content} />
        </details>
      </div>
    );
  return (
    <div className="msg">
      <div className={'note ' + (m.kind || 'info')}>
        <Markdown text={m.content} />
      </div>
    </div>
  );
});

function ApprovalCard({ a, chatId }: { a: ApprovalRequest; chatId: string }) {
  const answer = (ok: boolean) => void api('agent:approve', chatId, a.id, ok);
  return (
    <div className="approval">
      <div className="row">
        <strong className="grow">Approval needed: {a.title}</strong>
        {a.outside && <span className="badge warn">Outside work folder</span>}
      </div>
      {a.diff ? (
        <div className="diff">
          <div className="del">
            <div className="muted small">Before</div>
            <pre>{a.diff.before || '(nothing - new file)'}</pre>
          </div>
          <div className="add">
            <div className="muted small">After</div>
            <pre>{a.diff.after || '(empty)'}</pre>
          </div>
        </div>
      ) : (
        <pre>{a.detail}</pre>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button onClick={() => answer(false)}>Deny</button>
        <button className="primary" autoFocus onClick={() => answer(true)}>
          Approve
        </button>
      </div>
    </div>
  );
}

function ModelPicker({ chat, models, errors, update, refresh }: { chat: Chat; models: ModelInfo[]; errors: Record<string, string>; update: (p: Partial<Chat>) => void; refresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const cur = models.find((m) => m.provider === chat.provider && m.id === chat.model);
  const groups = useMemo(() => {
    const f = q.trim().toLowerCase();
    const match = (m: ModelInfo) => !f || m.name.toLowerCase().includes(f) || m.id.toLowerCase().includes(f);
    return [
      { key: 'ollama', label: 'Ollama (local)', items: models.filter((m) => m.provider === 'ollama' && match(m)) },
      { key: 'openrouter', label: 'OpenRouter', items: models.filter((m) => m.provider === 'openrouter' && match(m)) },
    ];
  }, [models, q]);
  return (
    <span className="pop-wrap">
      <button onClick={() => (setOpen(!open), setQ(''))} title="Model" style={{ maxWidth: 260 }} className="ellipsis">
        {cur ? cur.name : chat.model ? `⚠ ${chat.model}` : 'Select model'} ▾
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 20 }} onClick={() => setOpen(false)} />
          <div className="pop models">
            <div className="row">
              <input type="text" autoFocus className="grow" placeholder="Filter models…" value={q} onChange={(e) => setQ(e.target.value)} />
              <button title="Reload model lists" onClick={() => void refresh()}>
                ⟳
              </button>
            </div>
            <div className="items">
              {groups.map((g) => (
                <div key={g.key}>
                  <div className="group">
                    {g.label} ({g.items.length})
                  </div>
                  {errors[g.key] && <div className="small" style={{ color: 'var(--warn)', padding: '0 8px 4px' }}>{errors[g.key]}</div>}
                  {g.items.slice(0, 400).map((m) => (
                    <div
                      key={m.id}
                      className={'item' + (cur === m ? ' sel' : '')}
                      onClick={() => {
                        update({ model: m.id, provider: m.provider });
                        setOpen(false);
                      }}
                    >
                      <span className="grow ellipsis" title={m.id}>
                        {m.name}
                      </span>
                      {m.paramSize && <span className="tag">{m.paramSize}</span>}
                      {m.quant && <span className="tag">{m.quant}</span>}
                      <span className="tag">{fmtTokens(m.contextLength)}</span>
                      {m.vision && <span className="tag" title="Accepts images">👁</span>}
                      {m.tools && <span className="tag" title="Native tool calling">🔧</span>}
                      {m.thinking && <span className="tag" title="Thinking / reasoning control">💭</span>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </span>
  );
}

export function ChatView(p: {
  chat: Chat;
  messages: Msg[];
  stream: { text: string; thinking: string };
  running: boolean;
  status: string;
  approvals: ApprovalRequest[];
  usage: { used: number; limit: number };
  models: ModelInfo[];
  modelErrors: Record<string, string>;
  settings: Settings;
  panel: 'context' | 'log' | null;
  setPanel: (p: 'context' | 'log' | null) => void;
  update: (patch: Partial<Chat>) => Promise<void>;
  reloadMessages: () => Promise<void>;
  refreshModels: () => Promise<void>;
  toast: (t: string, err?: boolean) => void;
}) {
  const { chat } = p;
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [outside, setOutside] = useState<OutsideAccess>({ read: false, write: false, modify: false });
  const [outsideOpen, setOutsideOpen] = useState(false);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [hw, setHw] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const model = p.models.find((m) => m.provider === chat.provider && m.id === chat.model);

  useEffect(() => {
    void api<OutsideAccess>('outside:get', chat.id).then(setOutside);
  }, [chat.id]);
  useEffect(() => {
    if (!p.running) void api<Checkpoint[]>('checkpoints:list', chat.id).then(setCheckpoints);
  }, [chat.id, p.running, p.messages.length]);
  useEffect(() => {
    setHw(null);
    if (model?.provider === 'ollama') void api('hw:defaults', model.id, chat.effort).then(setHw).catch(() => {});
  }, [model?.id, model?.provider, chat.effort, p.models]);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [p.messages, p.stream, p.approvals.length]);

  const results = useMemo(() => {
    const map = new Map<string, Msg>();
    for (const m of p.messages) if (m.role === 'tool' && m.toolCallId) map.set(m.toolCallId, m);
    return map;
  }, [p.messages]);
  const claimed = useMemo(() => {
    const s = new Set<string>();
    for (const m of p.messages) for (const c of m.toolCalls || []) s.add(c.id);
    return s;
  }, [p.messages]);
  const maxCpTurn = checkpoints.reduce((m, c) => Math.max(m, c.turn), 0);

  const addImageFiles = (files: File[]) => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > 12 * 1024 * 1024) {
        p.toast(`${f.name || 'Image'} is larger than 12 MB and was skipped.`, true);
        continue;
      }
      const r = new FileReader();
      r.onload = () => setImages((im) => [...im, String(r.result)]);
      r.readAsDataURL(f);
    }
  };
  const send = () => {
    const t = text.trim();
    if ((!t && !images.length) || p.running) return;
    if (!model) return p.toast('Select a model first.', true);
    stick.current = true;
    void api('agent:send', chat.id, t, images);
    setText('');
    setImages([]);
  };
  const rollback = async (m: Msg) => {
    const cps = checkpoints.filter((c) => c.turn >= m.turn);
    const files = new Set(cps.flatMap((c) => c.files));
    if (!confirm(`Roll back to before turn ${m.turn}?\n\n${files.size} file(s) changed since then will be restored to their earlier state (deleted files come back, newly created files are removed), and turn ${m.turn} and everything after it is removed from this chat.\n\nChanges made by shell commands cannot be undone.`)) return;
    try {
      const r = await api('checkpoints:rollback', chat.id, m.turn);
      p.toast(`Rolled back: ${r.restored.length} restored, ${r.removed.length} removed${r.failed.length ? `, ${r.failed.length} failed: ${r.failed.join('; ')}` : ''}.`, r.failed.length > 0);
      setText(m.content);
      await p.reloadMessages();
    } catch (e: any) {
      p.toast(e.message, true);
    }
  };
  const compact = async () => {
    setBusy('Compacting…');
    const r = await api('agent:compact', chat.id).catch((e) => ({ ok: false, message: e.message }));
    setBusy('');
    if (!r.ok) p.toast(r.message, true);
    await p.reloadMessages();
  };
  const setOut = async (patch: Partial<OutsideAccess>) => setOutside(await api('outside:set', chat.id, { ...outside, ...patch }));

  const pct = p.usage.limit ? p.usage.used / p.usage.limit : 0;
  const outsideOn = (['read', 'write', 'modify'] as const).filter((k) => outside[k]);
  const visionWarn = images.length > 0 && model && !model.vision;
  const noToolsNative = chat.toolsEnabled && model && !model.tools;

  return (
    <>
      <div className="chat-head">
        <span className="grow ellipsis" style={{ fontWeight: 600 }} title={chat.title}>
          {chat.title}
        </span>
        {outsideOn.length > 0 && (
          <span className="badge warn" title="This chat may touch files outside the work folder. Resets for new chats.">
            ⚠ Outside-folder access ON: {outsideOn.join(', ')}
          </span>
        )}
        {chat.approvalMode === 'full-auto' && <span className="badge err">Full auto</span>}
        <button className={p.panel === 'context' ? 'primary' : ''} onClick={() => p.setPanel(p.panel === 'context' ? null : 'context')}>
          Context
        </button>
        <button onClick={compact} disabled={p.running || !!busy} title="Summarize older turns to free context">
          {busy || 'Compact chat'}
        </button>
        <button className={p.panel === 'log' ? 'primary' : ''} onClick={() => p.setPanel(p.panel === 'log' ? null : 'log')}>
          View log
        </button>
      </div>

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {p.messages.length === 0 && !p.running && (
          <div className="empty">
            <div>
              {p.settings.workFolder ? (
                <>
                  Work folder: <code>{p.settings.workFolder}</code>
                </>
              ) : (
                'No work folder selected - file and shell tools are off until you choose one in the sidebar.'
              )}
            </div>
            <div className="small">Use the Context panel to choose which files this chat can see. Enter sends, Shift+Enter adds a line.</div>
          </div>
        )}
        {p.messages.map((m) =>
          m.role === 'tool' && m.toolCallId && claimed.has(m.toolCallId) ? null : (
            <MessageItem key={m.id} m={m} results={results} canRollback={!p.running && m.role === 'user' && maxCpTurn >= m.turn} onRollback={rollback} />
          ),
        )}
        {p.running && (
          <div className="msg assistant">
            {p.stream.thinking && <div className="thinking">{p.stream.thinking}</div>}
            {p.stream.text && <Markdown text={p.stream.text} />}
            <div className="meta">
              <span className="dot run" />
              <span>{p.status || (p.stream.text ? 'Writing…' : p.stream.thinking ? 'Thinking…' : p.approvals.length ? 'Waiting for your approval…' : 'Working…')}</span>
            </div>
          </div>
        )}
      </div>

      <div className="composer">
        {p.approvals.map((a) => (
          <ApprovalCard key={a.id} a={a} chatId={chat.id} />
        ))}
        <div className="inner">
          {images.length > 0 && (
            <div className="thumbs">
              {images.map((src, i) => (
                <div className="thumb" key={i}>
                  <img src={src} />
                  <button onClick={() => setImages((im) => im.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
            </div>
          )}
          <textarea
            rows={2}
            placeholder={model ? `Message ${model.name}…` : 'Select a model to start…'}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(240, e.target.scrollHeight + 2) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()!).filter(Boolean);
              if (files.length) {
                e.preventDefault();
                addImageFiles(files);
              }
            }}
          />
          <div className="controls">
            <ModelPicker chat={chat} models={p.models} errors={p.modelErrors} update={p.update} refresh={p.refreshModels} />
            <select title="Effort" value={chat.effort} onChange={(e) => p.update({ effort: e.target.value as Effort })}>
              <option value="low">Effort: Low</option>
              <option value="medium">Effort: Medium</option>
              <option value="high">Effort: High</option>
            </select>
            <select title="Approval mode" value={chat.approvalMode} onChange={(e) => p.update({ approvalMode: e.target.value as ApprovalMode })}>
              <option value="ask">Ask every time</option>
              <option value="auto-edits">Auto-approve edits</option>
              <option value="full-auto">Full auto</option>
            </select>
            <label className="row" style={{ gap: 4 }} title="Let the model use tools (files, shell, web, MCP). Turn off for plain chat.">
              <input type="checkbox" checked={chat.toolsEnabled} onChange={(e) => p.update({ toolsEnabled: e.target.checked })} />
              Tools
            </label>
            <span className="pop-wrap">
              <button onClick={() => setOutsideOpen(!outsideOpen)} style={outsideOn.length ? { borderColor: 'var(--warn)', color: 'var(--warn)' } : undefined}>
                Outside access{outsideOn.length ? ` (${outsideOn.length})` : ''} ▾
              </button>
              {outsideOpen && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 20 }} onClick={() => setOutsideOpen(false)} />
                  <div className="pop" style={{ width: 300 }}>
                    <div className="small muted" style={{ marginBottom: 6 }}>
                      Files and folders <b>outside</b> the work folder. Applies to this chat only and is off again for every new chat.
                    </div>
                    {(
                      [
                        ['read', 'Read', 'read and list files'],
                        ['write', 'Write', 'create new files'],
                        ['modify', 'Modify', 'change or delete existing files'],
                      ] as const
                    ).map(([k, label, hint]) => (
                      <label key={k} className="row" style={{ padding: '3px 0' }}>
                        <input type="checkbox" checked={outside[k]} onChange={(e) => setOut({ [k]: e.target.checked })} />
                        <span>
                          <b>{label}</b> <span className="muted">- {hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </span>
            <button title="Attach images" onClick={() => fileInput.current?.click()}>
              🖼 Image
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                addImageFiles([...(e.target.files || [])]);
                e.target.value = '';
              }}
            />
            <span className="grow" />
            <span
              className={'meter' + (pct > p.settings.compactThreshold ? ' crit' : pct > p.settings.warnThreshold ? ' warn' : '')}
              title={`Context in use: about ${p.usage.used} of ${p.usage.limit} tokens (system prompt + checked context + tools + history). Open the Context panel for the breakdown.`}
            >
              <span className="bar">
                <div style={{ width: Math.min(100, pct * 100) + '%' }} />
              </span>
              {fmtTokens(p.usage.used)} / {p.usage.limit ? fmtTokens(p.usage.limit) : '?'}
            </span>
            {p.running ? (
              <button className="danger" onClick={() => api('agent:stop', chat.id)}>
                ■ Stop
              </button>
            ) : (
              <button className="primary" onClick={send} disabled={!text.trim() && !images.length}>
                Send
              </button>
            )}
          </div>
          {visionWarn && <div className="inline-warn">⚠ {model!.name} cannot take images. Pick a model marked 👁, or the image will not be sent.</div>}
          {noToolsNative && <div className="inline-warn">⚠ {model!.name} has no native tool calling; Pal Pal falls back to text-based tool calls (less reliable). Untick Tools for plain chat.</div>}
          {hw?.defaults?.warning && <div className="inline-warn">⚠ {hw.defaults.warning}</div>}
          {hw && !hw.defaults.warning && (
            <div className="muted small" style={{ marginTop: 5 }}>
              Ollama: context {hw.ctx} tokens · est. {(hw.defaults.estVramMB / 1024).toFixed(1)} GB · fits in VRAM
            </div>
          )}
        </div>
      </div>
    </>
  );
}

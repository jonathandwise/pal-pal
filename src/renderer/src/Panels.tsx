import { useEffect, useMemo, useRef, useState } from 'react';
import type { Chat, ContextNode } from '../../shared/types';
import { api, fmtTokens } from './api';

const leaves = (n: ContextNode): ContextNode[] => (n.kind === 'file' ? [n] : (n.children || []).flatMap(leaves));

function TreeNode({ node, depth, sel, toggle }: { node: ContextNode; depth: number; sel: Set<string>; toggle: (ids: string[], on: boolean) => void }) {
  const [open, setOpen] = useState(node.kind === 'group');
  const ls = useMemo(() => leaves(node), [node]);
  const n = ls.reduce((c, l) => c + (sel.has(l.id) ? 1 : 0), 0);
  const selTokens = ls.reduce((c, l) => c + (sel.has(l.id) ? l.tokens : 0), 0);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = n > 0 && n < ls.length;
  }, [n, ls.length]);
  const isFile = node.kind === 'file';
  return (
    <div>
      <div className="tree-row" style={{ paddingLeft: depth * 16 }}>
        <span className="tw" onClick={() => !isFile && setOpen(!open)}>
          {isFile ? '' : open ? '▾' : '▸'}
        </span>
        <input ref={box} type="checkbox" disabled={ls.length === 0 || node.missing} checked={ls.length > 0 && n === ls.length} onChange={(e) => toggle(ls.map((l) => l.id), e.target.checked)} />
        <span className="ellipsis" title={node.path || node.label} style={{ fontWeight: isFile ? 400 : 600, cursor: isFile ? 'default' : 'pointer', color: node.missing ? 'var(--err)' : undefined }} onClick={() => !isFile && setOpen(!open)}>
          {isFile ? '' : '📁 '}
          {node.label}
          {node.missing ? ' (missing)' : ''}
        </span>
        <span className="tok">{isFile ? `~${fmtTokens(node.tokens)}` : `${fmtTokens(selTokens)} / ${fmtTokens(node.tokens)}`}</span>
      </div>
      {open && !isFile && (node.children || []).map((c) => <TreeNode key={c.id} node={c} depth={depth + 1} sel={sel} toggle={toggle} />)}
      {open && !isFile && (node.children || []).length === 0 && (
        <div className="muted small" style={{ paddingLeft: depth * 16 + 40 }}>
          (nothing here)
        </div>
      )}
    </div>
  );
}

export function ContextPanel({ chat, update, usage, onClose }: { chat: Chat; update: (p: Partial<Chat>) => Promise<void>; usage: { used: number; limit: number }; onClose: () => void }) {
  const [nodes, setNodes] = useState<ContextNode[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set(chat.contextSel));
  const [parts, setParts] = useState<any>(null);
  const load = async () => {
    const r = await api('context:tree', chat.id).catch(() => null);
    if (r) {
      setNodes(r.nodes);
      setParts(r.usage?.parts || null);
    }
  };
  useEffect(() => {
    void load();
  }, [chat.id]);

  const toggle = async (ids: string[], on: boolean) => {
    const next = new Set(sel);
    for (const id of ids) on ? next.add(id) : next.delete(id);
    setSel(next);
    await update({ contextSel: [...next] });
    const m = await api('chats:measure', chat.id).catch(() => null);
    if (m) setParts(m.parts);
  };
  const all = useMemo(() => (nodes || []).flatMap(leaves), [nodes]);
  const selected = all.filter((l) => sel.has(l.id));
  const total = selected.reduce((s, l) => s + l.tokens, 0);
  const over = usage.limit > 0 && usage.used > usage.limit;

  return (
    <div className="drawer">
      <div className="dhead">
        <span className="grow">Context for this chat</span>
        <button className="ghost" title="Rescan files" onClick={load}>
          ⟳
        </button>
        <button className="ghost" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="dbody">
        <div className="card">
          <div className="row">
            <strong className="grow">
              {selected.length} file(s) checked · ~{fmtTokens(total)} tokens
            </strong>
            {selected.length > 0 && (
              <button className="ghost small" onClick={() => toggle([...sel], false)}>
                Uncheck all
              </button>
            )}
          </div>
          <div className="small" style={{ color: over ? 'var(--err)' : 'var(--muted)' }}>
            Whole request: ~{fmtTokens(usage.used)} of {usage.limit ? fmtTokens(usage.limit) : '?'} tokens{over ? ' - over the limit!' : ''}
          </div>
          {parts && (
            <div className="small muted">
              System prompt {fmtTokens(parts.system)} · context files {fmtTokens(parts.context)} · tool descriptions {fmtTokens(parts.tools)} · history {fmtTokens(parts.history)}
            </div>
          )}
          <div className="small muted" style={{ marginTop: 4 }}>
            Checked files are sent with every turn, so only check what this chat needs. Unchecked files can still be read on demand by the model's file tools. Token counts are estimates.
          </div>
        </div>
        {!nodes ? <div className="muted">Scanning…</div> : nodes.map((n) => <TreeNode key={n.id} node={n} depth={0} sel={sel} toggle={toggle} />)}
        {nodes && !nodes.some((n) => n.id === 'g:wf') && <div className="muted small" style={{ marginTop: 8 }}>Choose a work folder in the sidebar to list its files here.</div>}
        {nodes && !chat.topicId && <div className="muted small" style={{ marginTop: 8 }}>This chat is not in a Topic. Drag it onto a Topic to inherit that Topic's context files.</div>}
      </div>
    </div>
  );
}

function summarize(e: any): string {
  const d = e.data || {};
  switch (e.type) {
    case 'request':
      return `step ${d.step} → ${d.model} (${d.effort}, ctx ${d.numCtx}, tools: ${d.toolMode}) ~${d.estimatedTokens?.total} tokens, ${d.messages?.length} messages`;
    case 'response':
      return `step ${d.step} ← ${d.ms} ms, ${d.usage?.prompt ?? '?'} in / ${d.usage?.completion ?? '?'} out, ${d.toolCalls?.length || 0} tool call(s)`;
    case 'tool-calls-parsed':
      return (d.validations || []).map((v: any) => (v.ok ? `✓ ${v.call.name}` : `✗ ${v.name}`)).join(', ') + (d.malformed?.length ? ` + ${d.malformed.length} malformed` : '');
    case 'tool-exec':
      return `${d.name} (${d.ms} ms)`;
    case 'tool-result':
      return `${d.name}: ${d.blocked ? 'BLOCKED' : d.isError ? 'error' : 'ok'}, ${d.chars} chars${d.truncated ? ' (truncated)' : ''}`;
    case 'approval-request':
      return d.title;
    case 'approval-answer':
      return d.approved ? 'approved' : 'denied';
    case 'error':
      return d.message || '';
    case 'compaction':
      return `${d.messagesSummarized} messages, ${d.tokensBefore} → ${d.tokensAfter} tokens`;
    default:
      return '';
  }
}

function LogEntry({ e }: { e: any }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="logentry" onToggle={(ev) => setOpen((ev.target as HTMLDetailsElement).open)}>
      <summary>
        <span className="muted">{String(e.ts).slice(11, 23)}</span> <b style={{ color: e.type === 'error' ? 'var(--err)' : undefined }}>{e.type}</b> <span className="muted">{summarize(e)}</span>
      </summary>
      {open && <pre>{JSON.stringify(e.data, null, 2)}</pre>}
    </details>
  );
}

export function LogPanel({ chatId, running, onClose }: { chatId: string; running: boolean; onClose: () => void }) {
  const [log, setLog] = useState<{ entries: any[]; path: string; exists: boolean } | null>(null);
  const load = () => api('log:get', chatId).then(setLog).catch(() => {});
  useEffect(() => {
    void load();
    if (!running) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [chatId, running]);
  return (
    <div className="drawer" style={{ width: 520 }}>
      <div className="dhead">
        <span className="grow">Log</span>
        <button className="ghost" onClick={load} title="Refresh">
          ⟳
        </button>
        <button className="ghost" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="dbody">
        <div className="card small">
          <div className="ellipsis muted" title={log?.path}>
            {log?.path}
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <button disabled={!log?.exists} onClick={() => api('log:open', chatId)}>
              Open file
            </button>
            <button onClick={() => api('log:reveal', chatId)}>Show in folder</button>
            <span className="muted">One JSON object per line. API keys are redacted.</span>
          </div>
        </div>
        {log && log.entries.length === 0 && <div className="muted">Nothing logged for this chat yet.</div>}
        {log?.entries.map((e, i) => <LogEntry key={i + e.ts} e={e} />)}
      </div>
    </div>
  );
}

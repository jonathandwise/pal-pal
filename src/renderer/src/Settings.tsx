import { useEffect, useState } from 'react';
import type { HardwareProfile, McpServerConfig, ModelInfo, OllamaOverrides, Settings } from '../../shared/types';
import { DEFAULT_SYSTEM_PROMPT } from '../../shared/types';
import { api } from './api';

type Tab = 'general' | 'prompt' | 'memory' | 'agent' | 'hardware' | 'mcp';
interface P {
  settings: Settings;
  models: ModelInfo[];
  save: (patch: Partial<Settings>) => Promise<void>;
  onClose: () => void;
  pickFolder: () => void;
  toast: (t: string, err?: boolean) => void;
}

export function SettingsModal(p: P) {
  const [tab, setTab] = useState<Tab>('general');
  const tabs: [Tab, string][] = [
    ['general', 'General'],
    ['prompt', 'System prompt'],
    ['memory', 'Long-term memory'],
    ['agent', 'Agent & limits'],
    ['hardware', 'Hardware & Ollama'],
    ['mcp', 'MCP servers'],
  ];
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="modal">
        <div className="mhead">
          <span className="grow">Settings</span>
          <button className="ghost" onClick={p.onClose}>
            ✕
          </button>
        </div>
        <div className="mbody">
          <div className="tabs">
            {tabs.map(([k, label]) => (
              <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </div>
          <div className="pane">
            {tab === 'general' && <General {...p} />}
            {tab === 'prompt' && <Prompt {...p} />}
            {tab === 'memory' && <Memory {...p} />}
            {tab === 'agent' && <Agent {...p} />}
            {tab === 'hardware' && <Hardware {...p} />}
            {tab === 'mcp' && <Mcp {...p} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function General(p: P) {
  const [url, setUrl] = useState(p.settings.ollamaUrl);
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api('key:status').then((s) => setHasKey(s.set));
  }, []);
  const saveKey = async (value: string) => {
    setBusy(true);
    const r = await api('key:set', value).catch((e) => ({ ok: false, message: e.message }));
    setBusy(false);
    setMsg(r);
    if (r.ok) setKey('');
    setHasKey((await api('key:status')).set);
  };
  return (
    <>
      <div className="field">
        <label>Ollama URL</label>
        <div className="row">
          <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button onClick={() => p.save({ ollamaUrl: url.trim() || 'http://localhost:11434' }).then(() => p.toast('Ollama URL saved.'))}>Save</button>
        </div>
        <div className="hint">Default is http://localhost:11434.</div>
      </div>
      <div className="field">
        <label>OpenRouter API key</label>
        <div className="row">
          <input type="password" placeholder={hasKey ? 'A key is stored (enter a new one to replace it)' : 'sk-or-…'} value={key} onChange={(e) => setKey(e.target.value)} />
          <button className="primary" disabled={!key.trim() || busy} onClick={() => saveKey(key)}>
            {busy ? 'Checking…' : 'Save'}
          </button>
          {hasKey && (
            <button disabled={busy} onClick={() => saveKey('')}>
              Remove
            </button>
          )}
        </div>
        {msg && (
          <div className="hint" style={{ color: msg.ok ? 'var(--ok)' : 'var(--err)' }}>
            {msg.message}
          </div>
        )}
        <div className="hint">Stored encrypted with Windows data protection (DPAPI) for your Windows account. It is never written to logs and never shown again.</div>
      </div>
      <div className="field">
        <label>Work folder</label>
        <div className="row">
          <span className="grow ellipsis muted">{p.settings.workFolder || 'None selected'}</span>
          <button onClick={p.pickFolder}>{p.settings.workFolder ? 'Switch…' : 'Choose…'}</button>
        </div>
        <div className="hint">The AI can only read and change files inside this folder unless you turn on outside access for a chat.</div>
      </div>
      <div className="field">
        <label>Theme</label>
        <select value={p.settings.theme} onChange={(e) => p.save({ theme: e.target.value as any })}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </div>
    </>
  );
}

function Prompt(p: P) {
  const [text, setText] = useState(p.settings.systemPrompt);
  return (
    <div className="field">
      <label>System prompt (used in every chat)</label>
      <textarea rows={20} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={text === p.settings.systemPrompt} onClick={() => p.save({ systemPrompt: text }).then(() => p.toast('System prompt saved.'))}>
          Save
        </button>
        <button
          onClick={() => {
            setText(DEFAULT_SYSTEM_PROMPT);
            void p.save({ systemPrompt: DEFAULT_SYSTEM_PROMPT }).then(() => p.toast('System prompt reset to default.'));
          }}
        >
          Reset to default
        </button>
        <span className="muted small">~{Math.ceil(text.length / 3.6)} tokens. Pal Pal appends the date, work folder, checked context and tool instructions.</span>
      </div>
    </div>
  );
}

function Memory(p: P) {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [path, setPath] = useState('');
  useEffect(() => {
    void api('memory:get').then((m) => {
      setText(m.text);
      setSaved(m.text);
      setPath(m.path);
    });
  }, []);
  return (
    <div className="field">
      <label>Long-term memory (Markdown)</label>
      <textarea rows={20} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={text === saved} onClick={() => api('memory:set', text).then(() => (setSaved(text), p.toast('Memory saved.')))}>
          Save
        </button>
        <span className="muted small">~{Math.ceil(text.length / 3.6)} tokens</span>
      </div>
      <div className="hint">
        Facts that carry across chats. The AI proposes additions with its <code>remember</code> tool; you approve each one (added automatically in Full auto). It is sent only to chats where “Long-term memory” is checked in the Context panel.
        <br />
        File: {path}
      </div>
    </div>
  );
}

function Num({ label, hint, value, onChange, min, max, step }: { label: string; hint?: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => e.target.value !== '' && onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, Number(e.target.value))))} />
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function Agent(p: P) {
  const s = p.settings;
  return (
    <>
      <Num label="Maximum agent steps per turn" value={s.maxSteps} min={1} max={200} onChange={(n) => p.save({ maxSteps: n })} hint="One step is one model call. The loop stops and tells you when it reaches this." />
      <Num label="Tool timeout (seconds)" value={s.toolTimeoutSec} min={5} max={3600} onChange={(n) => p.save({ toolTimeoutSec: n })} hint="Shell commands and MCP calls are killed after this long." />
      <Num label="Tool output cap (characters)" value={s.maxToolOutputChars} min={1000} max={200000} step={1000} onChange={(n) => p.save({ maxToolOutputChars: n })} hint="Longer tool output is cut (start and end kept) with a note, to save context." />
      <Num label="Invalid tool-call retries" value={s.maxToolRetries} min={0} max={10} onChange={(n) => p.save({ maxToolRetries: n })} hint="How many times in a row the model may send an invalid tool call before the turn stops." />
      <div className="field">
        <label>
          <input type="checkbox" checked={s.autoCompact} onChange={(e) => p.save({ autoCompact: e.target.checked })} /> Auto-compact when the context is nearly full
        </label>
        <div className="hint">Older turns are summarized; recent turns and checked context files stay intact.</div>
      </div>
      <Num label="Warn at (% of context)" value={Math.round(s.warnThreshold * 100)} min={10} max={99} onChange={(n) => p.save({ warnThreshold: n / 100 })} />
      <Num label="Auto-compact at (% of context)" value={Math.round(s.compactThreshold * 100)} min={20} max={99} onChange={(n) => p.save({ compactThreshold: n / 100 })} />
      <Num label="Recent turns kept intact when compacting" value={s.keepRecentTurns} min={1} max={20} onChange={(n) => p.save({ keepRecentTurns: n })} />
    </>
  );
}

const numOrUndef = (v: string) => (v.trim() === '' || isNaN(Number(v)) ? undefined : Number(v));

function Hardware(p: P) {
  const [profile, setProfile] = useState<HardwareProfile | null>(null);
  const [machine, setMachine] = useState('');
  const [global, setGlobal] = useState<OllamaOverrides>({});
  const [perModel, setPerModel] = useState<Record<string, OllamaOverrides>>({});
  const [defs, setDefs] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const ollama = p.models.filter((m) => m.provider === 'ollama');

  const loadDefs = async () => {
    const entries = await Promise.all(ollama.map(async (m) => [m.id, await api('hw:defaults', m.id, 'medium').catch(() => null)] as const));
    setDefs(Object.fromEntries(entries));
  };
  const apply = (pr: HardwareProfile) => {
    setProfile(pr);
    setGlobal(pr.global || {});
    setPerModel(pr.perModel || {});
    void loadDefs();
  };
  useEffect(() => {
    void api('hw:get').then((r) => {
      setMachine(r.machineId);
      apply(r.profile);
    });
  }, []);
  const save = async () => {
    const clean: Record<string, OllamaOverrides> = {};
    for (const [k, v] of Object.entries(perModel)) if (Object.values(v).some((x) => x !== undefined && x !== '')) clean[k] = v;
    apply(await api('hw:saveOverrides', global, clean));
    p.toast('Overrides saved for this PC.');
  };
  const hw = profile?.hardware;
  const setPM = (id: string, k: keyof OllamaOverrides, v: any) => setPerModel((s) => ({ ...s, [id]: { ...s[id], [k]: v } }));
  return (
    <>
      <div className="card">
        <div className="row">
          <strong className="grow">This PC{hw ? `: ${hw.hostname}` : ''}</strong>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              apply(await api('hw:detect'));
              setBusy(false);
              p.toast('Hardware detected.');
            }}
          >
            {busy ? 'Detecting…' : 'Detect hardware'}
          </button>
        </div>
        {hw ? (
          <div className="small" style={{ marginTop: 6 }}>
            <div>GPU: {hw.gpus.length ? hw.gpus.map((g) => `${g.name} (${(g.vramMB / 1024).toFixed(1)} GB)`).join(', ') : 'none detected'}</div>
            <div>
              Usable VRAM for models: <b>{hw.vramMB ? (hw.vramMB / 1024).toFixed(1) + ' GB' : 'none - models run on CPU'}</b> · System RAM: <b>{(hw.ramMB / 1024).toFixed(1)} GB</b>
            </div>
            <div className="muted">
              {hw.cpu} ({hw.cores} threads) · detected {new Date(hw.detectedAt).toLocaleString()} · profile id {machine.slice(0, 8)}
            </div>
          </div>
        ) : (
          <div className="muted small">Not detected yet.</div>
        )}
      </div>

      <div className="field">
        <label>Global Ollama overrides (all models, this PC)</label>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span>num_ctx</span>
          <input type="number" placeholder="auto" value={global.num_ctx ?? ''} onChange={(e) => setGlobal({ ...global, num_ctx: numOrUndef(e.target.value) })} />
          <span>num_gpu</span>
          <input type="number" placeholder="auto" value={global.num_gpu ?? ''} onChange={(e) => setGlobal({ ...global, num_gpu: numOrUndef(e.target.value) })} />
          <span>temperature</span>
          <input type="number" step={0.1} placeholder="by effort" value={global.temperature ?? ''} onChange={(e) => setGlobal({ ...global, temperature: numOrUndef(e.target.value) })} />
          <span>keep_alive</span>
          <input type="text" style={{ width: 90 }} placeholder="5m" value={global.keep_alive ?? ''} onChange={(e) => setGlobal({ ...global, keep_alive: e.target.value || undefined })} />
        </div>
        <div className="hint">Leave blank to use the hardware-aware defaults. num_gpu is the number of layers on the GPU (0 = CPU only); blank lets Ollama place layers itself.</div>
      </div>

      <div className="field">
        <label>Per-model defaults and overrides</label>
        {ollama.length === 0 ? (
          <div className="muted">No Ollama models found. Start Ollama and pull a model.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Model</th>
                <th>Default context</th>
                <th>Est. memory / GPU layers</th>
                <th>num_ctx</th>
                <th>num_gpu</th>
              </tr>
            </thead>
            <tbody>
              {ollama.map((m) => {
                const d = defs[m.id]?.defaults;
                return (
                  <tr key={m.id}>
                    <td>
                      <div>{m.name}</div>
                      <div className="muted small">
                        {[m.paramSize, m.quant, m.sizeBytes ? (m.sizeBytes / 1073741824).toFixed(1) + ' GB' : ''].filter(Boolean).join(' · ')}
                      </div>
                      {d?.warning && <div className="small" style={{ color: 'var(--warn)' }}>⚠ {d.warning}</div>}
                    </td>
                    <td>{d ? d.num_ctx : '…'}</td>
                    <td>{d ? `${(d.estVramMB / 1024).toFixed(1)} GB · ${d.totalLayers ? `${d.estGpuLayers}/${d.totalLayers}` : d.fitsVram ? 'all' : 'partial'}` : '…'}</td>
                    <td>
                      <input type="number" placeholder="auto" value={perModel[m.id]?.num_ctx ?? ''} onChange={(e) => setPM(m.id, 'num_ctx', numOrUndef(e.target.value))} />
                    </td>
                    <td>
                      <input type="number" placeholder="auto" value={perModel[m.id]?.num_gpu ?? ''} onChange={(e) => setPM(m.id, 'num_gpu', numOrUndef(e.target.value))} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <button className="primary" onClick={save}>
        Save overrides
      </button>
      <span className="muted small" style={{ marginLeft: 10 }}>
        Each PC keeps its own hardware profile and overrides.
      </span>
    </>
  );
}

const splitArgs = (s: string) => (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a) => a.replace(/^(["'])(.*)\1$/, '$2'));
const joinArgs = (a: string[] = []) => a.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ');
const parsePairs = (s: string, sep: RegExp) => Object.fromEntries(s.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.search(sep); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, '']; }));
const fmtPairs = (o: Record<string, string> = {}, sep: string) => Object.entries(o).map(([k, v]) => `${k}${sep}${v}`).join('\n');

function Mcp(p: P) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [status, setStatus] = useState<any[]>([]);
  const [edit, setEdit] = useState<(McpServerConfig & { argsText: string; envText: string; headersText: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const apply = (r: any) => (setServers(r.servers), setStatus(r.status));
  useEffect(() => {
    void api('mcp:get').then(apply);
  }, []);
  const persist = async (list: McpServerConfig[], reconnect?: string) => {
    setBusy(true);
    try {
      apply(await api('mcp:save', list, reconnect));
    } catch (e: any) {
      p.toast(e.message, true);
    }
    setBusy(false);
  };
  const startEdit = (s?: McpServerConfig) =>
    setEdit({
      ...(s || { id: crypto.randomUUID(), name: '', type: 'stdio', enabled: true }),
      argsText: joinArgs(s?.args),
      envText: fmtPairs(s?.env, '='),
      headersText: fmtPairs(s?.headers, ': '),
    });
  const saveEdit = async () => {
    if (!edit) return;
    if (!edit.name.trim()) return p.toast('Give the server a name.', true);
    const { argsText, envText, headersText, ...rest } = edit;
    const cfg: McpServerConfig = { ...rest, name: edit.name.trim(), args: splitArgs(argsText), env: parsePairs(envText, /=/), headers: parsePairs(headersText, /:/) };
    setEdit(null);
    await persist(servers.some((s) => s.id === cfg.id) ? servers.map((s) => (s.id === cfg.id ? cfg : s)) : [...servers, cfg], cfg.id);
  };
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <strong className="grow">MCP servers</strong>
        {busy && <span className="muted small">Connecting…</span>}
        <button onClick={() => startEdit()}>+ Add server</button>
      </div>
      {servers.length === 0 && !edit && <div className="muted">No MCP servers yet. Add a stdio server (a command to run) or an HTTP server (a URL); its tools then become available to the model.</div>}
      {servers.map((s) => {
        const st = status.find((x) => x.id === s.id);
        return (
          <div className="card" key={s.id}>
            <div className="row">
              <span className={'dot ' + (st?.status === 'connected' ? 'ok' : st?.status === 'error' ? 'err' : '')} />
              <strong>{s.name}</strong>
              <span className="tag">{s.type}</span>
              <span className="grow muted small ellipsis">{s.type === 'stdio' ? `${s.command} ${joinArgs(s.args)}` : s.url}</span>
              <label className="row small" style={{ gap: 3 }}>
                <input type="checkbox" checked={s.enabled} onChange={(e) => persist(servers.map((x) => (x.id === s.id ? { ...x, enabled: e.target.checked } : x)))} /> on
              </label>
              <button className="ghost" title="Reconnect" disabled={busy} onClick={() => persist(servers, s.id)}>
                ⟳
              </button>
              <button className="ghost" onClick={() => startEdit(s)}>
                ✎
              </button>
              <button className="ghost" onClick={() => confirm(`Remove MCP server "${s.name}"?`) && persist(servers.filter((x) => x.id !== s.id))}>
                🗑
              </button>
            </div>
            <div className="small" style={{ marginTop: 4, color: st?.status === 'error' ? 'var(--err)' : 'var(--muted)' }}>
              {!s.enabled ? 'Disabled' : st?.status === 'connected' ? `Connected · ${st.tools.length} tool(s): ${st.tools.map((t: string) => t.replace(/^mcp__.*?__/, '')).join(', ')}` : st?.status === 'error' ? `Failed: ${st.error}` : st?.status || 'Not connected'}
            </div>
          </div>
        );
      })}
      {edit && (
        <div className="card">
          <div className="field">
            <label>Name</label>
            <input type="text" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          </div>
          <div className="field">
            <label>Type</label>
            <select value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value as any })}>
              <option value="stdio">stdio (run a local command)</option>
              <option value="http">HTTP (streamable HTTP / SSE URL)</option>
            </select>
          </div>
          {edit.type === 'stdio' ? (
            <>
              <div className="field">
                <label>Command</label>
                <input type="text" placeholder="npx" value={edit.command || ''} onChange={(e) => setEdit({ ...edit, command: e.target.value })} />
              </div>
              <div className="field">
                <label>Arguments</label>
                <input type="text" placeholder='-y @modelcontextprotocol/server-filesystem "C:\some folder"' value={edit.argsText} onChange={(e) => setEdit({ ...edit, argsText: e.target.value })} />
              </div>
              <div className="field">
                <label>Environment variables (KEY=VALUE per line)</label>
                <textarea rows={3} value={edit.envText} onChange={(e) => setEdit({ ...edit, envText: e.target.value })} />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label>URL</label>
                <input type="text" placeholder="https://example.com/mcp" value={edit.url || ''} onChange={(e) => setEdit({ ...edit, url: e.target.value })} />
              </div>
              <div className="field">
                <label>Headers (Name: value per line)</label>
                <textarea rows={3} value={edit.headersText} onChange={(e) => setEdit({ ...edit, headersText: e.target.value })} />
              </div>
            </>
          )}
          <div className="row">
            <button className="primary" onClick={saveEdit}>
              Save and connect
            </button>
            <button onClick={() => setEdit(null)}>Cancel</button>
            <span className="muted small">Server settings are stored encrypted, since they can contain tokens.</span>
          </div>
        </div>
      )}
      <div className="hint muted small" style={{ marginTop: 10 }}>
        MCP servers run with your full user rights and are not confined to the work folder. Calls to MCP tools need your approval except in Full auto.
      </div>
    </>
  );
}

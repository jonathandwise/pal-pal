/** MCP client manager: connects configured stdio / HTTP servers and exposes their tools. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpServerConfig } from '../shared/types';
import type { ToolDef } from './toolcalls';

interface Conn {
  config: McpServerConfig;
  client: Client | null;
  tools: ToolDef[];
  /** prefixed tool name -> original name */
  names: Map<string, string>;
  status: 'connecting' | 'connected' | 'error' | 'disabled';
  error?: string;
}
const conns = new Map<string, Conn>();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'server';

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

async function connect(conn: Conn): Promise<void> {
  const c = conn.config;
  conn.status = 'connecting';
  conn.error = undefined;
  let stderr = '';
  try {
    const client = new Client({ name: 'local-ai-harness', version: '1.0.0' });
    if (c.type === 'stdio') {
      if (!c.command) throw new Error('No command configured');
      const transport = new StdioClientTransport({ command: c.command, args: c.args || [], env: { ...getDefaultEnvironment(), ...(c.env || {}) }, stderr: 'pipe' });
      transport.stderr?.on('data', (d) => (stderr = (stderr + d.toString()).slice(-600)));
      await withTimeout(client.connect(transport), 30000, 'Starting the server');
    } else {
      if (!c.url) throw new Error('No URL configured');
      const url = new URL(c.url);
      const requestInit = { headers: c.headers || {} };
      try {
        await withTimeout(client.connect(new StreamableHTTPClientTransport(url, { requestInit })), 20000, 'Connecting');
      } catch {
        // older servers speak HTTP+SSE
        await withTimeout(client.connect(new SSEClientTransport(url, { requestInit })), 20000, 'Connecting');
      }
    }
    const listed = await withTimeout(client.listTools(), 20000, 'Listing tools');
    conn.client = client;
    conn.names.clear();
    conn.tools = listed.tools.map((t) => {
      const name = `mcp__${slug(c.name)}__${t.name}`.slice(0, 64);
      conn.names.set(name, t.name);
      return { name, description: `[MCP: ${c.name}] ${t.description || t.name}`.slice(0, 1024), parameters: (t.inputSchema as any) || { type: 'object', properties: {} } };
    });
    conn.status = 'connected';
    client.onclose = () => {
      if (conn.status === 'connected') {
        conn.status = 'error';
        conn.error = 'The server closed the connection.';
        conn.tools = [];
      }
    };
  } catch (e: any) {
    conn.status = 'error';
    conn.tools = [];
    conn.client = null;
    const code = e?.code === 'ENOENT' ? `Command not found: ${c.command}` : e?.message || String(e);
    conn.error = code + (stderr.trim() ? ` - ${stderr.trim().split('\n').slice(-3).join(' | ')}` : '');
  }
}

async function disconnect(conn: Conn): Promise<void> {
  const client = conn.client;
  conn.client = null;
  conn.tools = [];
  conn.status = 'disabled';
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
}

/** Bring live connections in line with the saved configuration. */
export async function syncMcp(configs: McpServerConfig[], forceId?: string): Promise<void> {
  const ids = new Set(configs.map((c) => c.id));
  for (const [id, conn] of conns) {
    if (!ids.has(id)) {
      await disconnect(conn);
      conns.delete(id);
    }
  }
  await Promise.all(
    configs.map(async (cfg) => {
      const cur = conns.get(cfg.id);
      const changed = !cur || JSON.stringify(cur.config) !== JSON.stringify(cfg) || forceId === cfg.id;
      if (!changed) return;
      if (cur) await disconnect(cur);
      const conn: Conn = { config: cfg, client: null, tools: [], names: new Map(), status: 'disabled' };
      conns.set(cfg.id, conn);
      if (cfg.enabled) await connect(conn);
    }),
  );
}

export function mcpStatus(): { id: string; status: string; error?: string; tools: string[] }[] {
  return [...conns.values()].map((c) => ({ id: c.config.id, status: c.status, error: c.error, tools: c.tools.map((t) => t.name) }));
}
export const mcpTools = (): ToolDef[] => [...conns.values()].flatMap((c) => (c.status === 'connected' ? c.tools : []));
export const isMcpTool = (name: string) => [...conns.values()].some((c) => c.names.has(name));

export async function callMcp(name: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<{ content: string; isError?: boolean }> {
  const conn = [...conns.values()].find((c) => c.names.has(name));
  if (!conn || !conn.client) return { content: `Error: MCP server for tool "${name}" is not connected.`, isError: true };
  try {
    const res: any = await conn.client.callTool({ name: conn.names.get(name)!, arguments: args }, undefined, { signal, timeout: timeoutMs });
    const parts = (res.content || []).map((p: any) => {
      if (p.type === 'text') return p.text;
      if (p.type === 'resource') return p.resource?.text ?? `[resource ${p.resource?.uri}]`;
      return `[${p.type} content omitted]`;
    });
    const text = parts.join('\n') || (res.structuredContent ? JSON.stringify(res.structuredContent) : '(no output)');
    return { content: text, isError: !!res.isError };
  } catch (e: any) {
    if (signal.aborted) return { content: 'Error: cancelled.', isError: true };
    return { content: `Error: MCP server "${conn.config.name}" failed: ${e?.message || e}`, isError: true };
  }
}

export async function shutdownMcp(): Promise<void> {
  await Promise.all([...conns.values()].map(disconnect));
}

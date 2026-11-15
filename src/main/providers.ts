/** Ollama and OpenRouter: model listing, effort mapping, streaming chat. */
import type { Effort, ModelInfo, OllamaOverrides } from '../shared/types';
import type { RawCall, ToolDef } from './toolcalls';
import { getSecret, getSettings } from './store';

export class PalPalError extends Error {
  constructor(message: string, public code: 'no-tools' | 'no-think' | 'auth' | 'offline' | 'missing-model' | 'aborted' | 'other' = 'other') {
    super(message);
  }
}

export interface LLMMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[]; // data URLs
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  toolCallId?: string;
  toolName?: string;
}
export interface ChatResult {
  content: string;
  thinking: string;
  toolCalls: RawCall[];
  usage: { prompt?: number; completion?: number };
  finish?: string;
}
export interface ChatOpts {
  model: ModelInfo;
  messages: LLMMsg[];
  tools?: ToolDef[];
  effort: Effort;
  numCtx?: number;
  overrides?: OllamaOverrides;
  noThink?: boolean;
  signal: AbortSignal;
  onDelta: (t: string) => void;
  onThinking: (t: string) => void;
}

const ollamaUrl = () => getSettings().ollamaUrl.replace(/\/+$/, '');
const OR = 'https://openrouter.ai/api/v1';

// ------------------------------------------------------------------------------------------ effort mapping
/**
 * Effort mapping (documented in README):
 *  Ollama thinking models:      low = think off (gpt-oss: "low"), medium = think on, high = think on + unlimited output
 *  Ollama non-thinking models:  low = 1024 out / temp 0.3 / half context, medium = 4096 / 0.6, high = unlimited / 0.7
 *  OpenRouter reasoning models: reasoning.effort = low | medium | high
 *  OpenRouter other models:     low = 1024 out / temp 0.3, medium = 4096 / 0.6, high = 16384 / 0.7
 */
export function effortParams(model: ModelInfo, effort: Effort) {
  const gen = { low: { maxOut: 1024, temp: 0.3 }, medium: { maxOut: 4096, temp: 0.6 }, high: { maxOut: -1, temp: 0.7 } }[effort];
  if (model.provider === 'ollama') {
    if (model.thinking) {
      const levels = /gpt-oss/i.test(model.id);
      return {
        think: levels ? effort : effort !== 'low',
        num_predict: { low: 2048, medium: 8192, high: -1 }[effort],
        temperature: undefined as number | undefined,
        ctxScale: 1,
      };
    }
    return { think: undefined, num_predict: gen.maxOut, temperature: gen.temp, ctxScale: effort === 'low' ? 0.5 : 1 };
  }
  if (model.thinking) return { reasoning: { effort }, max_tokens: undefined as number | undefined, temperature: undefined as number | undefined };
  const cap = model.maxOutput || 16384;
  return { reasoning: undefined, max_tokens: Math.min(effort === 'high' ? 16384 : gen.maxOut, cap), temperature: gen.temp };
}

/** The context length a request will actually run with. */
export function effectiveCtx(model: ModelInfo, effort: Effort, tunedCtx: number, userCtx?: number): number {
  if (model.provider !== 'ollama') return model.contextLength || 8192;
  if (userCtx) return userCtx;
  const p = effortParams(model, effort) as any;
  return Math.max(4096, Math.round(tunedCtx * (p.ctxScale || 1)));
}

// ------------------------------------------------------------------------------------------ helpers
async function safeFetch(url: string, init: RequestInit, who: 'Ollama' | 'OpenRouter'): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e: any) {
    if (init.signal?.aborted) throw new PalPalError('Stopped.', 'aborted');
    if (who === 'Ollama') throw new PalPalError(`Cannot reach Ollama at ${ollamaUrl()}. Is Ollama running? Start it (or fix the URL in Settings) and try again.`, 'offline');
    throw new PalPalError(`Network error reaching OpenRouter (${e?.cause?.code || e?.message || 'fetch failed'}). Check your internet connection.`, 'offline');
  }
}

async function* lines(res: Response, signal: AbortSignal): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) yield line;
      }
    }
    if (buf.trim()) yield buf.trim();
  } catch (e: any) {
    if (signal.aborted) throw new PalPalError('Stopped.', 'aborted');
    throw new PalPalError(`Connection lost while streaming (${e?.message || e}).`, 'offline');
  }
}

const b64 = (dataUrl: string) => dataUrl.replace(/^data:[^;]+;base64,/, '');

// ------------------------------------------------------------------------------------------ Ollama
const showCache = new Map<string, any>();

export async function listOllamaModels(): Promise<ModelInfo[]> {
  const res = await safeFetch(ollamaUrl() + '/api/tags', { signal: AbortSignal.timeout(5000) }, 'Ollama');
  if (!res.ok) throw new PalPalError(`Ollama returned HTTP ${res.status} when listing models.`);
  const tags = ((await res.json()) as any).models || [];
  const out = await Promise.all(
    tags.map(async (t: any): Promise<ModelInfo | null> => {
      const key = t.name + ':' + t.digest;
      let show = showCache.get(key);
      if (!show) {
        try {
          const r = await fetch(ollamaUrl() + '/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: t.name }), signal: AbortSignal.timeout(8000) });
          show = r.ok ? await r.json() : {};
        } catch {
          show = {};
        }
        showCache.set(key, show);
      }
      const caps: string[] = show.capabilities || [];
      if (caps.length && !caps.includes('completion')) return null; // embedding-only models
      const info = show.model_info || {};
      const arch = info['general.architecture'] || '';
      const g = (k: string) => Number(info[`${arch}.${k}`]) || 0;
      const layers = g('block_count');
      const embd = g('embedding_length');
      const heads = g('attention.head_count') || 1;
      const headsKv = g('attention.head_count_kv') || heads;
      return {
        id: t.name,
        provider: 'ollama',
        name: t.name,
        contextLength: g('context_length') || 4096,
        vision: caps.includes('vision'),
        tools: caps.includes('tools'),
        thinking: caps.includes('thinking'),
        sizeBytes: t.size,
        paramSize: t.details?.parameter_size,
        quant: t.details?.quantization_level,
        family: t.details?.family,
        layers: layers || undefined,
        // K and V caches, f16: layers * kv-width * 2 tensors * 2 bytes
        kvBytesPerToken: layers && embd ? layers * embd * (headsKv / heads) * 4 : undefined,
      };
    }),
  );
  return (out.filter(Boolean) as ModelInfo[]).sort((a, b) => a.name.localeCompare(b.name));
}

export async function ollamaStatus(): Promise<{ running: boolean; version?: string; loaded: { name: string; sizeMB: number; vramMB: number; ctx?: number; until?: string }[] }> {
  try {
    const [v, ps] = await Promise.all([
      fetch(ollamaUrl() + '/api/version', { signal: AbortSignal.timeout(2500) }),
      fetch(ollamaUrl() + '/api/ps', { signal: AbortSignal.timeout(2500) }),
    ]);
    const models = ps.ok ? ((await ps.json()) as any).models || [] : [];
    return {
      running: v.ok,
      version: v.ok ? ((await v.json()) as any).version : undefined,
      loaded: models.map((m: any) => ({
        name: m.name,
        sizeMB: Math.round((m.size || 0) / 1048576),
        vramMB: Math.round((m.size_vram || 0) / 1048576),
        ctx: m.context_length,
        until: m.expires_at,
      })),
    };
  } catch {
    return { running: false, loaded: [] };
  }
}

function toOllama(messages: LLMMsg[]) {
  return messages.map((m) => {
    const o: any = { role: m.role, content: m.content };
    if (m.images?.length) o.images = m.images.map(b64);
    if (m.toolCalls?.length) o.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } }));
    if (m.role === 'tool' && m.toolName) o.tool_name = m.toolName;
    return o;
  });
}

async function chatOllama(o: ChatOpts): Promise<ChatResult> {
  const p = effortParams(o.model, o.effort) as any;
  const ov = o.overrides || {};
  const options: any = { num_ctx: o.numCtx };
  if (ov.num_gpu !== undefined) options.num_gpu = ov.num_gpu;
  const temp = ov.temperature ?? p.temperature;
  if (temp !== undefined) options.temperature = temp;
  const np = ov.num_predict ?? p.num_predict;
  if (np !== undefined) options.num_predict = np;
  const body: any = { model: o.model.id, messages: toOllama(o.messages), stream: true, options };
  if (ov.keep_alive) body.keep_alive = ov.keep_alive;
  if (o.tools?.length) body.tools = o.tools.map((t) => ({ type: 'function', function: t }));
  if (p.think !== undefined && !o.noThink) body.think = p.think;

  const res = await safeFetch(ollamaUrl() + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: o.signal }, 'Ollama');
  if (!res.ok) {
    let msg = '';
    try {
      msg = ((await res.json()) as any).error || '';
    } catch {
      /* ignore */
    }
    if (/does not support tools/i.test(msg)) throw new PalPalError(msg, 'no-tools');
    if (/does not support thinking/i.test(msg)) throw new PalPalError(msg, 'no-think');
    if (res.status === 404 || /not found/i.test(msg)) throw new PalPalError(`Model "${o.model.id}" is not installed in Ollama. Run:  ollama pull ${o.model.id}`, 'missing-model');
    throw new PalPalError(`Ollama error (HTTP ${res.status}): ${msg || res.statusText}`);
  }
  const out: ChatResult = { content: '', thinking: '', toolCalls: [], usage: {} };
  for await (const line of lines(res, o.signal)) {
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.error) throw new PalPalError(`Ollama error: ${j.error}`);
    const m = j.message || {};
    if (m.thinking) {
      out.thinking += m.thinking;
      o.onThinking(m.thinking);
    }
    if (m.content) {
      out.content += m.content;
      o.onDelta(m.content);
    }
    for (const tc of m.tool_calls || []) out.toolCalls.push({ id: tc.id, name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? {} });
    if (j.done) {
      out.usage = { prompt: j.prompt_eval_count, completion: j.eval_count };
      out.finish = j.done_reason;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------ OpenRouter
function orHeaders(): Record<string, string> {
  const key = getSecret('openrouterKey');
  if (!key) throw new PalPalError('No OpenRouter API key is set. Add one in Settings.', 'auth');
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://localhost/pal-pal', 'X-Title': 'Pal Pal' };
}

export async function listOpenRouterModels(): Promise<ModelInfo[]> {
  if (!getSecret('openrouterKey')) return [];
  const res = await safeFetch(OR + '/models', { headers: orHeaders(), signal: AbortSignal.timeout(15000) }, 'OpenRouter');
  if (!res.ok) throw new PalPalError(`OpenRouter returned HTTP ${res.status} when listing models.`);
  const data = ((await res.json()) as any).data || [];
  return data
    .map((m: any): ModelInfo => {
      const sp: string[] = m.supported_parameters || [];
      return {
        id: m.id,
        provider: 'openrouter',
        name: m.name || m.id,
        contextLength: m.context_length || 8192,
        vision: (m.architecture?.input_modalities || []).includes('image'),
        tools: sp.includes('tools'),
        thinking: sp.includes('reasoning') || sp.includes('include_reasoning'),
        maxOutput: m.top_provider?.max_completion_tokens || undefined,
      };
    })
    .sort((a: ModelInfo, b: ModelInfo) => a.name.localeCompare(b.name));
}

/** Validates a key without storing it. */
export async function checkOpenRouterKey(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(OR + '/key', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
    if (res.ok) return { ok: true, message: 'Key is valid.' };
    if (res.status === 401) return { ok: false, message: 'OpenRouter rejected this key (401 Unauthorized).' };
    return { ok: false, message: `OpenRouter returned HTTP ${res.status}.` };
  } catch (e: any) {
    return { ok: false, message: `Could not reach OpenRouter (${e?.cause?.code || e?.message}).` };
  }
}

function toOpenAI(messages: LLMMsg[]) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    const o: any = { role: m.role, content: m.content };
    if (m.images?.length) o.content = [{ type: 'text', text: m.content }, ...m.images.map((u) => ({ type: 'image_url', image_url: { url: u } }))];
    if (m.toolCalls?.length) o.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    return o;
  });
}

async function chatOpenRouter(o: ChatOpts): Promise<ChatResult> {
  const p = effortParams(o.model, o.effort) as any;
  const body: any = { model: o.model.id, messages: toOpenAI(o.messages), stream: true, usage: { include: true } };
  if (o.tools?.length) body.tools = o.tools.map((t) => ({ type: 'function', function: t }));
  if (p.reasoning && !o.noThink) body.reasoning = p.reasoning;
  if (p.max_tokens) body.max_tokens = p.max_tokens;
  if (p.temperature !== undefined) body.temperature = p.temperature;

  const res = await safeFetch(OR + '/chat/completions', { method: 'POST', headers: orHeaders(), body: JSON.stringify(body), signal: o.signal }, 'OpenRouter');
  if (!res.ok) {
    let msg = '';
    try {
      const j = (await res.json()) as any;
      msg = j.error?.message || JSON.stringify(j.error || j);
    } catch {
      /* ignore */
    }
    if (res.status === 401) throw new PalPalError('OpenRouter rejected the API key (401). Check the key in Settings.', 'auth');
    if (res.status === 402) throw new PalPalError(`OpenRouter: insufficient credits. ${msg}`, 'auth');
    if (res.status === 429) throw new PalPalError(`OpenRouter rate limit reached. ${msg}`);
    if (/tool use|support tools|tool calling/i.test(msg)) throw new PalPalError(msg, 'no-tools');
    if (/reasoning/i.test(msg) && res.status === 400) throw new PalPalError(msg, 'no-think');
    throw new PalPalError(`OpenRouter error (HTTP ${res.status}): ${msg || res.statusText}`);
  }
  const out: ChatResult = { content: '', thinking: '', toolCalls: [], usage: {} };
  const partial: { id?: string; name: string; args: string }[] = [];
  for await (const line of lines(res, o.signal)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') break;
    let j: any;
    try {
      j = JSON.parse(payload);
    } catch {
      continue;
    }
    if (j.error) throw new PalPalError(`OpenRouter error: ${j.error.message || JSON.stringify(j.error)}`);
    if (j.usage) out.usage = { prompt: j.usage.prompt_tokens, completion: j.usage.completion_tokens };
    const ch = j.choices?.[0];
    if (!ch) continue;
    const d = ch.delta || {};
    const r = d.reasoning ?? d.reasoning_content;
    if (r) {
      out.thinking += r;
      o.onThinking(r);
    }
    if (d.content) {
      out.content += d.content;
      o.onDelta(d.content);
    }
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? 0;
      partial[i] ||= { name: '', args: '' };
      if (tc.id) partial[i].id = tc.id;
      if (tc.function?.name) partial[i].name += tc.function.name;
      if (tc.function?.arguments) partial[i].args += tc.function.arguments;
    }
    if (ch.finish_reason) out.finish = ch.finish_reason;
  }
  out.toolCalls = partial.filter(Boolean).map((c) => ({ id: c.id, name: c.name, arguments: c.args }));
  return out;
}

export function streamChat(o: ChatOpts): Promise<ChatResult> {
  return o.model.provider === 'ollama' ? chatOllama(o) : chatOpenRouter(o);
}

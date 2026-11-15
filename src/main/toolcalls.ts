/**
 * Tool-call parsing, repair and validation. Pure module (no Electron) so it is unit-testable.
 */
import Ajv, { type ValidateFunction } from 'ajv';
import { jsonrepair } from 'jsonrepair';

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON schema (type: object)
}
export interface RawCall {
  id?: string;
  name: string;
  arguments: unknown;
}
export interface ValidCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export type Validation =
  | { ok: true; call: ValidCall; repairs: string[] }
  | { ok: false; id: string; name: string; error: string };

let idCounter = 0;
export const newCallId = () => `call_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

/** Find the first balanced {...} or [...] starting at or after `from`, respecting strings. */
export function extractBalanced(text: string, from = 0): { start: number; end: number } | null {
  const start = text.slice(from).search(/[{[]/);
  if (start < 0) return null;
  const s = from + start;
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = s; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length === 0) return { start: s, end: i + 1 };
    }
  }
  return null;
}

export type LooseJson = { ok: true; value: any; repaired: boolean } | { ok: false; error: string };

/** Parse JSON, tolerating code fences, trailing commas, single quotes, missing braces, surrounding prose. */
export function parseJsonLoose(input: string): LooseJson {
  let s = String(input ?? '').trim();
  const fence = s.match(/^```[\w-]*\s*\n?([\s\S]*?)\n?```$/);
  if (fence) s = fence[1].trim();
  if (s === '') return { ok: false, error: 'empty string' };
  try {
    return { ok: true, value: JSON.parse(s), repaired: false };
  } catch {
    /* fall through */
  }
  const bal = extractBalanced(s);
  if (bal) {
    const sub = s.slice(bal.start, bal.end);
    try {
      return { ok: true, value: JSON.parse(sub), repaired: true };
    } catch {
      try {
        return { ok: true, value: JSON.parse(jsonrepair(sub)), repaired: true };
      } catch {
        /* fall through */
      }
    }
  }
  try {
    const v = JSON.parse(jsonrepair(s));
    return { ok: true, value: v, repaired: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'invalid JSON' };
  }
}

/** Accept the many shapes models use for a tool call object. */
export function normalizeRaw(obj: any): RawCall | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  let name: unknown;
  let args: unknown;
  if (obj.function && typeof obj.function === 'object') {
    name = obj.function.name;
    args = obj.function.arguments ?? obj.function.parameters;
  } else {
    name = obj.name ?? obj.tool ?? obj.tool_name ?? obj.function ?? obj.action;
    args = obj.arguments ?? obj.parameters ?? obj.args ?? obj.input ?? obj.tool_input ?? obj.action_input;
  }
  if (typeof name !== 'string' || !name.trim()) return null;
  return { id: typeof obj.id === 'string' ? obj.id : undefined, name: name.trim(), arguments: args ?? {} };
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Extract tool calls a model wrote as text. Supported:
 *   <tool_call>{"name":..,"arguments":{..}}</tool_call>   (Hermes / Qwen; closing tag optional)
 *   <function=name>{...}</function>                        (Llama style)
 *   ```json / ```tool_call fenced blocks holding a call object (or array of them)
 *   a message that is nothing but a call object
 * For fenced/bare JSON the tool name must be a known tool, so ordinary JSON answers are left alone.
 */
export function parseTextToolCalls(text: string, knownNames: string[]): { calls: RawCall[]; cleaned: string; malformed: string[] } {
  const calls: RawCall[] = [];
  const malformed: string[] = [];
  const known = new Set(knownNames.map(squash));
  let cleaned = text;

  const takeObjects = (value: any, requireKnown: boolean): RawCall[] => {
    const items = Array.isArray(value) ? value : value?.tool_calls && Array.isArray(value.tool_calls) ? value.tool_calls : [value];
    const out: RawCall[] = [];
    for (const it of items) {
      const n = normalizeRaw(it);
      if (!n) return [];
      if (requireKnown && !known.has(squash(n.name))) return [];
      out.push(n);
    }
    return out;
  };

  // 1. <tool_call> tags
  cleaned = cleaned.replace(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g, (whole, inner: string) => {
    const xmlName = inner.match(/<name>\s*([\s\S]*?)\s*<\/name>/);
    if (xmlName) {
      const xmlArgs = inner.match(/<arguments>\s*([\s\S]*?)\s*<\/arguments>/);
      calls.push({ name: xmlName[1], arguments: xmlArgs ? xmlArgs[1] : {} });
      return '';
    }
    const parsed = parseJsonLoose(inner);
    const got = parsed.ok ? takeObjects(parsed.value, false) : [];
    if (got.length) calls.push(...got);
    else malformed.push(inner.slice(0, 500));
    return '';
  });

  // 2. <function=name>{...}</function>
  cleaned = cleaned.replace(/<function=([\w.:-]+)>\s*([\s\S]*?)\s*<\/function>/g, (_w, name: string, inner: string) => {
    calls.push({ name, arguments: inner.trim() === '' ? {} : inner });
    return '';
  });

  // 3. fenced code blocks
  cleaned = cleaned.replace(/```(json|tool_call|tool_code|tool|tool_use)?[ \t]*\n([\s\S]*?)```/g, (whole, _lang, inner: string) => {
    const t = inner.trim();
    if (!/^[{[]/.test(t)) return whole;
    const parsed = parseJsonLoose(t);
    if (!parsed.ok) return whole;
    const got = takeObjects(parsed.value, true);
    if (!got.length) return whole;
    calls.push(...got);
    return '';
  });

  // 4. the whole message is a call object
  if (calls.length === 0) {
    const t = cleaned.trim();
    if (/^[{[]/.test(t) && /[}\]]$/.test(t)) {
      const parsed = parseJsonLoose(t);
      if (parsed.ok) {
        const got = takeObjects(parsed.value, true);
        if (got.length) {
          calls.push(...got);
          cleaned = '';
        }
      }
    }
  }
  return { calls, cleaned: cleaned.replace(/\n{3,}/g, '\n\n').trim(), malformed };
}

// ---------------------------------------------------------------------------------------------
// Validation + repair
// ---------------------------------------------------------------------------------------------

const ALIASES: Record<string, string[]> = {
  path: ['file', 'filepath', 'filename', 'file_path', 'file_name', 'dir', 'directory', 'folder', 'target'],
  content: ['contents', 'text', 'data', 'body'],
  command: ['cmd', 'script', 'commandline', 'command_line'],
  query: ['q', 'search', 'pattern', 'term', 'keywords'],
  url: ['uri', 'link', 'href'],
  old_text: ['old', 'old_string', 'oldstr', 'search', 'find', 'old_str'],
  new_text: ['new', 'new_string', 'newstr', 'replace', 'replacement', 'new_str'],
};

export class ToolValidator {
  private ajv = new Ajv({ coerceTypes: true, useDefaults: true, allErrors: true, strict: false });
  private cache = new Map<string, ValidateFunction | null>();

  private compiled(tool: ToolDef): ValidateFunction | null {
    const key = tool.name + '\u0000' + JSON.stringify(tool.parameters);
    if (!this.cache.has(key)) {
      try {
        this.cache.set(key, this.ajv.compile(tool.parameters || { type: 'object' }));
      } catch {
        this.cache.set(key, null); // unusable schema (e.g. exotic MCP schema): skip validation
      }
    }
    return this.cache.get(key)!;
  }

  validate(raw: RawCall, tools: ToolDef[]): Validation {
    const id = raw.id || newCallId();
    const repairs: string[] = [];
    const rawName = String(raw.name ?? '').trim();

    // --- tool name
    let tool = tools.find((t) => t.name === rawName);
    if (!tool) {
      const sq = squash(rawName);
      const matches = tools.filter((t) => squash(t.name) === sq || squash(t.name.replace(/^mcp__.*?__/, '')) === sq);
      if (matches.length === 1) {
        tool = matches[0];
        repairs.push(`tool name "${rawName}" corrected to "${tool.name}"`);
      } else {
        return {
          ok: false,
          id,
          name: rawName || '(missing)',
          error: `Unknown tool "${rawName}". Available tools: ${tools.map((t) => t.name).join(', ') || '(none)'}.`,
        };
      }
    }

    // --- arguments -> object
    const props: Record<string, any> = tool.parameters?.properties || {};
    const required: string[] = tool.parameters?.required || [];
    let args: any = raw.arguments;
    if (typeof args === 'string') {
      const s = args.trim();
      if (s === '') args = {};
      else {
        const p = parseJsonLoose(s);
        if (p.ok && p.value && typeof p.value === 'object' && !Array.isArray(p.value)) {
          args = p.value;
          if (p.repaired) repairs.push('arguments JSON was malformed and has been repaired');
        } else if (required.length === 1 && props[required[0]]?.type === 'string') {
          args = { [required[0]]: s };
          repairs.push(`bare string argument wrapped as "${required[0]}"`);
        } else {
          return {
            ok: false,
            id,
            name: tool.name,
            error: `Arguments for "${tool.name}" are not valid JSON (${p.ok ? 'not an object' : p.error}). Send a JSON object matching this schema: ${JSON.stringify(tool.parameters)}`,
          };
        }
      }
    }
    if (args === null || args === undefined) args = {};
    if (typeof args !== 'object' || Array.isArray(args)) {
      if (required.length === 1) {
        args = { [required[0]]: args };
        repairs.push(`non-object argument wrapped as "${required[0]}"`);
      } else {
        return { ok: false, id, name: tool.name, error: `Arguments for "${tool.name}" must be a JSON object. Schema: ${JSON.stringify(tool.parameters)}` };
      }
    }
    args = { ...args };
    // unwrap {"arguments": {...}} double nesting
    const keys = Object.keys(args);
    if (keys.length === 1 && ['arguments', 'parameters', 'args', 'input'].includes(keys[0]) && !(keys[0] in props) && args[keys[0]] && typeof args[keys[0]] === 'object') {
      args = { ...args[keys[0]] };
      repairs.push('unwrapped nested arguments object');
    }

    // --- key repair: case/underscore differences and common aliases
    for (const k of Object.keys(args)) {
      if (k in props) continue;
      const sq = squash(k);
      let target = Object.keys(props).find((p) => squash(p) === sq && !(p in args));
      if (!target) target = Object.keys(props).find((p) => !(p in args) && (ALIASES[p] || []).some((a) => squash(a) === sq));
      if (target) {
        args[target] = args[k];
        delete args[k];
        repairs.push(`argument "${k}" renamed to "${target}"`);
      }
    }
    for (const k of Object.keys(args)) {
      if (args[k] === null && !required.includes(k)) delete args[k];
    }

    // --- schema validation
    const validate = this.compiled(tool);
    if (validate && !validate(args)) {
      const errs = (validate.errors || [])
        .slice(0, 6)
        .map((e) => `${e.instancePath || '(root)'} ${e.message}${e.params && (e.params as any).additionalProperty ? ` "${(e.params as any).additionalProperty}"` : ''}`)
        .join('; ');
      return {
        ok: false,
        id,
        name: tool.name,
        error: `Invalid arguments for "${tool.name}": ${errs}. Expected schema: ${JSON.stringify(tool.parameters)}`,
      };
    }
    return { ok: true, call: { id, name: tool.name, args }, repairs };
  }
}

/** Describe tools in the prompt for models without native tool calling. */
export function textToolPrompt(tools: ToolDef[]): string {
  const list = tools.map((t) => `- ${t.name}: ${t.description}\n  arguments schema: ${JSON.stringify(t.parameters)}`).join('\n');
  return `# Tools
You can call tools. To call one, output exactly this and nothing after it:
<tool_call>{"name": "<tool name>", "arguments": {<arguments as JSON>}}</tool_call>
You may emit several <tool_call> blocks in one reply. After each call you will receive the result in a <tool_result> block; then continue. When you have the final answer, reply normally with no <tool_call>.

Available tools:
${list}`;
}

import { describe, it, expect } from 'vitest';
import { parseJsonLoose, parseTextToolCalls, normalizeRaw, extractBalanced, ToolValidator, type ToolDef } from '../src/main/toolcalls';

const tools: ToolDef[] = [
  {
    name: 'read_file',
    description: 'read',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description: 'edit',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
  { name: 'mcp__files__list_things', description: 'mcp', parameters: { type: 'object', properties: {} } },
];
const names = tools.map((t) => t.name);
const v = new ToolValidator();

describe('parseJsonLoose', () => {
  it('parses valid JSON untouched', () => {
    const r = parseJsonLoose('{"a":1}');
    expect(r).toEqual({ ok: true, value: { a: 1 }, repaired: false });
  });
  it('repairs trailing commas, single quotes, unquoted keys, missing brace', () => {
    for (const s of ['{"a":1,}', "{'a':1}", '{a:1}', '{"a":1']) {
      const r = parseJsonLoose(s);
      expect(r.ok && r.value.a, s).toBe(1);
      expect(r.ok && r.repaired, s).toBe(true);
    }
  });
  it('strips code fences and surrounding prose', () => {
    expect((parseJsonLoose('```json\n{"a":1}\n```') as any).value).toEqual({ a: 1 });
    expect((parseJsonLoose('Sure! Here: {"a":{"b":"}"}} hope that helps') as any).value).toEqual({ a: { b: '}' } });
  });
  it('fails on empty input', () => {
    expect(parseJsonLoose('   ').ok).toBe(false);
  });
});

describe('extractBalanced', () => {
  it('respects braces inside strings and escapes', () => {
    const t = 'x {"a":"}\\"{", "b":[1,{"c":2}]} y';
    const r = extractBalanced(t)!;
    expect(JSON.parse(t.slice(r.start, r.end))).toEqual({ a: '}"{', b: [1, { c: 2 }] });
  });
  it('returns null when unbalanced', () => {
    expect(extractBalanced('{"a":1')).toBeNull();
  });
});

describe('normalizeRaw', () => {
  it('accepts the common shapes', () => {
    expect(normalizeRaw({ name: 'a', arguments: { x: 1 } })).toMatchObject({ name: 'a', arguments: { x: 1 } });
    expect(normalizeRaw({ name: 'a', parameters: { x: 1 } })).toMatchObject({ arguments: { x: 1 } });
    expect(normalizeRaw({ tool: 'a', args: { x: 1 } })).toMatchObject({ name: 'a', arguments: { x: 1 } });
    expect(normalizeRaw({ type: 'function', function: { name: 'a', arguments: '{"x":1}' } })).toMatchObject({ name: 'a', arguments: '{"x":1}' });
    expect(normalizeRaw({ function: 'a', input: {} })).toMatchObject({ name: 'a' });
  });
  it('rejects non-calls', () => {
    expect(normalizeRaw({ foo: 1 })).toBeNull();
    expect(normalizeRaw([1])).toBeNull();
    expect(normalizeRaw('x')).toBeNull();
    expect(normalizeRaw({ name: 5 })).toBeNull();
  });
});

describe('parseTextToolCalls', () => {
  it('parses <tool_call> tags and removes them from the text', () => {
    const r = parseTextToolCalls('Let me look.\n<tool_call>\n{"name":"read_file","arguments":{"path":"a.txt"}}\n</tool_call>', names);
    expect(r.calls).toEqual([{ id: undefined, name: 'read_file', arguments: { path: 'a.txt' } }]);
    expect(r.cleaned).toBe('Let me look.');
  });
  it('parses several tags and an unclosed final tag', () => {
    const r = parseTextToolCalls(
      '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>\n<tool_call>{"name":"read_file","arguments":{"path":"b"}',
      names,
    );
    expect(r.calls.map((c) => (c.arguments as any).path)).toEqual(['a', 'b']);
  });
  it('keeps unknown tool names from tags (so the model gets an error back)', () => {
    const r = parseTextToolCalls('<tool_call>{"name":"nope","arguments":{}}</tool_call>', names);
    expect(r.calls[0].name).toBe('nope');
  });
  it('reports malformed tag bodies', () => {
    const r = parseTextToolCalls('<tool_call>this is not json at all</tool_call>', names);
    expect(r.calls).toHaveLength(0);
    expect(r.malformed).toHaveLength(1);
  });
  it('parses XML-style bodies', () => {
    const r = parseTextToolCalls('<tool_call><name>read_file</name><arguments>{"path":"a"}</arguments></tool_call>', names);
    expect(r.calls[0]).toMatchObject({ name: 'read_file', arguments: '{"path":"a"}' });
  });
  it('parses <function=name> style', () => {
    const r = parseTextToolCalls('<function=read_file>{"path":"a.txt"}</function>', names);
    expect(r.calls[0]).toMatchObject({ name: 'read_file', arguments: '{"path":"a.txt"}' });
  });
  it('parses fenced json blocks only for known tools', () => {
    const call = parseTextToolCalls('I will read it:\n```json\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```', names);
    expect(call.calls).toHaveLength(1);
    expect(call.cleaned).toBe('I will read it:');
    const data = 'Here is your config:\n```json\n{"name":"my-package","version":"1.0.0"}\n```';
    const notCall = parseTextToolCalls(data, names);
    expect(notCall.calls).toHaveLength(0);
    expect(notCall.cleaned).toBe(data);
  });
  it('leaves non-JSON code blocks alone', () => {
    const t = '```python\nprint({"name": "read_file"})\n```';
    expect(parseTextToolCalls(t, names).calls).toHaveLength(0);
    expect(parseTextToolCalls(t, names).cleaned).toBe(t);
  });
  it('parses a bare JSON message and arrays of calls', () => {
    expect(parseTextToolCalls('{"name":"read_file","parameters":{"path":"a"}}', names).calls).toHaveLength(1);
    const arr = parseTextToolCalls('[{"name":"read_file","arguments":{"path":"a"}},{"name":"read_file","arguments":{"path":"b"}}]', names);
    expect(arr.calls).toHaveLength(2);
    expect(arr.cleaned).toBe('');
  });
  it('returns plain text untouched', () => {
    const r = parseTextToolCalls('Just an answer with {braces} and no calls.', names);
    expect(r.calls).toHaveLength(0);
    expect(r.cleaned).toBe('Just an answer with {braces} and no calls.');
  });
});

describe('ToolValidator', () => {
  it('accepts a valid call', () => {
    const r = v.validate({ id: 'x1', name: 'read_file', arguments: { path: 'a.txt' } }, tools);
    expect(r).toEqual({ ok: true, call: { id: 'x1', name: 'read_file', args: { path: 'a.txt' } }, repairs: [] });
  });
  it('parses string arguments and repairs broken JSON', () => {
    const good = v.validate({ name: 'read_file', arguments: '{"path":"a.txt"}' }, tools);
    expect(good.ok && good.call.args).toEqual({ path: 'a.txt' });
    const bad = v.validate({ name: 'read_file', arguments: "{'path': 'a.txt',}" }, tools);
    expect(bad.ok && bad.call.args).toEqual({ path: 'a.txt' });
    expect(bad.ok && bad.repairs.length).toBeGreaterThan(0);
  });
  it('fixes tool-name case/format and MCP short names', () => {
    const a = v.validate({ name: 'ReadFile', arguments: { path: 'a' } }, tools);
    expect(a.ok && a.call.name).toBe('read_file');
    const b = v.validate({ name: 'list_things', arguments: {} }, tools);
    expect(b.ok && b.call.name).toBe('mcp__files__list_things');
  });
  it('rejects unknown tools with the list of valid ones', () => {
    const r = v.validate({ name: 'launch_rockets', arguments: {} }, tools);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unknown tool "launch_rockets".*read_file/);
  });
  it('renames aliased / mis-cased argument keys', () => {
    const r = v.validate({ name: 'read_file', arguments: { file_path: 'a.txt' } }, tools);
    expect(r.ok && r.call.args).toEqual({ path: 'a.txt' });
    const e = v.validate({ name: 'edit_file', arguments: { Path: 'a', old_string: 'x', new_string: 'y' } }, tools);
    expect(e.ok && e.call.args).toEqual({ path: 'a', old_text: 'x', new_text: 'y' });
  });
  it('coerces types and drops nulls for optional args', () => {
    const r = v.validate({ name: 'read_file', arguments: { path: 'a', offset: '10', limit: null } }, tools);
    expect(r.ok && r.call.args).toEqual({ path: 'a', offset: 10 });
  });
  it('wraps a bare string when there is exactly one required string arg', () => {
    const r = v.validate({ name: 'read_file', arguments: 'notes/todo.md' }, tools);
    expect(r.ok && r.call.args).toEqual({ path: 'notes/todo.md' });
  });
  it('unwraps doubly nested arguments', () => {
    const r = v.validate({ name: 'read_file', arguments: { arguments: { path: 'a' } } }, tools);
    expect(r.ok && r.call.args).toEqual({ path: 'a' });
  });
  it('reports missing required and unexpected args with the schema', () => {
    const miss = v.validate({ name: 'edit_file', arguments: { path: 'a' } }, tools);
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.error).toMatch(/required property 'old_text'/);
      expect(miss.error).toMatch(/Expected schema/);
    }
    const extra = v.validate({ name: 'read_file', arguments: { path: 'a', bogus: 1 } }, tools);
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.error).toMatch(/bogus/);
  });
  it('rejects wrong types that cannot be coerced', () => {
    const r = v.validate({ name: 'read_file', arguments: { path: 'a', offset: 'ten' } }, tools);
    expect(r.ok).toBe(false);
  });
  it('rejects unparseable arguments for multi-arg tools', () => {
    const r = v.validate({ name: 'edit_file', arguments: 'just some words' }, tools);
    expect(r.ok).toBe(false);
  });
  it('treats empty/absent arguments as {}', () => {
    expect(v.validate({ name: 'mcp__files__list_things', arguments: '' }, tools).ok).toBe(true);
    expect(v.validate({ name: 'mcp__files__list_things', arguments: null }, tools).ok).toBe(true);
  });
  it('does not crash on an uncompilable schema', () => {
    const odd: ToolDef[] = [{ name: 'odd', description: '', parameters: { type: 'object', properties: { a: { type: 'not-a-type' } } } }];
    expect(v.validate({ name: 'odd', arguments: { a: 1 } }, odd).ok).toBe(true);
  });
});

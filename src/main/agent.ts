/** The agent loop: call model -> validate tool calls -> run tools -> feed results back -> repeat. */
import type { AgentEvent, ApprovalRequest, Chat, ModelInfo, Msg, OutsideAccess, ToolCall } from '../shared/types';
import * as store from './store';
import { buildRequest, estimateTokens } from './context';
import { effectiveCtx, PalPalError, streamChat, type ChatResult } from './providers';
import { parseTextToolCalls, ToolValidator, newCallId, type RawCall, type ToolDef, type Validation } from './toolcalls';
import { builtinTools, isBuiltin, runBuiltin, type ToolResult } from './tools';
import { callMcp, isMcpTool, mcpTools } from './mcp';
import { effectiveOptions, machineId } from './hardware';

interface Run {
  abort: AbortController;
  approvals: Map<string, (ok: boolean) => void>;
}
const runs = new Map<string, Run>();
const validator = new ToolValidator();

/** Outside-folder access is per chat, in memory only: a new chat (or an app restart) starts with everything off. */
const outsideByChat = new Map<string, OutsideAccess>();
export const getOutside = (chatId: string): OutsideAccess => outsideByChat.get(chatId) || { read: false, write: false, modify: false };
export const setOutside = (chatId: string, o: OutsideAccess) => void outsideByChat.set(chatId, { read: !!o.read, write: !!o.write, modify: !!o.modify });

let emit: (e: AgentEvent) => void = () => {};
let findModel: (provider: string, id: string) => ModelInfo | undefined = () => undefined;
export function initAgent(emitter: (e: AgentEvent) => void, modelLookup: typeof findModel): void {
  emit = emitter;
  findModel = modelLookup;
}
export const isRunning = (chatId: string) => runs.has(chatId);

export function stop(chatId: string): void {
  const run = runs.get(chatId);
  if (!run) return;
  run.abort.abort();
  for (const resolve of run.approvals.values()) resolve(false);
  run.approvals.clear();
}
export function resolveApproval(chatId: string, id: string, ok: boolean): void {
  const run = runs.get(chatId);
  const r = run?.approvals.get(id);
  if (r) {
    run!.approvals.delete(id);
    r(ok);
  }
}

function note(chatId: string, turn: number, kind: string, content: string): Msg {
  const m = store.addMessage({ chatId, turn, role: 'note', kind, content });
  emit({ type: 'message', chatId, message: m });
  return m;
}

function truncateOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n… [output truncated by Pal Pal: ${text.length - max} of ${text.length} characters omitted] …\n\n${text.slice(-tail)}`;
}

/** Pull <think>…</think> blocks that some models put in the content into the thinking channel. */
function splitThink(content: string): { content: string; thinking: string } {
  let thinking = '';
  let out = content.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_m, t) => {
    thinking += t;
    return '';
  });
  return { content: out.trim(), thinking: thinking.trim() };
}

async function modelCtx(chat: Chat, model: ModelInfo): Promise<{ ctx: number; overrides: any }> {
  if (model.provider !== 'ollama') return { ctx: model.contextLength || 8192, overrides: {} };
  const { overrides, defaults } = effectiveOptions(model, store.getProfile(await machineId()));
  return { ctx: effectiveCtx(model, chat.effort, defaults.num_ctx, overrides.num_ctx), overrides };
}

export function toolsFor(chat: Chat): ToolDef[] {
  if (!chat.toolsEnabled) return [];
  return [...builtinTools(!!store.getSettings().workFolder), ...mcpTools()];
}

/** Token usage of the chat as it would be sent right now (used by the meter and the context panel). */
export async function measure(chatId: string): Promise<{ used: number; limit: number; parts: any } | null> {
  const chat = store.getChat(chatId);
  if (!chat) return null;
  const model = findModel(chat.provider, chat.model);
  if (!model) return { used: 0, limit: 0, parts: null };
  const tools = toolsFor(chat);
  const req = buildRequest(chat, model, store.getSettings(), tools, !model.tools, store.listMessages(chatId));
  const { ctx } = await modelCtx(chat, model);
  return { used: req.tokens.total, limit: ctx, parts: req.tokens };
}

// ------------------------------------------------------------------------------------------ compaction
const SUMMARY_PROMPT = `You compress conversations between a user and an AI assistant so the conversation can continue with less context.
Write a faithful summary of the transcript below. Keep: the user's goals and preferences, decisions made, facts discovered, file names and paths touched and what was changed in them, commands run and their outcomes, errors hit, and any open tasks. Use short Markdown bullet points under the headings "Goals", "Done so far", "Key facts", "Open items". Do not invent anything. Do not address the user.`;

export async function compactChat(chatId: string, manual: boolean, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
  const chat = store.getChat(chatId);
  if (!chat) return { ok: false, message: 'Chat not found.' };
  const model = findModel(chat.provider, chat.model);
  if (!model) return { ok: false, message: 'Select a model first.' };
  const settings = store.getSettings();
  const all = store.listMessages(chatId);
  const live = all.filter((m) => !m.compacted && m.role !== 'note');
  const turns = [...new Set(live.map((m) => m.turn))].sort((a, b) => a - b);
  let keep = Math.max(1, settings.keepRecentTurns);
  if (turns.length <= keep) keep = manual ? Math.max(1, turns.length - 1) : keep;
  if (turns.length <= keep) return { ok: false, message: 'Nothing to compact yet - the recent turns are always kept intact.' };
  const firstKept = turns[turns.length - keep];
  const old = live.filter((m) => m.turn < firstKept);
  if (!old.length) return { ok: false, message: 'Nothing to compact.' };

  const { ctx, overrides } = await modelCtx(chat, model);
  const budgetChars = Math.max(4000, Math.floor(ctx * 0.55 * 3.6));
  let transcript = old
    .map((m) => {
      if (m.role === 'user') return `USER: ${m.content}${m.images?.length ? ` [${m.images.length} image(s)]` : ''}`;
      if (m.role === 'assistant') return `ASSISTANT: ${m.content}${(m.toolCalls || []).map((c) => `\n[called ${c.name} ${JSON.stringify(c.args).slice(0, 400)}]`).join('')}`;
      return `TOOL RESULT (${m.toolName}): ${m.content.slice(0, 1200)}`;
    })
    .join('\n\n');
  if (transcript.length > budgetChars) transcript = transcript.slice(0, Math.floor(budgetChars * 0.4)) + '\n\n… [middle omitted] …\n\n' + transcript.slice(-Math.floor(budgetChars * 0.6));
  const before = old.reduce((s, m) => s + estimateTokens(m.content), 0) + estimateTokens(chat.summary);
  const ac = new AbortController();
  signal?.addEventListener('abort', () => ac.abort());
  emit({ type: 'status', chatId, text: 'Compacting older turns…' });
  let res: ChatResult;
  const ask = (noThink: boolean) =>
    streamChat({
      model,
      effort: 'low',
      numCtx: ctx,
      overrides,
      noThink,
      signal: ac.signal,
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: (chat.summary ? `Summary of even earlier conversation:\n${chat.summary}\n\n` : '') + `Transcript to summarize:\n\n${transcript}` },
      ],
      onDelta: () => {},
      onThinking: () => {},
    });
  try {
    try {
      res = await ask(false);
    } catch (e: any) {
      if (e?.code !== 'no-think') throw e;
      res = await ask(true);
    }
  } catch (e: any) {
    store.log(chatId, 'error', { where: 'compaction', message: e?.message });
    emit({ type: 'status', chatId, text: '' });
    return { ok: false, message: `Compaction failed: ${e?.message || e}` };
  }
  emit({ type: 'status', chatId, text: '' });
  const summary = splitThink(res.content).content;
  if (!summary) return { ok: false, message: 'Compaction failed: the model returned an empty summary.' };
  store.updateChat(chatId, { summary });
  store.markCompacted(chatId, old[old.length - 1].seq);
  const after = estimateTokens(summary);
  store.log(chatId, 'compaction', { messagesSummarized: old.length, tokensBefore: before, tokensAfter: after, summary });
  note(chatId, store.maxTurn(chatId), 'compaction', `**Compacted ${old.length} older messages (turns ${turns[0]}-${firstKept - 1}): ~${before} → ~${after} tokens.** The last ${keep} turn(s) and your checked context files are kept intact.\n\n${summary}`);
  emit({ type: 'chat-updated', chatId });
  return { ok: true, message: 'Compacted.' };
}

// ------------------------------------------------------------------------------------------ main loop
export async function sendMessage(chatId: string, text: string, images: string[]): Promise<void> {
  if (runs.has(chatId)) return;
  let chat = store.getChat(chatId);
  if (!chat) return;
  const run: Run = { abort: new AbortController(), approvals: new Map() };
  runs.set(chatId, run);
  const turn = store.maxTurn(chatId) + 1;
  emit({ type: 'start', chatId });
  try {
    const user = store.addMessage({ chatId, turn, role: 'user', content: text, images: images.length ? images : undefined });
    emit({ type: 'message', chatId, message: user });
    if (chat.title === 'New chat' && text.trim()) {
      store.updateChat(chatId, { title: text.trim().replace(/\s+/g, ' ').slice(0, 60) });
      emit({ type: 'chat-updated', chatId });
    }
    const model = findModel(chat.provider, chat.model);
    if (!model) {
      note(chatId, turn, 'error', chat.model ? `Model "${chat.model}" is not available right now. Pick another model, or check that ${chat.provider === 'ollama' ? 'Ollama is running and the model is installed' : 'your OpenRouter key is set'}.` : 'No model selected. Pick a model next to the message box.');
      return;
    }
    if (images.length && !model.vision) note(chatId, turn, 'warning', `${model.name} cannot take images, so the attached image(s) were not sent to it.`);
    await runTurn(chat, model, turn, run);
  } catch (e: any) {
    if (e?.code !== 'aborted' && !run.abort.signal.aborted) {
      store.log(chatId, 'error', { message: e?.message, stack: e instanceof PalPalError ? undefined : e?.stack });
      note(chatId, turn, 'error', e instanceof PalPalError ? e.message : `Unexpected error: ${e?.message || e}`);
    }
  } finally {
    if (run.abort.signal.aborted) note(chatId, turn, 'info', 'Stopped.');
    runs.delete(chatId);
    const m = await measure(chatId).catch(() => null);
    if (m) emit({ type: 'usage', chatId, used: m.used, limit: m.limit });
    emit({ type: 'done', chatId });
  }
}

async function runTurn(chat: Chat, model: ModelInfo, turn: number, run: Run): Promise<void> {
  const chatId = chat.id;
  const settings = store.getSettings();
  const signal = run.abort.signal;
  const tools = toolsFor(chat);
  const names = tools.map((t) => t.name);
  let textMode = tools.length > 0 && !model.tools;
  let noThink = false;
  let invalidStreak = 0;
  let warned = false;
  let compactedThisTurn = false;
  const { ctx, overrides } = await modelCtx(chat, model);

  if (textMode && !store.listMessages(chatId).some((m) => m.kind === 'text-tools')) {
    note(chatId, turn, 'text-tools', `${model.name} has no native tool calling. Pal Pal will describe the tools in the prompt and parse tool calls from the model's text, which is less reliable. If it struggles, switch **Tools** off next to the message box to chat without tools.`);
  }

  for (let step = 1; ; step++) {
    if (signal.aborted) return;
    if (step > settings.maxSteps) {
      note(chatId, turn, 'warning', `Reached the limit of ${settings.maxSteps} agent steps for one turn (change it in Settings). Send another message to let the model continue.`);
      return;
    }
    chat = store.getChat(chatId)!;
    let req = buildRequest(chat, model, settings, tools, textMode, store.listMessages(chatId));
    emit({ type: 'usage', chatId, used: req.tokens.total, limit: ctx });

    // ---- context pressure: warn, then auto-compact
    if (req.tokens.total > ctx * settings.compactThreshold && settings.autoCompact && !compactedThisTurn) {
      compactedThisTurn = true;
      note(chatId, turn, 'warning', `This chat is at ~${Math.round((req.tokens.total / ctx) * 100)}% of the model's ${ctx}-token context. Auto-compacting older turns…`);
      const r = await compactChat(chatId, false, signal);
      if (!r.ok && !signal.aborted) note(chatId, turn, 'warning', r.message);
      chat = store.getChat(chatId)!;
      req = buildRequest(chat, model, settings, tools, textMode, store.listMessages(chatId));
      emit({ type: 'usage', chatId, used: req.tokens.total, limit: ctx });
    } else if (req.tokens.total > ctx * settings.warnThreshold && !warned) {
      warned = true;
      note(chatId, turn, 'warning', `This chat is using ~${Math.round((req.tokens.total / ctx) * 100)}% of the model's ${ctx}-token context.${settings.autoCompact ? ` It will auto-compact at ${Math.round(settings.compactThreshold * 100)}%.` : ' Use "Compact chat" or uncheck context files to free space.'}`);
    }
    if (req.tokens.total > ctx && !warned) {
      warned = true;
      note(chatId, turn, 'warning', `The request (~${req.tokens.total} tokens) is larger than the model's context (${ctx}). The model will lose the beginning of it. Uncheck context files or raise the context length in Settings.`);
    }
    if (signal.aborted) return;

    store.log(chatId, 'request', {
      step, provider: model.provider, model: model.id, effort: chat.effort, numCtx: ctx, overrides, toolMode: tools.length ? (textMode ? 'text' : 'native') : 'none',
      tools: textMode ? [] : tools, estimatedTokens: req.tokens, messages: req.messages,
    });

    // ---- model call
    emit({ type: 'reset-stream', chatId });
    const t0 = Date.now();
    let res: ChatResult;
    try {
      res = await streamChat({
        model, messages: req.messages, tools: textMode ? undefined : tools, effort: chat.effort, numCtx: ctx, overrides, noThink, signal,
        onDelta: (t) => emit({ type: 'delta', chatId, text: t }),
        onThinking: (t) => emit({ type: 'thinking', chatId, text: t }),
      });
    } catch (e: any) {
      if (e?.code === 'no-tools' && !textMode && tools.length) {
        textMode = true;
        store.log(chatId, 'info', { message: 'native tools rejected; switching to text tool calls', error: e.message });
        note(chatId, turn, 'text-tools', `${model.name} rejected native tool calling. Falling back to text-based tool calls, which are less reliable. Switch **Tools** off for plain chat if it struggles.`);
        step--;
        continue;
      }
      if (e?.code === 'no-think' && !noThink) {
        noThink = true;
        step--;
        continue;
      }
      throw e;
    }
    const ms = Date.now() - t0;
    store.log(chatId, 'response', { step, ms, usage: res.usage, finish: res.finish, content: res.content, thinking: res.thinking, toolCalls: res.toolCalls });

    // ---- parse tool calls
    const split = splitThink(res.content);
    let content = split.content;
    const thinking = [res.thinking, split.thinking].filter(Boolean).join('\n');
    let rawCalls: RawCall[] = tools.length ? res.toolCalls : [];
    let malformed: string[] = [];
    if (tools.length && rawCalls.length === 0) {
      const parsed = parseTextToolCalls(content, names);
      rawCalls = parsed.calls;
      malformed = parsed.malformed;
      content = parsed.cleaned;
    }
    const validations: Validation[] = rawCalls.map((r) => validator.validate({ ...r, id: r.id || newCallId() }, tools));
    const toolCalls: ToolCall[] = validations.map((v, i) =>
      v.ok ? v.call : { id: v.id, name: v.name, args: typeof rawCalls[i].arguments === 'object' && rawCalls[i].arguments ? (rawCalls[i].arguments as any) : { _raw: String(rawCalls[i].arguments) } },
    );
    if (rawCalls.length || malformed.length) store.log(chatId, 'tool-calls-parsed', { step, validations, malformed });

    const assistant = store.addMessage({
      chatId, turn, role: 'assistant', content, thinking: thinking || undefined, toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: { prompt: res.usage.prompt, completion: res.usage.completion, ms },
    });
    emit({ type: 'reset-stream', chatId });
    emit({ type: 'message', chatId, message: assistant });
    if (res.usage.prompt) emit({ type: 'usage', chatId, used: res.usage.prompt + (res.usage.completion || 0), limit: ctx });

    if (res.finish === 'length' && !toolCalls.length) note(chatId, turn, 'warning', 'The reply was cut off because it hit the output limit for this effort level. Raise the effort, or say "continue".');
    if (toolCalls.length === 0 && malformed.length === 0) {
      if (!content && !thinking) note(chatId, turn, 'warning', 'The model returned an empty reply.');
      return; // final answer
    }

    // ---- run tools
    let anyValid = false;
    const addResult = (id: string, name: string, r: ToolResult) => {
      const body = truncateOutput(r.content, settings.maxToolOutputChars);
      const m = store.addMessage({ chatId, turn, role: 'tool', toolCallId: id, toolName: name, content: body, isError: r.isError, kind: r.blocked ? 'blocked' : undefined });
      store.log(chatId, 'tool-result', { step, id, name, isError: !!r.isError, blocked: !!r.blocked, chars: r.content.length, truncated: body.length < r.content.length, content: body });
      emit({ type: 'message', chatId, message: m });
    };
    for (const bad of malformed) {
      addResult(newCallId(), 'tool_call', { isError: true, content: `Error: your <tool_call> block was not valid JSON and was not executed: ${bad.slice(0, 200)}\nUse exactly: <tool_call>{"name": "...", "arguments": {...}}</tool_call>` });
    }
    for (const v of validations) {
      if (signal.aborted) return;
      if (!v.ok) {
        addResult(v.id, v.name, { content: 'Error: ' + v.error, isError: true });
        continue;
      }
      anyValid = true;
      emit({ type: 'status', chatId, text: `Running ${v.call.name}…` });
      const t1 = Date.now();
      let result: ToolResult;
      try {
        result = await execTool(v.call, chat, turn, run);
      } catch (e: any) {
        result = { content: `Error: tool crashed: ${e?.message || e}`, isError: true };
      }
      if (v.repairs.length) result = { ...result, content: `[Pal Pal note: ${v.repairs.join('; ')}]\n${result.content}` };
      store.log(chatId, 'tool-exec', { step, name: v.call.name, args: v.call.args, ms: Date.now() - t1 });
      emit({ type: 'status', chatId, text: '' });
      if (signal.aborted && !result.content) return;
      addResult(v.call.id, v.call.name, result);
    }
    if (signal.aborted) return;
    if (anyValid) invalidStreak = 0;
    else if (++invalidStreak > settings.maxToolRetries) {
      note(chatId, turn, 'error', `${model.name} produced invalid tool calls ${invalidStreak} times in a row, so the turn was stopped. This model may not be able to use tools reliably - switch **Tools** off for plain chat, or pick a model with native tool support.`);
      return;
    }
  }
}

async function execTool(call: ToolCall, chat: Chat, turn: number, run: Run): Promise<ToolResult> {
  const settings = store.getSettings();
  const chatId = chat.id;
  const approve = (req: Omit<ApprovalRequest, 'id' | 'chatId'>): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (run.abort.signal.aborted) return resolve(false);
      const id = store.uid();
      const full: ApprovalRequest = { ...req, id, chatId };
      store.log(chatId, 'approval-request', full);
      run.approvals.set(id, (ok) => {
        store.log(chatId, 'approval-answer', { id, approved: ok });
        emit({ type: 'approval-done', chatId, id });
        resolve(ok);
      });
      emit({ type: 'approval', chatId, request: full });
    });

  if (isBuiltin(call.name)) {
    return runBuiltin(call.name, call.args, { chatId, turn, root: settings.workFolder, outside: getOutside(chatId), mode: chat.approvalMode, settings, signal: run.abort.signal, approve });
  }
  if (isMcpTool(call.name)) {
    if (chat.approvalMode !== 'full-auto') {
      const ok = await approve({ tool: call.name, title: `Call MCP tool ${call.name}`, detail: JSON.stringify(call.args, null, 2) });
      if (!ok) return { content: 'The user declined this action. Do not retry it; ask the user how to proceed.', isError: true };
    }
    return callMcp(call.name, call.args, run.abort.signal, settings.toolTimeoutSec * 1000);
  }
  return { content: `Error: tool "${call.name}" is no longer available.`, isError: true };
}

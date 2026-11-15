/** Context sources (tree + loading), token estimates, and request assembly. */
import fs from 'node:fs';
import path from 'node:path';
import type { Chat, ContextNode, ModelInfo, Msg, Settings } from '../shared/types';
import type { LLMMsg } from './providers';
import { textToolPrompt, type ToolDef } from './toolcalls';
import { checkPath } from './guard';
import * as store from './store';

/** ~3.6 characters per token is a reasonable cross-model average for English text and code. */
export const estimateTokens = (text: string): number => Math.ceil((text || '').length / 3.6);
export const IMAGE_TOKENS = 800;
const MAX_CONTEXT_FILE_CHARS = 400_000;

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', 'dist', 'out', 'build', '.next', 'target', '.cache', '.obsidian', '.trash', 'release']);
const BINARY_EXT = new Set(
  'png jpg jpeg gif bmp ico webp tif tiff psd mp3 wav flac ogg m4a mp4 mkv avi mov webm zip 7z rar gz tar bz2 xz exe dll so dylib bin dat iso msi pdf doc docx xls xlsx ppt pptx odt ttf otf woff woff2 eot class jar pyc pyd o obj lib a db sqlite sqlite3 gguf safetensors pt pth onnx lock'.split(' '),
);
const isTextName = (name: string) => !BINARY_EXT.has(path.extname(name).slice(1).toLowerCase());

/** Build the checkbox tree: memory, topic files, work-folder files. Token counts are size-based estimates. */
export function buildContextTree(chat: Chat, settings: Settings): ContextNode[] {
  const nodes: ContextNode[] = [];
  nodes.push({ id: 'memory', label: 'Long-term memory (memory.md)', kind: 'file', tokens: estimateTokens(store.readMemory()) });

  const topic = chat.topicId ? store.listTopics().find((t) => t.id === chat.topicId) : null;
  if (topic) {
    const children: ContextNode[] = topic.files.map((f) => {
      let size = 0;
      let missing = false;
      try {
        size = fs.statSync(f.path).size;
      } catch {
        missing = true;
      }
      return { id: 'topic:' + f.id, label: path.basename(f.path), path: f.path, kind: 'file', tokens: Math.ceil(Math.min(size, MAX_CONTEXT_FILE_CHARS) / 3.6), missing };
    });
    nodes.push({ id: 'g:topic', label: `Topic files: ${topic.name}`, kind: 'group', tokens: children.reduce((s, c) => s + c.tokens, 0), children });
  }

  const root = settings.workFolder;
  if (root && fs.existsSync(root)) {
    let count = 0;
    const walk = (dir: string, relDir: string, depth: number): ContextNode[] => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      const out: ContextNode[] = [];
      for (const e of entries) {
        if (count > 6000) break;
        if (e.isSymbolicLink()) continue;
        const relPath = relDir ? relDir + '/' + e.name : e.name;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || depth >= 10) continue;
          const children = walk(path.join(dir, e.name), relPath, depth + 1);
          if (children.length) out.push({ id: 'wfd:' + relPath, label: e.name, kind: 'dir', tokens: children.reduce((s, c) => s + c.tokens, 0), children });
        } else if (e.isFile() && isTextName(e.name)) {
          count++;
          let size = 0;
          try {
            size = fs.statSync(path.join(dir, e.name)).size;
          } catch {
            continue;
          }
          out.push({ id: 'wf:' + relPath, label: e.name, kind: 'file', tokens: Math.ceil(Math.min(size, MAX_CONTEXT_FILE_CHARS) / 3.6) });
        }
      }
      return out;
    };
    const children = walk(root, '', 0);
    nodes.push({ id: 'g:wf', label: `Work folder: ${root}`, kind: 'group', tokens: children.reduce((s, c) => s + c.tokens, 0), children });
  }
  return nodes;
}

function readCapped(p: string): string | null {
  try {
    const buf = fs.readFileSync(p);
    if (buf.subarray(0, 8000).includes(0)) return null;
    const t = buf.toString('utf8');
    return t.length > MAX_CONTEXT_FILE_CHARS ? t.slice(0, MAX_CONTEXT_FILE_CHARS) + '\n… [file truncated]' : t;
  } catch {
    return null;
  }
}

/** Load the context items checked for this chat. */
export function loadContextItems(chat: Chat, settings: Settings): { id: string; label: string; text: string }[] {
  const items: { id: string; label: string; text: string }[] = [];
  const topicFiles = new Map(store.listTopics().flatMap((t) => t.files.map((f) => [f.id, f.path] as const)));
  for (const id of chat.contextSel) {
    if (id === 'memory') {
      const text = store.readMemory().trim();
      if (text) items.push({ id, label: 'Long-term memory', text });
    } else if (id.startsWith('topic:')) {
      const p = topicFiles.get(id.slice(6));
      const text = p ? readCapped(p) : null;
      if (p && text !== null) items.push({ id, label: p, text });
    } else if (id.startsWith('wf:') && settings.workFolder) {
      const g = checkPath(settings.workFolder, id.slice(3), 'read', { read: false, write: false, modify: false });
      const text = g.ok ? readCapped(g.path) : null;
      if (text !== null) items.push({ id, label: id.slice(3), text });
    }
  }
  return items;
}

export interface BuiltRequest {
  messages: LLMMsg[];
  tokens: { system: number; context: number; tools: number; history: number; total: number };
}

/**
 * Assemble one request: system prompt + environment + checked context + (text-mode) tool
 * instructions + summary of compacted turns + live history, converted for the tool mode in use.
 */
export function buildRequest(chat: Chat, model: ModelInfo, settings: Settings, tools: ToolDef[], textMode: boolean, messages: Msg[]): BuiltRequest {
  const env = [
    `Current date: ${new Date().toISOString().slice(0, 10)}`,
    'Operating system: Windows',
    settings.workFolder ? `Work folder: ${settings.workFolder}` : 'No work folder is selected (file and shell tools are unavailable).',
  ].join('\n');
  const sys = settings.systemPrompt.trim() + '\n\n# Environment\n' + env;

  const items = loadContextItems(chat, settings);
  let ctxText = '';
  const mem = items.find((i) => i.id === 'memory');
  const files = items.filter((i) => i.id !== 'memory');
  if (mem) ctxText += `\n\n# Long-term memory (facts the user asked you to keep across chats; not a file in the work folder)\n${mem.text}`;
  if (files.length) ctxText += '\n\n# Context files selected by the user (already loaded - no need to read them again)\n' + files.map((i) => `<file path="${i.label}">\n${i.text}\n</file>`).join('\n');

  const toolText = textMode && tools.length ? '\n\n' + textToolPrompt(tools) : '';
  const summary = chat.summary ? `\n\n# Summary of the earlier part of this conversation\n${chat.summary}` : '';

  const out: LLMMsg[] = [{ role: 'system', content: sys + ctxText + toolText + summary }];
  const native = !textMode && tools.length > 0;
  let pending: { id: string; name: string }[] = [];
  const flush = () => {
    for (const p of pending) out.push({ role: 'tool', toolCallId: p.id, toolName: p.name, content: '(no result - the call was cancelled)' });
    pending = [];
  };
  for (const m of messages) {
    if (m.compacted || m.role === 'note') continue;
    if (m.role === 'tool') {
      const idx = pending.findIndex((p) => p.id === m.toolCallId);
      if (native && idx >= 0) {
        pending.splice(idx, 1);
        out.push({ role: 'tool', toolCallId: m.toolCallId, toolName: m.toolName, content: m.content });
      } else {
        out.push({ role: 'user', content: `<tool_result name="${m.toolName || 'tool'}">\n${m.content}\n</tool_result>` });
      }
      continue;
    }
    flush();
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content, images: model.vision && m.images?.length ? m.images : undefined });
    } else if (m.role === 'assistant') {
      const calls = m.toolCalls || [];
      if (native) {
        out.push({ role: 'assistant', content: m.content, toolCalls: calls.length ? calls : undefined });
        pending = calls.map((c) => ({ id: c.id, name: c.name }));
      } else {
        const tags = calls.map((c) => `<tool_call>${JSON.stringify({ name: c.name, arguments: c.args })}</tool_call>`).join('\n');
        out.push({ role: 'assistant', content: [m.content, tags].filter(Boolean).join('\n') });
      }
    }
  }
  flush();

  const tSys = estimateTokens(sys + summary + toolText);
  const tCtx = estimateTokens(ctxText);
  const tTools = native ? estimateTokens(JSON.stringify(tools)) : 0;
  const tHist = out.slice(1).reduce((s, m) => s + estimateTokens(m.content) + (m.images?.length || 0) * IMAGE_TOKENS + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0) + 4, 0);
  return { messages: out, tokens: { system: tSys, context: tCtx, tools: tTools, history: tHist, total: tSys + tCtx + tTools + tHist } };
}

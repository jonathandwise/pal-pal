/** Built-in tools: files, shell, web, memory. Every file/shell action passes the guardrails in guard.ts. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import type { ApprovalMode, ApprovalRequest, OutsideAccess, Settings } from '../shared/types';
import type { ToolDef } from './toolcalls';
import { checkCommand, checkPath, type Op } from './guard';
import { snapshot } from './checkpoints';
import { appendMemory, uid } from './store';

export interface ToolResult {
  content: string;
  isError?: boolean;
  blocked?: boolean;
}
export interface ToolCtx {
  chatId: string;
  turn: number;
  root: string;
  outside: OutsideAccess;
  mode: ApprovalMode;
  settings: Settings;
  signal: AbortSignal;
  approve: (req: Omit<ApprovalRequest, 'id' | 'chatId'>) => Promise<boolean>;
}

const str = { type: 'string' } as const;
const obj = (properties: Record<string, any>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });

export const FILE_TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Read a text file. Returns its content. Use offset/limit (line numbers, 1-based) for large files.',
    parameters: obj({ path: { ...str, description: 'File path, relative to the work folder' }, offset: { type: 'integer', minimum: 1, description: 'First line to read' }, limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines' } }, ['path']),
  },
  {
    name: 'write_file',
    description: 'Write a file with the given full content, creating it (and parent folders) or overwriting it.',
    parameters: obj({ path: str, content: { ...str, description: 'Complete new file content' } }, ['path', 'content']),
  },
  {
    name: 'create_file',
    description: 'Create a new file. Fails if the file already exists (use write_file or edit_file then).',
    parameters: obj({ path: str, content: str }, ['path', 'content']),
  },
  {
    name: 'edit_file',
    description: 'Modify an existing file by replacing an exact piece of text. old_text must match the file exactly (including whitespace) and be unique unless replace_all is true.',
    parameters: obj({ path: str, old_text: { ...str, description: 'Exact text to find' }, new_text: { ...str, description: 'Replacement text' }, replace_all: { type: 'boolean', default: false } }, ['path', 'old_text', 'new_text']),
  },
  {
    name: 'delete_file',
    description: 'Delete a file, or a folder (recursive must be true for a non-empty folder).',
    parameters: obj({ path: str, recursive: { type: 'boolean', default: false } }, ['path']),
  },
  {
    name: 'list_dir',
    description: 'List files and folders. path defaults to the work folder. recursive lists up to 3 levels deep.',
    parameters: obj({ path: str, recursive: { type: 'boolean', default: false } }, []),
  },
  {
    name: 'search_files',
    description: 'Search the work folder. mode "content" finds lines containing the query inside text files; mode "name" finds files whose name contains the query. Optional glob like "*.ts" limits file names.',
    parameters: obj(
      { query: str, mode: { type: 'string', enum: ['content', 'name'], default: 'content' }, path: { ...str, description: 'Folder to search, defaults to the work folder' }, glob: str, regex: { type: 'boolean', default: false, description: 'Treat query as a regular expression' }, max_results: { type: 'integer', minimum: 1, maximum: 500, default: 50 } },
      ['query'],
    ),
  },
];
export const SHELL_TOOL: ToolDef = {
  name: 'run_command',
  description: 'Run a shell command on Windows with the work folder as the working directory. Returns stdout, stderr and the exit code. Default shell is PowerShell.',
  parameters: obj({ command: str, shell: { type: 'string', enum: ['powershell', 'cmd'], default: 'powershell' }, timeout_sec: { type: 'integer', minimum: 1, maximum: 3600, description: 'Override the default timeout' } }, ['command']),
};
export const WEB_TOOLS: ToolDef[] = [
  { name: 'web_search', description: 'Search the web (DuckDuckGo). Returns titles, URLs and snippets.', parameters: obj({ query: str, max_results: { type: 'integer', minimum: 1, maximum: 20, default: 8 } }, ['query']) },
  { name: 'fetch_page', description: 'Fetch a web page (http/https) and return its readable text.', parameters: obj({ url: str, max_chars: { type: 'integer', minimum: 500, maximum: 100000, default: 15000 } }, ['url']) },
];
export const MEMORY_TOOL: ToolDef = {
  name: 'remember',
  description: "Propose a durable fact for the user's long-term memory file (kept across all chats). One short sentence. The user may approve or decline.",
  parameters: obj({ fact: str }, ['fact']),
};

export function builtinTools(hasWorkFolder: boolean): ToolDef[] {
  return [...(hasWorkFolder ? [...FILE_TOOLS, SHELL_TOOL] : []), ...WEB_TOOLS, MEMORY_TOOL];
}
export const isBuiltin = (name: string) => [...FILE_TOOLS, SHELL_TOOL, ...WEB_TOOLS, MEMORY_TOOL].some((t) => t.name === name);

// ------------------------------------------------------------------------------------------ helpers
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', 'dist', 'out', 'build', '.next', 'target', '.cache', '.obsidian', '.trash']);
const blocked = (reason: string): ToolResult => ({ content: reason, isError: true, blocked: true });
const fail = (msg: string): ToolResult => ({ content: 'Error: ' + msg, isError: true });
const DENIED: ToolResult = { content: 'The user declined this action. Do not retry it; ask the user how to proceed.', isError: true };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more characters]` : s);

function needsApproval(mode: ApprovalMode, kind: 'edit' | 'delete' | 'command' | 'other', inside: boolean): boolean {
  if (mode === 'full-auto') return false;
  if (mode === 'auto-edits') return !(kind === 'edit' && inside);
  return true;
}
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
const rel = (root: string, p: string) => {
  const r = path.relative(fs.realpathSync.native(root), p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p;
};
function globToRe(glob: string): RegExp {
  const g = glob.replace(/^.*[\\/]/, '');
  return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}
function* walk(dir: string, depth: number, maxDepth: number): Generator<{ full: string; isDir: boolean; depth: number }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // never follow links/junctions while walking
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield { full, isDir: true, depth };
      if (!SKIP_DIRS.has(e.name) && depth < maxDepth) yield* walk(full, depth + 1, maxDepth);
    } else if (e.isFile()) yield { full, isDir: false, depth };
  }
}

// ------------------------------------------------------------------------------------------ executor
export async function runBuiltin(name: string, a: any, ctx: ToolCtx): Promise<ToolResult> {
  const guard = (target: string, op: Op) => checkPath(ctx.root, target, op, ctx.outside);
  try {
    switch (name) {
      case 'read_file': {
        const g = guard(a.path, 'read');
        if (!g.ok) return blocked(g.reason);
        if (!fs.existsSync(g.path)) return fail(`File not found: ${a.path}`);
        const st = fs.statSync(g.path);
        if (st.isDirectory()) return fail(`${a.path} is a folder; use list_dir.`);
        if (st.size > 5 * 1024 * 1024) return fail(`File is ${(st.size / 1048576).toFixed(1)} MB - too large to read whole. Use search_files, or a shell command, to inspect part of it.`);
        const buf = fs.readFileSync(g.path);
        if (isBinary(buf)) return fail(`${a.path} looks like a binary file (${st.size} bytes) and cannot be read as text.`);
        const text = buf.toString('utf8').replace(/^﻿/, '');
        if (!a.offset && !a.limit) return { content: text === '' ? '(empty file)' : text };
        const all = text.split(/\r?\n/);
        const from = (a.offset || 1) - 1;
        const part = all.slice(from, a.limit ? from + a.limit : undefined);
        return { content: `[lines ${from + 1}-${from + part.length} of ${all.length}]\n` + part.join('\n') };
      }
      case 'write_file':
      case 'create_file': {
        const pre = guard(a.path, 'write');
        const exists = pre.ok ? fs.existsSync(pre.path) : false;
        if (name === 'create_file' && exists) return fail(`${a.path} already exists. Use write_file to overwrite or edit_file to change it.`);
        const g = exists ? guard(a.path, 'modify') : pre;
        if (!g.ok) return blocked(g.reason);
        if (exists && fs.statSync(g.path).isDirectory()) return fail(`${a.path} is a folder.`);
        let before = '';
        if (exists) {
          const b = fs.readFileSync(g.path);
          before = isBinary(b) ? `(binary file, ${b.length} bytes)` : b.toString('utf8');
        }
        if (needsApproval(ctx.mode, 'edit', g.inside)) {
          const ok = await ctx.approve({
            tool: name,
            title: `${exists ? 'Overwrite' : 'Create'} file ${g.path}`,
            detail: `${exists ? 'Overwrite' : 'Create'} ${g.path} (${a.content.length} characters)`,
            diff: { before: clip(before, 20000), after: clip(a.content, 20000) },
            outside: !g.inside,
          });
          if (!ok) return DENIED;
        }
        snapshot(ctx.chatId, ctx.turn, g.path);
        fs.mkdirSync(path.dirname(g.path), { recursive: true });
        fs.writeFileSync(g.path, a.content);
        return { content: `${exists ? 'Overwrote' : 'Created'} ${rel(ctx.root, g.path)} (${a.content.length} characters).` };
      }
      case 'edit_file': {
        const g = guard(a.path, 'modify');
        if (!g.ok) return blocked(g.reason);
        if (!fs.existsSync(g.path)) return fail(`File not found: ${a.path}`);
        if (fs.statSync(g.path).isDirectory()) return fail(`${a.path} is a folder.`);
        const buf = fs.readFileSync(g.path);
        if (isBinary(buf)) return fail(`${a.path} is a binary file.`);
        const text = buf.toString('utf8');
        let oldT: string = a.old_text;
        let newT: string = a.new_text;
        if (oldT === '') return fail('old_text must not be empty.');
        if (!text.includes(oldT) && text.includes('\r\n')) {
          // model wrote \n, file uses \r\n
          const o2 = oldT.replace(/\r?\n/g, '\r\n');
          if (text.includes(o2)) {
            oldT = o2;
            newT = newT.replace(/\r?\n/g, '\r\n');
          }
        }
        const count = text.split(oldT).length - 1;
        if (count === 0) return fail(`old_text was not found in ${a.path}. It must match exactly, including whitespace and indentation. Read the file again and copy the text precisely.`);
        if (count > 1 && !a.replace_all) return fail(`old_text occurs ${count} times in ${a.path}. Include more surrounding text to make it unique, or set replace_all to true.`);
        const next = a.replace_all ? text.split(oldT).join(newT) : text.replace(oldT, () => newT);
        if (needsApproval(ctx.mode, 'edit', g.inside)) {
          const ok = await ctx.approve({
            tool: name,
            title: `Edit file ${g.path}`,
            detail: `Replace ${count > 1 ? count + ' occurrences' : '1 occurrence'} in ${g.path}`,
            diff: { before: clip(oldT, 20000), after: clip(newT, 20000) },
            outside: !g.inside,
          });
          if (!ok) return DENIED;
        }
        snapshot(ctx.chatId, ctx.turn, g.path);
        fs.writeFileSync(g.path, next);
        return { content: `Edited ${rel(ctx.root, g.path)}: replaced ${count} occurrence${count > 1 ? 's' : ''}.` };
      }
      case 'delete_file': {
        const g = guard(a.path, 'modify');
        if (!g.ok) return blocked(g.reason);
        if (g.path.toLowerCase() === fs.realpathSync.native(ctx.root).toLowerCase()) return blocked('Blocked: deleting the work folder itself is not allowed.');
        let st: fs.Stats;
        try {
          st = fs.lstatSync(path.resolve(ctx.root, a.path));
        } catch {
          return fail(`Not found: ${a.path}`);
        }
        // A link is removed as a link (never its target's contents).
        const target = st.isSymbolicLink() ? path.resolve(ctx.root, a.path) : g.path;
        const isDir = st.isDirectory() && !st.isSymbolicLink();
        if (isDir && fs.readdirSync(target).length > 0 && !a.recursive) return fail(`${a.path} is a non-empty folder. Set recursive to true to delete it and everything inside.`);
        if (needsApproval(ctx.mode, 'delete', g.inside)) {
          const ok = await ctx.approve({ tool: name, title: `Delete ${isDir ? 'folder' : 'file'} ${target}`, detail: `Delete ${target}${isDir ? ' and everything inside it' : ''}`, outside: !g.inside });
          if (!ok) return DENIED;
        }
        snapshot(ctx.chatId, ctx.turn, target);
        fs.rmSync(target, { recursive: isDir, force: true });
        return { content: `Deleted ${rel(ctx.root, target)}.` };
      }
      case 'list_dir': {
        const g = guard(a.path || '.', 'read');
        if (!g.ok) return blocked(g.reason);
        if (!fs.existsSync(g.path)) return fail(`Folder not found: ${a.path}`);
        if (!fs.statSync(g.path).isDirectory()) return fail(`${a.path} is a file.`);
        const out: string[] = [];
        let n = 0;
        for (const e of walk(g.path, 0, a.recursive ? 2 : 0)) {
          if (++n > 600) {
            out.push('… [listing truncated at 600 entries]');
            break;
          }
          const r = path.relative(g.path, e.full);
          out.push(e.isDir ? r + path.sep : `${r}  (${fs.statSync(e.full).size} bytes)`);
        }
        return { content: out.length ? out.join('\n') : '(empty folder)' };
      }
      case 'search_files': {
        const g = guard(a.path || '.', 'read');
        if (!g.ok) return blocked(g.reason);
        if (!fs.existsSync(g.path)) return fail(`Folder not found: ${a.path}`);
        const max = a.max_results || 50;
        const globRe = a.glob ? globToRe(a.glob) : null;
        let re: RegExp;
        try {
          re = a.regex ? new RegExp(a.query, 'i') : new RegExp(a.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        } catch (e: any) {
          return fail(`Invalid regular expression: ${e.message}`);
        }
        const hits: string[] = [];
        let scanned = 0;
        for (const e of walk(g.path, 0, 12)) {
          if (ctx.signal.aborted || hits.length >= max || scanned > 20000) break;
          if (e.isDir) continue;
          const base = path.basename(e.full);
          if (globRe && !globRe.test(base)) continue;
          scanned++;
          const r = path.relative(g.path, e.full);
          if (a.mode === 'name') {
            if (re.test(base)) hits.push(r);
            continue;
          }
          let st: fs.Stats;
          try {
            st = fs.statSync(e.full);
          } catch {
            continue;
          }
          if (st.size > 2 * 1024 * 1024) continue;
          const buf = fs.readFileSync(e.full);
          if (isBinary(buf)) continue;
          const ls = buf.toString('utf8').split(/\r?\n/);
          for (let i = 0; i < ls.length && hits.length < max; i++) if (re.test(ls[i])) hits.push(`${r}:${i + 1}: ${ls[i].trim().slice(0, 240)}`);
        }
        return { content: hits.length ? hits.join('\n') + (hits.length >= max ? `\n… [stopped at ${max} results]` : '') : `No matches for "${a.query}".` };
      }
      case 'run_command':
        return await runCommand(a, ctx);
      case 'web_search':
        return await webSearch(a.query, a.max_results || 8, ctx.signal);
      case 'fetch_page':
        return await fetchPage(a.url, a.max_chars || 15000, ctx.signal);
      case 'remember': {
        const fact = String(a.fact).trim();
        if (!fact) return fail('fact is empty.');
        if (ctx.mode !== 'full-auto') {
          const ok = await ctx.approve({ tool: name, title: 'Add to long-term memory?', detail: fact });
          if (!ok) return { content: 'The user declined to save this to memory.' };
        }
        appendMemory(fact);
        return { content: 'Saved to long-term memory.' };
      }
    }
    return fail(`Unknown tool ${name}`);
  } catch (e: any) {
    return fail(e?.code === 'EPERM' || e?.code === 'EACCES' ? `Permission denied: ${e.message}` : e?.message || String(e));
  }
}

// ------------------------------------------------------------------------------------------ shell
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } catch {
    /* already gone */
  }
}

async function runCommand(a: any, ctx: ToolCtx): Promise<ToolResult> {
  const command = String(a.command);
  const check = checkCommand(command, ctx.root, ctx.outside);
  if (!check.ok) return blocked(check.reason!);
  const shell = a.shell === 'cmd' ? 'cmd' : 'powershell';
  const timeoutSec = a.timeout_sec || ctx.settings.toolTimeoutSec;
  if (needsApproval(ctx.mode, 'command', check.outsidePaths.length === 0)) {
    const ok = await ctx.approve({
      tool: 'run_command',
      title: `Run ${shell === 'cmd' ? 'cmd' : 'PowerShell'} command`,
      detail: `${command}\n\n# working directory: ${ctx.root}\n# timeout: ${timeoutSec}s`,
      outside: check.outsidePaths.length > 0,
    });
    if (!ok) return DENIED;
  }
  return new Promise<ToolResult>((resolve) => {
    const child =
      shell === 'cmd'
        ? spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd: ctx.root, windowsHide: true, windowsVerbatimArguments: false })
        : spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + command], { cwd: ctx.root, windowsHide: true });
    let out = '';
    let err = '';
    let done = false;
    const cap = 400_000;
    child.stdout.on('data', (d) => out.length < cap && (out += d.toString('utf8')));
    child.stderr.on('data', (d) => err.length < cap && (err += d.toString('utf8')));
    child.stdin.end();
    const finish = (note: string, code: number | null, isError: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      const parts = [out.trimEnd() && `stdout:\n${out.trimEnd()}`, err.trimEnd() && `stderr:\n${err.trimEnd()}`, note || `exit code: ${code}`].filter(Boolean);
      resolve({ content: parts.join('\n\n'), isError });
    };
    const onAbort = () => {
      killTree(child.pid);
      finish('[command cancelled by the user]', null, true);
    };
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish(`[command timed out after ${timeoutSec}s and was killed]`, null, true);
    }, timeoutSec * 1000);
    ctx.signal.addEventListener('abort', onAbort);
    if (ctx.signal.aborted) onAbort();
    child.on('error', (e) => finish(`[failed to start: ${e.message}]`, null, true));
    child.on('close', (code) => finish('', code, code !== 0));
  });
}

// ------------------------------------------------------------------------------------------ web
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", mdash: '—', ndash: '–', hellip: '…' };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => ENT[e.toLowerCase()] ?? (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10) || 32) : m));
const strip = (html: string) => decode(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

export function htmlToText(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const body = html
    .replace(/<(script|style|noscript|svg|head|nav|footer|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');
  const text = decode(body).replace(/[ \t\r]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return (title ? `# ${strip(title[1])}\n\n` : '') + text;
}

async function webSearch(query: string, max: number, signal: AbortSignal): Promise<ToolResult> {
  let html: string;
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
    if (!res.ok && res.status !== 202) return fail(`DuckDuckGo returned HTTP ${res.status}.`);
    html = await res.text();
  } catch (e: any) {
    return fail(`Web search failed - network problem (${e?.cause?.code || e?.message}).`);
  }
  const results: string[] = [];
  for (const chunk of html.split(/class="[^"]*\bresult__body\b/).slice(1)) {
    const a = chunk.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) || chunk.match(/href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decode(a[1]);
    const u = url.match(/[?&]uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ad
    const sn = chunk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    results.push(`${results.length + 1}. ${strip(a[2])}\n   ${url}\n   ${sn ? strip(sn[1]) : ''}`);
    if (results.length >= max) break;
  }
  if (!results.length) return /anomaly|captcha|challenge/i.test(html) ? fail('DuckDuckGo is rate-limiting this PC right now. Wait a minute and try again.') : { content: `No results for "${query}".` };
  return { content: results.join('\n') };
}

async function fetchPage(url: string, maxChars: number, signal: AbortSignal): Promise<ToolResult> {
  if (!/^https?:\/\//i.test(url)) return fail('Only http:// and https:// URLs can be fetched.');
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
    if (!res.ok) return fail(`The page returned HTTP ${res.status} ${res.statusText}.`);
    const type = res.headers.get('content-type') || '';
    if (!/text|json|xml|javascript/i.test(type)) return fail(`Unsupported content type "${type}" - only text pages can be fetched.`);
    const raw = (await res.text()).slice(0, 3_000_000);
    const text = /html/i.test(type) ? htmlToText(raw) : raw;
    return { content: text.length > maxChars ? text.slice(0, maxChars) + `\n… [page truncated: ${text.length - maxChars} more characters]` : text || '(page had no readable text)' };
  } catch (e: any) {
    if (signal.aborted) return fail('Cancelled.');
    return fail(`Could not fetch the page (${e?.name === 'TimeoutError' ? 'timed out' : e?.cause?.code || e?.message}).`);
  }
}

export const newApprovalId = uid;

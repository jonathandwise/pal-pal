/**
 * Path guardrails. Everything the AI does to the file system goes through checkPath();
 * every shell command goes through checkCommand(). Pure Node, no Electron imports, so it is unit-testable.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { OutsideAccess } from '../shared/types';

export type Op = 'read' | 'write' | 'modify';
export type GuardResult =
  | { ok: true; path: string; inside: boolean }
  | { ok: false; reason: string };

const WIN = process.platform === 'win32';
const norm = (p: string) => (WIN ? p.toLowerCase() : p);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function isInside(rootReal: string, targetReal: string): boolean {
  const rel = path.relative(norm(rootReal), norm(targetReal));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false; // different drive
  return !(rel === '..' || rel.startsWith('..' + path.sep));
}

/**
 * Resolve the real location of a path that may not exist yet: realpath of the deepest
 * existing ancestor (which follows symlinks AND junctions, and expands 8.3 short names),
 * plus the not-yet-existing remainder. Dangling symlinks are followed manually.
 * Throws on anything unexpected (permission errors, link loops) so callers fail closed.
 */
export function realpathDeep(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (let hops = 0; hops < 200; hops++) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.slice().reverse()) : real;
    } catch (e: any) {
      if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e;
      // Dangling link? lstat succeeds where realpath failed.
      let link: string | null = null;
      try {
        if (fs.lstatSync(cur).isSymbolicLink()) link = fs.readlinkSync(cur);
      } catch {
        /* does not exist at all */
      }
      if (link !== null) {
        cur = path.resolve(path.dirname(cur), link);
        continue;
      }
      const parent = path.dirname(cur);
      if (parent === cur) return rest.length ? path.join(cur, ...rest.slice().reverse()) : cur;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  throw new Error('Too many levels of links');
}

/** Syntactic checks that reject paths Windows interprets in surprising ways. */
export function lexicalProblem(target: string): string | null {
  if (typeof target !== 'string' || target.trim() === '') return 'empty path';
  if (target.includes('\0')) return 'path contains a NUL character';
  if (WIN) {
    const t = target.replace(/\//g, '\\');
    if (/^\\\\[?.]\\/.test(t)) return 'device / extended-length path prefixes (\\\\?\\ or \\\\.\\) are not allowed';
    const afterDrive = /^[A-Za-z]:/.test(t) ? t.slice(2) : t;
    if (/^[A-Za-z]:[^\\]/.test(t) && t.length > 2) return 'drive-relative paths (C:foo) are not allowed';
    if (afterDrive.includes(':')) return 'alternate data streams / extra ":" in path are not allowed';
    for (const seg of afterDrive.split('\\')) {
      if (seg === '' || seg === '.' || seg === '..') continue;
      if (/[. ]$/.test(seg)) return `path segment "${seg}" ends with a dot or space`;
      if (RESERVED.test(seg)) return `"${seg}" is a reserved device name`;
      if (/[<>"|?*]/.test(seg)) return `path segment "${seg}" contains an invalid character`;
    }
  }
  return null;
}

const OP_LABEL: Record<Op, string> = {
  read: 'Read',
  write: 'Write (create new)',
  modify: 'Modify (change/delete existing)',
};

/**
 * Decide whether `target` may be accessed for `op`.
 * Relative paths resolve against the work folder. Inside the work folder (after resolving
 * links) everything is allowed; outside needs the matching per-chat outside-access flag.
 */
export function checkPath(root: string, target: string, op: Op, outside: OutsideAccess): GuardResult {
  if (!root) return { ok: false, reason: 'No work folder is selected.' };
  const lex = lexicalProblem(target);
  if (lex) return { ok: false, reason: `Blocked path "${target}": ${lex}.` };
  let rootReal: string;
  let real: string;
  const abs = path.resolve(root, target);
  try {
    rootReal = fs.realpathSync.native(root);
    real = realpathDeep(abs);
  } catch (e: any) {
    return { ok: false, reason: `Blocked path "${target}": could not resolve it safely (${e?.code || e?.message}).` };
  }
  if (isInside(rootReal, real)) return { ok: true, path: real, inside: true };
  if (outside[op]) return { ok: true, path: real, inside: false };
  const via = norm(abs) !== norm(real) ? ' (reached through a symlink/junction)' : '';
  return {
    ok: false,
    reason: `Blocked: "${target}" resolves to ${real}${via}, which is outside the work folder. Outside-folder "${OP_LABEL[op]}" access is off for this chat.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Shell command screening (best effort - a shell is Turing complete, see README).
// ---------------------------------------------------------------------------------------------

const MUTATING =
  /(>{1,2})|\b(remove-item|rm|del|erase|rd|rmdir|set-content|add-content|out-file|new-item|ni|mkdir|md|move-item|mv|move|copy-item|cp|copy|xcopy|robocopy|rename-item|ren|rni|clear-content|tee|tee-object|export-[a-z]+|expand-archive|compress-archive|icacls|attrib|mklink|start-bitstransfer|set-itemproperty|new-itemproperty|reg|format|takeown|cipher|setx|git\s+clone|tar|unzip|7z)\b|-outfile\b|\s-o\s/i;

const ENV_NAMES = [
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'PUBLIC', 'ONEDRIVE', 'SYSTEMDRIVE', 'ALLUSERSPROFILE', 'COMMONPROGRAMFILES',
];

function envLookup(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const up = name.toUpperCase();
  if (up === 'HOME' || up === 'PSHOME') return env.USERPROFILE || env.HOME;
  if (!ENV_NAMES.includes(up)) return undefined;
  for (const k of Object.keys(env)) if (k.toUpperCase() === up) return env[k];
  return undefined;
}

/** Expand %VAR%, $env:VAR, ${env:VAR}, $HOME and a leading ~ so the result can be path-checked. */
export function expandEnv(token: string, env: NodeJS.ProcessEnv = process.env): { text: string; unknown: boolean } {
  let unknown = false;
  const sub = (whole: string, name: string) => {
    const v = envLookup(name, env);
    if (v === undefined) {
      unknown = true;
      return whole;
    }
    return v;
  };
  let text = token
    .replace(/%([A-Za-z_()0-9]+)%/g, sub)
    .replace(/\$\{env:([A-Za-z_()0-9]+)\}/gi, sub)
    .replace(/\$env:([A-Za-z_0-9]+)/gi, sub)
    .replace(/\$(HOME)\b/gi, sub);
  if (/^~(?=$|[\\/])/.test(text)) text = (env.USERPROFILE || env.HOME || '~') + text.slice(1);
  return { text, unknown };
}

export interface CommandCheck {
  ok: boolean;
  reason?: string;
  outsidePaths: string[];
  mutating: boolean;
}

/**
 * Screen a shell command for references to paths outside the work folder.
 * Finds: absolute drive paths, UNC paths, rooted paths, ~ and env-var paths, and ../ traversal,
 * in bare, quoted and key=value positions. Encoded PowerShell commands are refused outright
 * because they cannot be inspected.
 */
export function checkCommand(
  command: string,
  root: string,
  outside: OutsideAccess,
  env: NodeJS.ProcessEnv = process.env,
): CommandCheck {
  const mutating = MUTATING.test(command);
  const allOutside = outside.read && outside.write && outside.modify;
  if (!root) return { ok: false, reason: 'No work folder is selected.', outsidePaths: [], mutating };

  if (!allOutside && /(^|\s)-(e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)\s+[A-Za-z0-9+/=]{16,}/i.test(command)) {
    return {
      ok: false,
      reason: 'Blocked: encoded PowerShell commands cannot be inspected by the folder guardrail.',
      outsidePaths: [],
      mutating,
    };
  }

  const candidates = new Set<string>();
  const add = (s: string) => {
    const t = s.trim().replace(/^[(\[{@&]+/, '').replace(/[;,)\]}|]+$/, '');
    if (t) candidates.add(t);
  };
  // 1. tokens: "double quoted", 'single quoted', bare
  const tokenRe = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(command))) {
    const tok = m[1] ?? m[2] ?? m[3] ?? '';
    add(tok);
    const eq = tok.indexOf('=');
    if (eq > 0) add(tok.slice(eq + 1));
    const colon = tok.match(/^-[A-Za-z]+:(.+)$/); // -Path:C:\x
    if (colon) add(colon[1]);
  }
  // 2. embedded absolute paths anywhere in the string
  const embedded = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'|<>;,)]*|(?<![\\/\w:.])\\\\[^\s"'|<>;,)]+/g;
  while ((m = embedded.exec(command))) add(m[0]);

  let rootReal: string;
  try {
    rootReal = fs.realpathSync.native(root);
  } catch {
    return { ok: false, reason: 'Work folder does not exist.', outsidePaths: [], mutating };
  }

  const outsidePaths: string[] = [];
  for (const raw of candidates) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue; // URL
    const { text } = expandEnv(raw, env);
    const t = text.replace(/\//g, '\\');
    const looksPath =
      /^[A-Za-z]:(\\|$)/.test(t) || // drive absolute, or bare "D:"
      /^\\\\/.test(t) || // UNC
      /^\\[^\\]?/.test(t) && (text.startsWith('\\') || /^\/[^/\s]*[\\/]/.test(text) || text === '/') || // rooted (not /flag)
      /(^|\\)\.\.(\\|$)/.test(t); // traversal
    // Plain relative tokens are checked too: they can only escape through a symlink/junction.
    const relative = !/^[\\-]/.test(t) && t.length < 1024;
    if (!looksPath && !relative) continue;
    if (/^\\\\[?.]\\/.test(t)) {
      outsidePaths.push(raw);
      continue;
    }
    try {
      const real = realpathDeep(path.resolve(root, t));
      if (!isInside(rootReal, real)) outsidePaths.push(real);
    } catch {
      outsidePaths.push(raw);
    }
  }

  if (outsidePaths.length === 0) return { ok: true, outsidePaths, mutating };
  const uniq = [...new Set(outsidePaths)];
  if (!outside.read) {
    return {
      ok: false,
      outsidePaths: uniq,
      mutating,
      reason: `Blocked: the command references path(s) outside the work folder: ${uniq.join(', ')}. Outside-folder Read access is off for this chat.`,
    };
  }
  if (mutating && !(outside.write && outside.modify)) {
    return {
      ok: false,
      outsidePaths: uniq,
      mutating,
      reason: `Blocked: the command can change files and references path(s) outside the work folder: ${uniq.join(', ')}. Outside-folder Write and Modify access must both be on for this chat.`,
    };
  }
  return { ok: true, outsidePaths: uniq, mutating };
}

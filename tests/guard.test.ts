import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPath, checkCommand, isInside, lexicalProblem, realpathDeep, expandEnv } from '../src/main/guard';

const NONE = { read: false, write: false, modify: false };
const ALL = { read: true, write: true, modify: true };

let base: string;
let root: string;
let outsideDir: string;
let canSymlinkFile = true;

beforeAll(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'palpal-guard-')));
  root = path.join(base, 'work');
  outsideDir = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');
  // junction (no admin needed on Windows) pointing out of the work folder
  fs.symlinkSync(outsideDir, path.join(root, 'jx'), 'junction');
  // junction that stays inside
  fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'jin'), 'junction');
  try {
    fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(root, 'link.txt'), 'file');
    fs.symlinkSync(path.join(outsideDir, 'not-there.txt'), path.join(root, 'dangling.txt'), 'file');
  } catch {
    canSymlinkFile = false; // needs Developer Mode / admin on Windows
  }
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('isInside', () => {
  it('handles equal, child, sibling-prefix and parent', () => {
    expect(isInside('C:\\work', 'C:\\work')).toBe(true);
    expect(isInside('C:\\work', 'C:\\work\\a\\b')).toBe(true);
    expect(isInside('C:\\work', 'C:\\workshop\\a')).toBe(false);
    expect(isInside('C:\\work', 'C:\\')).toBe(false);
    expect(isInside('C:\\work', 'D:\\work')).toBe(false);
    expect(isInside('C:\\work', 'C:\\work\\..foo')).toBe(true);
  });
  it('is case-insensitive on Windows', () => {
    if (process.platform === 'win32') expect(isInside('C:\\Work', 'c:\\work\\x')).toBe(true);
  });
});

describe('checkPath inside the work folder', () => {
  it('allows relative, nested and absolute-inside paths', () => {
    expect(checkPath(root, 'a.txt', 'read', NONE).ok).toBe(true);
    expect(checkPath(root, 'sub/new/deep/file.txt', 'write', NONE).ok).toBe(true);
    expect(checkPath(root, path.join(root, 'a.txt'), 'modify', NONE).ok).toBe(true);
    expect(checkPath(root, '.', 'read', NONE).ok).toBe(true);
  });
  it('allows traversal that stays inside', () => {
    expect(checkPath(root, 'sub/../a.txt', 'read', NONE).ok).toBe(true);
  });
  it('allows a junction that points inside', () => {
    const r = checkPath(root, 'jin/x.txt', 'write', NONE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path.toLowerCase()).toBe(path.join(root, 'sub', 'x.txt').toLowerCase());
  });
});

describe('checkPath blocks escapes', () => {
  it('blocks ../ traversal', () => {
    for (const p of ['../outside/secret.txt', 'sub/../../outside/secret.txt', '..', '..\\..\\x', 'sub\\..\\..\\outside']) {
      const r = checkPath(root, p, 'read', NONE);
      expect(r.ok, p).toBe(false);
    }
  });
  it('blocks absolute paths elsewhere', () => {
    expect(checkPath(root, path.join(outsideDir, 'secret.txt'), 'read', NONE).ok).toBe(false);
    expect(checkPath(root, 'C:\\Windows\\System32\\drivers\\etc\\hosts', 'read', NONE).ok).toBe(false);
    expect(checkPath(root, '\\Windows\\win.ini', 'read', NONE).ok).toBe(false);
    expect(checkPath(root, '/Windows/win.ini', 'read', NONE).ok).toBe(false);
  });
  it('blocks UNC paths', () => {
    expect(checkPath(root, '\\\\server\\share\\x.txt', 'read', NONE).ok).toBe(false);
    expect(checkPath(root, '//server/share/x.txt', 'read', NONE).ok).toBe(false);
  });
  it('blocks a sibling folder sharing the name prefix', () => {
    fs.mkdirSync(root + '-evil', { recursive: true });
    expect(checkPath(root, root + '-evil\\x.txt', 'write', NONE).ok).toBe(false);
  });
  it('blocks junctions pointing outside (existing and new files)', () => {
    const r = checkPath(root, 'jx/secret.txt', 'read', NONE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/symlink\/junction/);
    expect(checkPath(root, 'jx/brand/new.txt', 'write', NONE).ok).toBe(false);
    expect(checkPath(root, 'jx', 'modify', NONE).ok).toBe(false);
  });
  it('blocks file symlinks pointing outside, including dangling ones', () => {
    if (!canSymlinkFile) return;
    expect(checkPath(root, 'link.txt', 'read', NONE).ok).toBe(false);
    expect(checkPath(root, 'dangling.txt', 'write', NONE).ok).toBe(false);
  });
  it('reports a missing work folder', () => {
    expect(checkPath('', 'a.txt', 'read', ALL).ok).toBe(false);
  });
});

describe('lexical checks (Windows oddities)', () => {
  const win = process.platform === 'win32';
  it('rejects device prefixes, ADS, drive-relative, reserved names, trailing dots', () => {
    if (!win) return;
    expect(lexicalProblem('\\\\?\\C:\\x')).toBeTruthy();
    expect(lexicalProblem('\\\\.\\PhysicalDrive0')).toBeTruthy();
    expect(lexicalProblem('a.txt:stream')).toBeTruthy();
    expect(lexicalProblem('C:foo.txt')).toBeTruthy();
    expect(lexicalProblem('sub\\NUL')).toBeTruthy();
    expect(lexicalProblem('con.txt')).toBeTruthy();
    expect(lexicalProblem('sub.\\x')).toBeTruthy();
    expect(lexicalProblem('x\0y')).toBeTruthy();
    expect(lexicalProblem('')).toBeTruthy();
  });
  it('accepts normal paths', () => {
    expect(lexicalProblem('src/main/index.ts')).toBeNull();
    expect(lexicalProblem('C:\\Users\\me\\file.txt')).toBeNull();
    expect(lexicalProblem('..\\x')).toBeNull();
    expect(lexicalProblem('.gitignore')).toBeNull();
  });
  it('checkPath surfaces lexical problems', () => {
    if (!win) return;
    expect(checkPath(root, 'a.txt::$DATA', 'read', ALL).ok).toBe(false);
  });
});

describe('outside-access flags are separate', () => {
  const target = () => path.join(outsideDir, 'secret.txt');
  it('read flag only allows reads', () => {
    const f = { read: true, write: false, modify: false };
    const r = checkPath(root, target(), 'read', f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.inside).toBe(false);
    expect(checkPath(root, target(), 'modify', f).ok).toBe(false);
    expect(checkPath(root, path.join(outsideDir, 'n.txt'), 'write', f).ok).toBe(false);
  });
  it('write flag does not allow modify', () => {
    const f = { read: false, write: true, modify: false };
    expect(checkPath(root, path.join(outsideDir, 'n.txt'), 'write', f).ok).toBe(true);
    expect(checkPath(root, target(), 'modify', f).ok).toBe(false);
    expect(checkPath(root, target(), 'read', f).ok).toBe(false);
  });
  it('flags allow going through an outside junction', () => {
    expect(checkPath(root, 'jx/secret.txt', 'read', { read: true, write: false, modify: false }).ok).toBe(true);
  });
});

describe('realpathDeep', () => {
  it('resolves non-existing tails under real ancestors', () => {
    expect(realpathDeep(path.join(root, 'nope', 'x.txt')).toLowerCase()).toBe(path.join(root, 'nope', 'x.txt').toLowerCase());
    expect(realpathDeep(path.join(root, 'jx', 'nope.txt')).toLowerCase()).toBe(path.join(outsideDir, 'nope.txt').toLowerCase());
  });
});

describe('expandEnv', () => {
  const env = { USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } as any;
  it('expands the common forms', () => {
    expect(expandEnv('%USERPROFILE%\\x', env).text).toBe('C:\\Users\\me\\x');
    expect(expandEnv('$env:APPDATA\\x', env).text).toBe('C:\\Users\\me\\AppData\\Roaming\\x');
    expect(expandEnv('${env:UserProfile}/x', env).text).toBe('C:\\Users\\me/x');
    expect(expandEnv('$HOME\\x', env).text).toBe('C:\\Users\\me\\x');
    expect(expandEnv('~\\x', env).text).toBe('C:\\Users\\me\\x');
    expect(expandEnv('~', env).text).toBe('C:\\Users\\me');
  });
  it('leaves ~ inside words alone and flags unknown vars', () => {
    expect(expandEnv('a~b', env).text).toBe('a~b');
    expect(expandEnv('%NOPE%\\x', env).unknown).toBe(true);
  });
});

describe('checkCommand', () => {
  const env = { USERPROFILE: 'C:\\Users\\me' } as any;
  const ok = (c: string, o = NONE) => checkCommand(c, root, o, env).ok;
  it('allows ordinary commands in the work folder', () => {
    for (const c of [
      'dir',
      'Get-ChildItem -Recurse sub',
      'git status',
      'npm run build',
      'python script.py --flag=value',
      'cmd /c dir /s /b',
      'type a.txt | findstr /i foo',
      'Get-Content .\\a.txt',
      'curl https://example.com/a/b',
      'echo "hello world" > sub\\out.txt',
      'node -e "console.log(1/2)"',
      `Get-Content "${path.join(root, 'a.txt')}"`,
    ])
      expect(ok(c), c).toBe(true);
  });
  it('blocks absolute, UNC, home and env-var paths outside', () => {
    for (const c of [
      'type C:\\Windows\\win.ini',
      'Get-Content "C:\\Users\\me\\Documents\\x.txt"',
      "Get-Content 'C:/Users/me/x.txt'",
      'dir \\\\server\\share',
      'cat ~\\secrets.txt',
      'cat $env:USERPROFILE\\x.txt',
      'type %USERPROFILE%\\x.txt',
      'cat $HOME/x.txt',
      'tool --out=C:\\temp\\x.txt',
      'Get-Content -Path:C:\\temp\\x.txt',
      'cd \\',
      'cd /',
      'dir D:',
      'Set-Location C:\\',
      `type "${path.join(outsideDir, 'secret.txt')}"`,
    ])
      expect(ok(c), c).toBe(false);
  });
  it('blocks traversal and outside junctions', () => {
    expect(ok('cd ..')).toBe(false);
    expect(ok('type ..\\outside\\secret.txt')).toBe(false);
    expect(ok('type sub\\..\\..\\outside\\secret.txt')).toBe(false);
    expect(ok('type jx\\secret.txt')).toBe(false);
    expect(ok('Get-ChildItem jx')).toBe(false);
    expect(ok('type .\\jx\\..\\..\\outside\\secret.txt')).toBe(false);
  });
  it('allows traversal that stays inside', () => {
    expect(ok('type sub\\..\\a.txt')).toBe(true);
  });
  it('blocks encoded PowerShell', () => {
    expect(ok('powershell -EncodedCommand ZABpAHIAIABDADoAXAA=')).toBe(false);
    expect(ok('powershell -enc ZABpAHIAIABDADoAXAA=')).toBe(false);
  });
  it('read flag allows read-only outside commands but not mutating ones', () => {
    const r = { read: true, write: false, modify: false };
    expect(ok('type C:\\Windows\\win.ini', r)).toBe(true);
    expect(ok('Remove-Item C:\\Temp\\x.txt', r)).toBe(false);
    expect(ok('echo hi > C:\\Temp\\x.txt', r)).toBe(false);
    expect(ok('Remove-Item C:\\Temp\\x.txt', ALL)).toBe(true);
  });
  it('reports the offending paths', () => {
    const r = checkCommand('type C:\\Windows\\win.ini', root, NONE, env);
    expect(r.outsidePaths.join(' ').toLowerCase()).toContain('c:\\windows\\win.ini');
    expect(r.reason).toMatch(/outside the work folder/);
  });
});

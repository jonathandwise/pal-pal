/** Local persistence: SQLite (built into Electron's Node), DPAPI-encrypted secrets, memory file, per-chat logs. */
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Chat, Checkpoint, HardwareProfile, McpServerConfig, Msg, Settings, Topic, TopicFile } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
type DB = InstanceType<typeof DatabaseSync>;

let db: DB;
export const dataDir = () => app.getPath('userData');
export const logsDir = () => path.join(dataDir(), 'logs');
export const checkpointsDir = () => path.join(dataDir(), 'checkpoints');
export const memoryPath = () => path.join(dataDir(), 'memory.md');
export const uid = () => randomUUID();

export function initStore(): void {
  for (const d of [dataDir(), logsDir(), checkpointsDir()]) fs.mkdirSync(d, { recursive: true });
  db = new DatabaseSync(path.join(dataDir(), 'harness.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS topic_files (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE, path TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY, topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL, title TEXT NOT NULL,
      data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
      turn INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, compacted INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, seq);
    CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, turn INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS checkpoint_files (
      checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE, path TEXT NOT NULL,
      existed INTEGER NOT NULL, blob TEXT, PRIMARY KEY (checkpoint_id, path));
  `);
  if (!fs.existsSync(memoryPath())) fs.writeFileSync(memoryPath(), '# Long-term memory\n\n');
}

// ---------------------------------------------------------------- kv / settings
export function kvGet<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}
export function kvSet(key: string, value: unknown): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}
export function getSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...kvGet<Partial<Settings>>('settings', {}) };
}
export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  kvSet('settings', next);
  return next;
}
export function getProfile(machineId: string): HardwareProfile {
  return { hardware: null, global: {}, perModel: {}, ...kvGet<Partial<HardwareProfile>>('hw:' + machineId, {}) };
}
export function setProfile(machineId: string, p: HardwareProfile): void {
  kvSet('hw:' + machineId, p);
}

// ---------------------------------------------------------------- secrets (Windows DPAPI via safeStorage)
const secretsFile = () => path.join(dataDir(), 'secrets.bin.json');
function readSecrets(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(secretsFile(), 'utf8'));
  } catch {
    return {};
  }
}
export function getSecret(name: string): string {
  const enc = readSecrets()[name];
  if (!enc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return '';
  }
}
export function setSecret(name: string, value: string): void {
  const all = readSecrets();
  if (!value) delete all[name];
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available; refusing to store the secret in plain text.');
    all[name] = safeStorage.encryptString(value).toString('base64');
  }
  fs.writeFileSync(secretsFile(), JSON.stringify(all));
}
/** MCP configs can carry tokens in env/headers, so the whole list is stored encrypted. */
export function getMcpServers(): McpServerConfig[] {
  try {
    return JSON.parse(getSecret('mcpServers') || '[]');
  } catch {
    return [];
  }
}
export function setMcpServers(list: McpServerConfig[]): void {
  setSecret('mcpServers', JSON.stringify(list));
}

// ---------------------------------------------------------------- memory file
export const readMemory = () => {
  try {
    return fs.readFileSync(memoryPath(), 'utf8');
  } catch {
    return '';
  }
};
export const writeMemory = (text: string) => fs.writeFileSync(memoryPath(), text);
export function appendMemory(fact: string): void {
  const cur = readMemory();
  const line = `- ${fact.replace(/\s+/g, ' ').trim()} _(added ${new Date().toISOString().slice(0, 10)})_\n`;
  writeMemory(cur + (cur.endsWith('\n') || cur === '' ? '' : '\n') + line);
}

// ---------------------------------------------------------------- topics
export function listTopics(): Topic[] {
  const files = db.prepare('SELECT id, topic_id as topicId, path FROM topic_files ORDER BY path').all() as unknown as TopicFile[];
  return (db.prepare('SELECT id, name, sort FROM topics ORDER BY sort, name').all() as any[]).map((t) => ({
    ...t,
    files: files.filter((f) => f.topicId === t.id),
  }));
}
export function createTopic(name: string): string {
  const id = uid();
  const max = (db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM topics').get() as any).m;
  db.prepare('INSERT INTO topics (id, name, sort) VALUES (?, ?, ?)').run(id, name, max + 1);
  return id;
}
export const renameTopic = (id: string, name: string) => void db.prepare('UPDATE topics SET name = ? WHERE id = ?').run(name, id);
export const deleteTopic = (id: string) => void db.prepare('DELETE FROM topics WHERE id = ?').run(id); // chats fall back to "no topic"
export function addTopicFiles(topicId: string, paths: string[]): void {
  const have = new Set((db.prepare('SELECT path FROM topic_files WHERE topic_id = ?').all(topicId) as any[]).map((r) => r.path.toLowerCase()));
  for (const p of paths) if (!have.has(p.toLowerCase())) db.prepare('INSERT INTO topic_files (id, topic_id, path) VALUES (?, ?, ?)').run(uid(), topicId, p);
}
export const removeTopicFile = (id: string) => void db.prepare('DELETE FROM topic_files WHERE id = ?').run(id);

// ---------------------------------------------------------------- chats
function rowToChat(r: any): Chat {
  return { ...JSON.parse(r.data), id: r.id, topicId: r.topic_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at };
}
export const listChats = (): Chat[] => (db.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all() as any[]).map(rowToChat);
export function getChat(id: string): Chat | null {
  const r = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  return r ? rowToChat(r) : null;
}
export function createChat(init: Partial<Chat>): Chat {
  const s = getSettings();
  const now = Date.now();
  const chat: Chat = {
    id: uid(),
    topicId: null,
    title: 'New chat',
    model: s.lastModel,
    provider: s.lastProvider,
    effort: s.lastEffort,
    approvalMode: s.lastApproval,
    toolsEnabled: true,
    contextSel: [],
    summary: '',
    createdAt: now,
    updatedAt: now,
    ...init,
  };
  saveChat(chat, true);
  return chat;
}
function saveChat(c: Chat, insert = false): void {
  const { id, topicId, title, createdAt, updatedAt, ...rest } = c;
  if (insert) db.prepare('INSERT INTO chats (id, topic_id, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, topicId, title, JSON.stringify(rest), createdAt, updatedAt);
  else db.prepare('UPDATE chats SET topic_id = ?, title = ?, data = ?, updated_at = ? WHERE id = ?').run(topicId, title, JSON.stringify(rest), updatedAt, id);
}
export function updateChat(id: string, patch: Partial<Chat>, touch = false): Chat | null {
  const cur = getChat(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, id, updatedAt: touch ? Date.now() : cur.updatedAt };
  saveChat(next);
  return next;
}
export function deleteChat(id: string): void {
  db.prepare('DELETE FROM chats WHERE id = ?').run(id);
  fs.rmSync(path.join(checkpointsDir(), id), { recursive: true, force: true });
  fs.rmSync(path.join(logsDir(), id + '.jsonl'), { force: true });
}

// ---------------------------------------------------------------- messages
function rowToMsg(r: any): Msg {
  return { ...JSON.parse(r.data), id: r.id, chatId: r.chat_id, seq: r.seq, turn: r.turn, role: r.role, content: r.content, compacted: !!r.compacted, createdAt: r.created_at };
}
export const listMessages = (chatId: string): Msg[] => (db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY seq').all(chatId) as any[]).map(rowToMsg);
export function addMessage(m: Omit<Msg, 'id' | 'seq' | 'createdAt' | 'compacted'> & { compacted?: boolean }): Msg {
  const seq = ((db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE chat_id = ?').get(m.chatId) as any).m as number) + 1;
  const full: Msg = { ...m, id: uid(), seq, createdAt: Date.now(), compacted: !!m.compacted };
  const { id, chatId, seq: _s, turn, role, content, compacted, createdAt, ...rest } = full;
  db.prepare('INSERT INTO messages (id, chat_id, seq, turn, role, content, compacted, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, chatId, seq, turn, role, content, compacted ? 1 : 0, JSON.stringify(rest), createdAt,
  );
  db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(createdAt, chatId);
  return full;
}
export function markCompacted(chatId: string, uptoSeq: number): void {
  db.prepare('UPDATE messages SET compacted = 1 WHERE chat_id = ? AND seq <= ?').run(chatId, uptoSeq);
}
export function deleteMessagesFromTurn(chatId: string, turn: number): void {
  db.prepare('DELETE FROM messages WHERE chat_id = ? AND turn >= ?').run(chatId, turn);
}
export const maxTurn = (chatId: string): number => (db.prepare('SELECT COALESCE(MAX(turn), 0) AS m FROM messages WHERE chat_id = ?').get(chatId) as any).m;

// ---------------------------------------------------------------- search
export interface SearchHit {
  chatId: string;
  title: string;
  topicId: string | null;
  topicName: string;
  snippets: string[];
  titleMatch: boolean;
}
export function searchChats(query: string, topicFilter: string): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  let where = '';
  const params: any[] = [like, like];
  if (topicFilter === 'none') where = 'AND c.topic_id IS NULL';
  else if (topicFilter && topicFilter !== 'all') {
    where = 'AND c.topic_id = ?';
    params.push(topicFilter);
  }
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.topic_id, t.name AS topic_name, m.content, m.role
       FROM chats c LEFT JOIN topics t ON t.id = c.topic_id
       LEFT JOIN messages m ON m.chat_id = c.id AND m.role IN ('user','assistant') AND m.content LIKE ? ESCAPE '\\'
       WHERE (c.title LIKE ? ESCAPE '\\' OR m.id IS NOT NULL) ${where}
       ORDER BY c.updated_at DESC, m.seq LIMIT 400`,
    )
    .all(...params) as any[];
  const hits = new Map<string, SearchHit>();
  const lq = q.toLowerCase();
  for (const r of rows) {
    let h = hits.get(r.id);
    if (!h) {
      h = { chatId: r.id, title: r.title, topicId: r.topic_id, topicName: r.topic_name || 'No topic', snippets: [], titleMatch: String(r.title).toLowerCase().includes(lq) };
      hits.set(r.id, h);
    }
    if (r.content && h.snippets.length < 3) {
      const i = String(r.content).toLowerCase().indexOf(lq);
      const start = Math.max(0, i - 50);
      const text = String(r.content).slice(start, i + q.length + 90).replace(/\s+/g, ' ');
      h.snippets.push((start > 0 ? '…' : '') + text + '…');
    }
  }
  return [...hits.values()];
}

// ---------------------------------------------------------------- checkpoints (DB part; file handling in checkpoints.ts)
export function getOrCreateCheckpoint(chatId: string, turn: number): string {
  const r = db.prepare('SELECT id FROM checkpoints WHERE chat_id = ? AND turn = ?').get(chatId, turn) as any;
  if (r) return r.id;
  const id = uid();
  db.prepare('INSERT INTO checkpoints (id, chat_id, turn, created_at) VALUES (?, ?, ?, ?)').run(id, chatId, turn, Date.now());
  return id;
}
export const checkpointHasFile = (cpId: string, p: string): boolean => !!db.prepare('SELECT 1 FROM checkpoint_files WHERE checkpoint_id = ? AND path = ?').get(cpId, p);
export const addCheckpointFile = (cpId: string, p: string, existed: boolean, blob: string | null) =>
  void db.prepare('INSERT OR IGNORE INTO checkpoint_files (checkpoint_id, path, existed, blob) VALUES (?, ?, ?, ?)').run(cpId, p, existed ? 1 : 0, blob);
export function listCheckpoints(chatId: string): Checkpoint[] {
  const cps = db.prepare('SELECT id, chat_id AS chatId, turn, created_at AS createdAt FROM checkpoints WHERE chat_id = ? ORDER BY turn').all(chatId) as any[];
  return cps.map((c) => ({ ...c, files: (db.prepare('SELECT path FROM checkpoint_files WHERE checkpoint_id = ?').all(c.id) as any[]).map((f) => f.path) }));
}
export const checkpointFiles = (cpId: string) =>
  db.prepare('SELECT path, existed, blob FROM checkpoint_files WHERE checkpoint_id = ?').all(cpId) as unknown as { path: string; existed: number; blob: string | null }[];
export const deleteCheckpointsFromTurn = (chatId: string, turn: number) => void db.prepare('DELETE FROM checkpoints WHERE chat_id = ? AND turn >= ?').run(chatId, turn);

// ---------------------------------------------------------------- per-chat logs (JSONL files)
const SECRET_PATTERNS = [/sk-or-[A-Za-z0-9_-]{8,}/g, /sk-[A-Za-z0-9_-]{20,}/g, /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi];
export function redact(text: string): string {
  let out = text;
  const key = getSecret('openrouterKey');
  if (key) out = out.split(key).join('[REDACTED]');
  for (const re of SECRET_PATTERNS) out = out.replace(re, (_m, p1) => (typeof p1 === 'string' ? p1 : '') + '[REDACTED]');
  return out;
}
export const logPath = (chatId: string) => path.join(logsDir(), chatId + '.jsonl');
export function log(chatId: string, type: string, data: unknown): void {
  try {
    const line = redact(JSON.stringify({ ts: new Date().toISOString(), type, data }, (_k, v) => (typeof v === 'string' && v.startsWith('data:image/') ? `[image ${v.length} chars]` : v)));
    fs.appendFileSync(logPath(chatId), line + '\n');
  } catch {
    /* logging must never break the app */
  }
}
export function readLog(chatId: string, limit = 500): any[] {
  try {
    const lines = fs.readFileSync(logPath(chatId), 'utf8').trim().split('\n');
    return lines.slice(-limit).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { ts: '', type: 'unparsed', data: l };
      }
    });
  } catch {
    return [];
  }
}

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { AgentEvent, HardwareProfile, McpServerConfig, ModelInfo, Settings } from '../shared/types';
import * as store from './store';
import * as agent from './agent';
import { checkOpenRouterKey, effectiveCtx, listOllamaModels, listOpenRouterModels, ollamaStatus } from './providers';
import { detectHardware, effectiveOptions, machineId } from './hardware';
import { buildContextTree } from './context';
import { rollback } from './checkpoints';
import { mcpStatus, shutdownMcp, syncMcp } from './mcp';

let win: BrowserWindow | null = null;
let models: ModelInfo[] = [];

process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

function send(e: AgentEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', e);
}

async function refreshModels(): Promise<{ models: ModelInfo[]; errors: Record<string, string> }> {
  const errors: Record<string, string> = {};
  const [ol, or] = await Promise.all([
    listOllamaModels().catch((e) => ((errors.ollama = e.message), [] as ModelInfo[])),
    listOpenRouterModels().catch((e) => ((errors.openrouter = e.message), [] as ModelInfo[])),
  ]);
  if (!store.getSecret('openrouterKey')) errors.openrouter = 'No API key set (add one in Settings).';
  else if (!errors.openrouter && or.length === 0) errors.openrouter = 'OpenRouter returned no models.';
  models = [...ol, ...or];
  return { models, errors };
}

async function ensureHardware(): Promise<HardwareProfile> {
  const id = await machineId();
  const p = store.getProfile(id);
  if (!p.hardware) {
    p.hardware = await detectHardware();
    store.setProfile(id, p);
  }
  return p;
}

const handlers: Record<string, (...a: any[]) => any> = {
  // ---- settings & secrets
  'settings:get': () => store.getSettings(),
  'settings:set': (patch: Partial<Settings>) => store.setSettings(patch),
  'key:status': () => ({ set: !!store.getSecret('openrouterKey') }),
  'key:set': async (key: string) => {
    const k = String(key || '').trim();
    if (!k) {
      store.setSecret('openrouterKey', '');
      return { ok: true, message: 'Key removed.' };
    }
    const check = await checkOpenRouterKey(k);
    // An unreachable network should not stop the user saving a key; an explicit rejection should.
    if (!check.ok && /rejected/.test(check.message)) return check;
    store.setSecret('openrouterKey', k);
    return { ok: true, message: check.ok ? 'Key saved and verified.' : `Key saved, but it could not be verified: ${check.message}` };
  },
  // ---- models / status / hardware
  'models:list': () => refreshModels(),
  'ollama:status': () => ollamaStatus(),
  'hw:get': async () => ({ machineId: await machineId(), profile: await ensureHardware() }),
  'hw:detect': async () => {
    const id = await machineId();
    const p = store.getProfile(id);
    p.hardware = await detectHardware();
    store.setProfile(id, p);
    return p;
  },
  'hw:saveOverrides': async (global: any, perModel: any) => {
    const id = await machineId();
    const p = store.getProfile(id);
    store.setProfile(id, { ...p, global: global || {}, perModel: perModel || {} });
    return store.getProfile(id);
  },
  'hw:defaults': async (modelId: string, effort: any) => {
    const m = models.find((x) => x.provider === 'ollama' && x.id === modelId);
    if (!m) return null;
    const { overrides, defaults } = effectiveOptions(m, await ensureHardware());
    return { defaults, overrides, ctx: effectiveCtx(m, effort || 'medium', defaults.num_ctx, overrides.num_ctx) };
  },
  // ---- work folder / pickers
  'folder:pick': async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Choose the work folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return store.setSettings({ workFolder: r.filePaths[0] });
  },
  'files:pick': async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Attach context files', properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  },
  // ---- topics
  'topics:list': () => store.listTopics(),
  'topics:create': (name: string) => store.createTopic(name),
  'topics:rename': (id: string, name: string) => store.renameTopic(id, name),
  'topics:delete': (id: string) => store.deleteTopic(id),
  'topics:addFiles': (id: string, paths: string[]) => store.addTopicFiles(id, paths),
  'topics:removeFile': (fileId: string) => store.removeTopicFile(fileId),
  // ---- chats
  'chats:list': () => store.listChats(),
  'chats:create': (topicId: string | null) => {
    const topic = topicId ? store.listTopics().find((t) => t.id === topicId) : null;
    // New chats start with memory and (inherited) topic files checked; outside access starts off.
    return store.createChat({ topicId: topic ? topic.id : null, contextSel: ['memory', ...(topic ? topic.files.map((f) => 'topic:' + f.id) : [])] });
  },
  'chats:update': (id: string, patch: any) => {
    const c = store.updateChat(id, patch);
    const s: Partial<Settings> = {};
    if (patch.model !== undefined) Object.assign(s, { lastModel: patch.model, lastProvider: patch.provider });
    if (patch.effort) s.lastEffort = patch.effort;
    if (patch.approvalMode) s.lastApproval = patch.approvalMode;
    if (Object.keys(s).length) store.setSettings(s);
    return c;
  },
  'chats:delete': (id: string) => {
    agent.stop(id);
    store.deleteChat(id);
  },
  'chats:messages': (id: string) => store.listMessages(id),
  'chats:search': (q: string, topic: string) => store.searchChats(q, topic),
  'chats:measure': (id: string) => agent.measure(id),
  // ---- context
  'context:tree': async (chatId: string) => {
    const chat = store.getChat(chatId);
    if (!chat) return null;
    return { nodes: buildContextTree(chat, store.getSettings()), usage: await agent.measure(chatId) };
  },
  // ---- agent
  'agent:send': (chatId: string, text: string, images: string[]) => {
    void agent.sendMessage(chatId, text, images || []);
  },
  'agent:stop': (chatId: string) => agent.stop(chatId),
  'agent:running': (chatId: string) => agent.isRunning(chatId),
  'agent:approve': (chatId: string, id: string, ok: boolean) => agent.resolveApproval(chatId, id, ok),
  'agent:compact': (chatId: string) => (agent.isRunning(chatId) ? { ok: false, message: 'Wait for the current turn to finish.' } : agent.compactChat(chatId, true)),
  'outside:get': (chatId: string) => agent.getOutside(chatId),
  'outside:set': (chatId: string, o: any) => (agent.setOutside(chatId, o), agent.getOutside(chatId)),
  // ---- checkpoints
  'checkpoints:list': (chatId: string) => store.listCheckpoints(chatId),
  'checkpoints:rollback': (chatId: string, turn: number) => {
    if (agent.isRunning(chatId)) throw new Error('Stop the running turn first.');
    const r = rollback(chatId, turn);
    store.log(chatId, 'rollback', { turn, ...r });
    return r;
  },
  // ---- memory
  'memory:get': () => ({ text: store.readMemory(), path: store.memoryPath() }),
  'memory:set': (text: string) => store.writeMemory(text),
  // ---- logs
  'log:get': (chatId: string) => ({ entries: store.readLog(chatId), path: store.logPath(chatId), exists: fs.existsSync(store.logPath(chatId)) }),
  'log:open': (chatId: string) => shell.openPath(store.logPath(chatId)),
  'log:reveal': (chatId: string) => (fs.existsSync(store.logPath(chatId)) ? shell.showItemInFolder(store.logPath(chatId)) : shell.openPath(store.logsDir())),
  // ---- MCP
  'mcp:get': () => ({ servers: store.getMcpServers(), status: mcpStatus() }),
  'mcp:save': async (servers: McpServerConfig[], reconnectId?: string) => {
    store.setMcpServers(servers);
    await syncMcp(servers, reconnectId);
    return { servers, status: mcpStatus() };
  },
};

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#15171c',
    autoHideMenuBar: true,
    title: 'Pal Pal',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win!.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url) && !url.startsWith(process.env.ELECTRON_RENDERER_URL || '\0')) void shell.openExternal(url);
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  void app.whenReady().then(() => {
    store.initStore();
    agent.initAgent(send, (provider, id) => models.find((m) => m.provider === provider && m.id === id));
    ipcMain.handle('api', async (_e, channel: string, ...args: unknown[]) => {
      const h = handlers[channel];
      if (!h) throw new Error(`Unknown API call: ${channel}`);
      return h(...args);
    });
    createWindow();
    void ensureHardware().catch(() => {});
    void syncMcp(store.getMcpServers()).catch(() => {});
  });
  app.on('window-all-closed', () => {
    void shutdownMcp().finally(() => app.quit());
  });
}

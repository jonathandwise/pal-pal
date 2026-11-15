export type Provider = 'ollama' | 'openrouter';
export type Effort = 'low' | 'medium' | 'high';
export type ApprovalMode = 'ask' | 'auto-edits' | 'full-auto';

export interface OutsideAccess {
  read: boolean;
  write: boolean;
  modify: boolean;
}

export interface ModelInfo {
  id: string;
  provider: Provider;
  name: string;
  contextLength: number;
  vision: boolean;
  tools: boolean;
  thinking: boolean;
  sizeBytes?: number;
  paramSize?: string;
  quant?: string;
  family?: string;
  layers?: number;
  /** bytes of KV cache per context token (estimated from model metadata) */
  kvBytesPerToken?: number;
  maxOutput?: number;
}

export interface Topic {
  id: string;
  name: string;
  sort: number;
  files: TopicFile[];
}
export interface TopicFile {
  id: string;
  topicId: string;
  path: string;
}

export interface Chat {
  id: string;
  topicId: string | null;
  title: string;
  model: string;
  provider: Provider | '';
  effort: Effort;
  approvalMode: ApprovalMode;
  toolsEnabled: boolean;
  /** checked context item ids: "memory", "topic:<fileId>", "wf:<relative path>" */
  contextSel: string[];
  summary: string;
  createdAt: number;
  updatedAt: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Role = 'user' | 'assistant' | 'tool' | 'note';

export interface Msg {
  id: string;
  chatId: string;
  seq: number;
  turn: number;
  role: Role;
  content: string;
  thinking?: string;
  images?: string[]; // data URLs
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  /** note kinds: error | blocked | info | compaction | warning */
  kind?: string;
  isError?: boolean;
  compacted: boolean;
  createdAt: number;
  usage?: { prompt?: number; completion?: number; ms?: number };
}

export interface McpServerConfig {
  id: string;
  name: string;
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface OllamaOverrides {
  num_ctx?: number;
  num_gpu?: number;
  temperature?: number;
  num_predict?: number;
  keep_alive?: string;
}

export interface Hardware {
  machineId: string;
  hostname: string;
  gpus: { name: string; vramMB: number }[];
  vramMB: number; // best single GPU
  ramMB: number;
  cpu: string;
  cores: number;
  detectedAt: number;
}

export interface HardwareProfile {
  hardware: Hardware | null;
  global: OllamaOverrides;
  perModel: Record<string, OllamaOverrides>;
}

export interface Settings {
  ollamaUrl: string;
  systemPrompt: string;
  workFolder: string;
  theme: 'dark' | 'light';
  maxSteps: number;
  toolTimeoutSec: number;
  maxToolOutputChars: number;
  maxToolRetries: number;
  autoCompact: boolean;
  warnThreshold: number;
  compactThreshold: number;
  keepRecentTurns: number;
  lastModel: string;
  lastProvider: Provider | '';
  lastEffort: Effort;
  lastApproval: ApprovalMode;
  /** favourite models as "provider::id" */
  favoriteModels: string[];
  /** chat text size in px */
  fontSize: number;
}

export interface ModelDefaults {
  num_ctx: number;
  /** undefined = let Ollama place layers automatically */
  num_gpu?: number;
  estGpuLayers?: number;
  totalLayers?: number;
  estVramMB: number;
  fitsVram: boolean;
  warning?: string;
}

export interface ContextNode {
  id: string;
  label: string;
  kind: 'group' | 'dir' | 'file';
  tokens: number;
  path?: string;
  missing?: boolean;
  children?: ContextNode[];
}

export interface ApprovalRequest {
  id: string;
  chatId: string;
  tool: string;
  title: string;
  /** exactly what will run or change */
  detail: string;
  diff?: { before: string; after: string };
  outside?: boolean;
}

export interface Checkpoint {
  id: string;
  chatId: string;
  turn: number;
  createdAt: number;
  files: string[];
}

export type AgentEvent =
  | { type: 'start'; chatId: string }
  | { type: 'delta'; chatId: string; text: string }
  | { type: 'thinking'; chatId: string; text: string }
  | { type: 'reset-stream'; chatId: string }
  | { type: 'message'; chatId: string; message: Msg }
  | { type: 'status'; chatId: string; text: string }
  | { type: 'approval'; chatId: string; request: ApprovalRequest }
  | { type: 'approval-done'; chatId: string; id: string }
  | { type: 'memory-proposal'; chatId: string; id: string; fact: string }
  | { type: 'chat-updated'; chatId: string }
  | { type: 'usage'; chatId: string; used: number; limit: number }
  | { type: 'done'; chatId: string }
  | { type: 'update'; chatId: ''; state: UpdateState };

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error';
  /** installed version */
  current: string;
  latest?: string;
  notes?: string;
  percent?: number;
  error?: string;
}

export const DEFAULT_SYSTEM_PROMPT = `You are a capable local AI assistant running inside Pal Pal, a desktop app on the user's Windows PC.

- Be concise and direct. Use Markdown; put code in fenced code blocks with a language tag.
- You may have tools for files, shell commands (PowerShell), web search and more. Use them when they help; do not ask permission first - Pal Pal handles approvals.
- File paths are relative to the user's work folder unless absolute. You can only touch files inside the work folder unless the user has enabled outside access. If an action is blocked, tell the user instead of trying to work around it.
- Read a file before modifying it. Prefer edit_file for small changes over rewriting whole files.
- When a tool call fails, read the error and correct the call rather than repeating it.
- If you learn a durable fact about the user or their projects that would help in future chats, call the remember tool with one short sentence.
- When you are done, give a short final answer describing what you did or found.`;

export const DEFAULT_SETTINGS: Settings = {
  ollamaUrl: 'http://localhost:11434',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  workFolder: '',
  theme: 'dark',
  maxSteps: 25,
  toolTimeoutSec: 120,
  maxToolOutputChars: 12000,
  maxToolRetries: 3,
  autoCompact: true,
  warnThreshold: 0.7,
  compactThreshold: 0.85,
  keepRecentTurns: 3,
  lastModel: '',
  lastProvider: '',
  lastEffort: 'medium',
  lastApproval: 'ask',
  favoriteModels: [],
  fontSize: 14,
};

export const FONT_MIN = 10;
export const FONT_MAX = 26;

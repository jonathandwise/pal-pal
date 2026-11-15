# Pal Pal

A local-first desktop AI agent for Windows 10/11. It talks to **Ollama** (local models) and
**OpenRouter**, gives the model file, shell, web and MCP tools, and keeps those tools inside one
work folder unless you say otherwise.

Stack: Electron + TypeScript + React (Vite), SQLite via Node's built-in `node:sqlite`,
packaged with electron-builder (NSIS installer). No native modules, no Rust/MSVC toolchain.

## Install on a PC

1. Copy `release\Pal-Pal-Setup-1.1.0.exe` to the PC and run it.
   The installer is **not code-signed**, so Windows SmartScreen shows "Windows protected your PC" -
   choose *More info → Run anyway*.
2. Install [Ollama](https://ollama.com) and pull at least one model, e.g. `ollama pull qwen3:8b`.
3. Start the app. On first launch it detects the GPU/VRAM/RAM. Choose a work folder in the sidebar,
   pick a model next to the message box, and chat.
4. Optional: add an OpenRouter key in *Settings → General*.

Everything is stored per PC in `%APPDATA%\Pal Pal\`:
`palpal.db` (chats, topics, settings), `memory.md`, `logs\<chat id>.jsonl`, `checkpoints\`,
`secrets.bin.json` (DPAPI-encrypted).

## Build from source

Requires Node.js 22+ (built with 24) and npm.

```bash
npm install
npm run dev        # run with hot reload
npm test           # guardrail + tool-call parser tests (vitest)
npm run typecheck
npm run build      # compile to out/
npm run dist       # build + create the installer in release/
```

## Versions and updates

The version lives in `package.json` (`version`) and is shown in the sidebar header and in
*Settings → General*. A few seconds after it starts, the installed app asks GitHub for the latest
release of `jonathandwise/pal-pal`. If that release is newer, it asks whether to update; on
*Update now* it downloads the installer, checks it against the SHA-512 in `latest.yml`, then closes,
installs and reopens. *Later* hides the prompt until the next start. Nothing downloads without a
yes. *Settings → General → Check for updates* runs the same check on demand and shows any error.

Requirements for the check to find anything:

- The GitHub repository must be **public**. A private repository answers 404 to the app.
- A published (non-draft, non-prerelease) release must have three files attached:
  the installer, its `.blockmap`, and `latest.yml`.

To publish a new version:

```bash
npm version patch
```

```bash
npm run dist
```

```bash
gh release create v1.1.1 release/Pal-Pal-Setup-1.1.1.exe release/Pal-Pal-Setup-1.1.1.exe.blockmap release/latest.yml --title "Pal Pal 1.1.1" --notes "What changed"
```

Use the version `npm version` printed in place of `1.1.1`. Update checks do not run in `npm run dev`.

## Effort mapping

The Effort dropdown is translated per model, using thinking controls where the model has them:

| Model kind | Low | Medium | High |
|---|---|---|---|
| Ollama, thinking-capable (Qwen 3, DeepSeek-R1, …) | `think: false`, max 2048 output tokens | `think: true`, max 8192 | `think: true`, unlimited output |
| Ollama gpt-oss (cannot switch thinking off) | `think: "low"` | `think: "medium"` | `think: "high"` |
| Ollama, no thinking support | 1024 output tokens, temperature 0.3, **half** the tuned context (min 4096) | 4096, temp 0.6 | unlimited, temp 0.7 |
| OpenRouter, reasoning-capable | `reasoning.effort: "low"` | `"medium"` | `"high"` |
| OpenRouter, no reasoning support | max 1024 tokens, temp 0.3 | 4096, temp 0.6 | 16384 (capped by the model), temp 0.7 |

Thinking-capable is read from Ollama's `/api/show` capabilities and OpenRouter's
`supported_parameters`. If a model rejects the thinking parameter the request is retried without it.
Per-model overrides in *Settings → Hardware & Ollama* (num_ctx, num_gpu, temperature) win over the mapping.

## Hardware-aware Ollama defaults

Detection: `nvidia-smi` for NVIDIA cards, otherwise the display-adapter registry key (works for AMD
and reports more than 4 GB correctly); RAM and CPU from the OS. A GPU counts as usable with ≥ 2 GB.

For each model the app estimates memory as *model file size (which already reflects parameter count
and quantization) + KV cache for the context + ~0.5 GB overhead*. KV cost per token comes from the
model's own metadata (layers × embedding width × KV-head ratio). It then picks the largest context
from 32768 / 16384 / 8192 / 4096 that fits in VRAM minus a 0.7 GB reserve. If even 4096 does not
fit, it keeps 4096, estimates how many layers will sit on the GPU and warns that the rest spills
into system RAM. With no GPU it uses 4096 (8192 with ≥ 32 GB RAM) and warns that it runs on CPU.

**num_gpu:** by default the app does *not* send `num_gpu`; Ollama's own layer placement is more
accurate than an outside estimate, and a wrong forced value makes loading fail. The estimated
offload is shown, and you can force a value globally or per model.

Profiles are keyed by the Windows machine GUID, so each PC keeps its own detection and overrides.
The sidebar footer shows the loaded model and its VRAM vs. spilled-RAM split from `/api/ps`.

## Context control

- **Context panel** (opens for every new chat, and from the *Context* button): a checkbox tree of
  the memory file, the chat's Topic files and the work folder. Selections are saved per chat. Each
  item shows a token estimate; the header shows the running total and a breakdown of the request.
- New chats start with memory and their Topic's files checked; nothing from the work folder.
- Token counts are estimates (characters ÷ 3.6). After each reply the meter switches to the real
  prompt + completion counts reported by the provider.
- At 70 % of the context you get a warning; at 85 % older turns are summarized automatically
  (thresholds in *Settings → Agent & limits*). The last 3 turns and all checked files stay intact.
  The summary is shown in the chat. *Compact chat* does the same on demand.
- Folders skipped in the tree and in searches: `node_modules`, `.git`, `dist`, `build`, `out`,
  `.venv`, `.obsidian` and similar; binary file types are not listed.

## Tools

`read_file`, `write_file`, `create_file`, `edit_file`, `delete_file`, `list_dir`, `search_files`,
`run_command` (PowerShell or cmd, working directory = work folder), `web_search` (DuckDuckGo HTML,
no key), `fetch_page`, `remember` (proposes a memory entry), plus every tool of each connected MCP
server (`mcp__<server>__<tool>`). File and shell tools are only offered when a work folder is set.

Tool calls are validated against their JSON schema. Repairs attempted before giving up: broken JSON
(trailing commas, single quotes, missing braces), wrong-case or short tool names, aliased argument
names (`file_path` → `path`), type coercion, a bare string for a single-argument tool. Anything
still invalid goes back to the model as an error with the schema; after N consecutive invalid
rounds (default 3) the turn stops. Models without native tool calling get the tools described in
the prompt and their `<tool_call>` tags / fenced JSON / `<function=…>` output is parsed. Untick
**Tools** for plain chat.

## Guardrails

Enforced in code (`src/main/guard.ts`), not in the prompt:

- Every file tool resolves the *real* path first (deepest existing ancestor via `realpath`, which
  follows symlinks and junctions and expands 8.3 names) and compares it with the real work folder.
  Blocked: `..` traversal, absolute paths elsewhere, other drives, UNC paths, symlinks/junctions
  that lead out (including dangling ones), `\\?\` and `\\.\` device paths, alternate data streams,
  drive-relative paths, reserved device names.
- Shell commands are screened before they run: absolute, UNC, rooted, `~`, `%VAR%` / `$env:VAR`
  paths, `..` traversal and relative paths through junctions are resolved and checked; encoded
  PowerShell commands are refused.
- **Outside access** (next to the message box): separate Read / Write / Modify switches, off by
  default, per chat, never saved - a new chat or an app restart turns them off. A yellow badge shows
  while any is on.
- **Approval modes:** *Ask every time*, *Auto-approve edits* (file edits inside the work folder are
  automatic; commands, deletes, MCP calls and anything outside still ask), *Full auto* (no prompts,
  guardrails still apply). Prompts show the exact command, or a before/after view of the change.
- **Checkpoints:** files are snapshotted before the AI's first change to them in each turn.
  *Roll back to before this turn* on any user message restores them (deleted files and folders come
  back, newly created files are removed) and removes that turn and later ones from the chat.

### Limits of the guardrails (please read)

- **Shell screening is best-effort.** A shell is a programming language: a command can build a path
  at run time (`$p = 'C:' + '\Users'`), call a script or program that goes elsewhere, or use
  environment variables the screener does not know. The screener catches direct references, not
  determined evasion. Keep approval mode on *Ask* or *Auto-approve edits* if that matters; you see
  every command before it runs.
- **Shell changes are not checkpointed.** Rollback covers the file tools only.
- **MCP servers are not sandboxed.** They run with your user rights and their own rules.
- Files over 100 MB are not snapshotted (rollback reports them).

## Logs

*View log* shows every step of a chat: the exact request (system prompt, context, history, tool
definitions), raw model output, parsed tool calls and validation results, tool results, approvals,
errors, token counts and timings. The same data is in `%APPDATA%\Pal Pal\logs\<chat>.jsonl`
(*Open file* / *Show in folder*). The OpenRouter key, `sk-…` strings and `Bearer` tokens are redacted
before writing; pasted images are replaced by a size note.

## Project layout

```
src/shared/types.ts     shared types, default settings and system prompt
src/main/guard.ts       path + shell guardrails            (tests/guard.test.ts)
src/main/toolcalls.ts   tool-call parsing/repair/validation (tests/toolcalls.test.ts)
src/main/providers.ts   Ollama + OpenRouter: models, effort mapping, streaming
src/main/hardware.ts    detection and Ollama defaults
src/main/context.ts     context tree, token estimates, request assembly
src/main/agent.ts       agent loop, compaction, approvals
src/main/tools.ts       built-in tools
src/main/mcp.ts         MCP client manager (stdio + HTTP)
src/main/checkpoints.ts snapshots and rollback
src/main/store.ts       SQLite, encrypted secrets, memory file, logs
src/main/index.ts       window + IPC
src/renderer/           React UI
```

## Known gaps

- The installer is unsigned and uses the default Electron icon.
- Update checks only work while the GitHub repository is public and has a published release with
  `latest.yml` attached.
- Shell-command screening is heuristic, and shell changes cannot be rolled back (see above).
- Secrets are in a DPAPI-encrypted file, not in Windows Credential Manager itself.
- Token counts are estimates until the provider reports real counts after the first reply.
- `num_gpu` is estimated and displayed but not sent unless you override it.
- Pressing Stop mid-stream discards the partial reply.
- Topic files added to a Topic later are not auto-checked in that Topic's existing chats.
- Chat search uses substring matching, not ranked full-text search.

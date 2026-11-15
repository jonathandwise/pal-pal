/** Per-turn file snapshots so a chat can be rolled back, including deleted files. */
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store';

const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;

/** Record the state of `absPath` (file or directory tree) before the AI changes it. First snapshot per turn wins. */
export function snapshot(chatId: string, turn: number, absPath: string): void {
  const cpId = store.getOrCreateCheckpoint(chatId, turn);
  const dir = path.join(store.checkpointsDir(), chatId, cpId);
  const one = (p: string) => {
    if (store.checkpointHasFile(cpId, p)) return;
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(p);
    } catch {
      /* does not exist */
    }
    if (!st) return store.addCheckpointFile(cpId, p, false, null);
    if (st.isSymbolicLink()) return; // never follow links out of the tree
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) one(path.join(p, e));
      return;
    }
    if (st.size > MAX_SNAPSHOT_BYTES) return store.addCheckpointFile(cpId, p, true, null); // too large to snapshot
    fs.mkdirSync(dir, { recursive: true });
    const blob = path.join(dir, store.uid() + '.bin');
    fs.copyFileSync(p, blob);
    store.addCheckpointFile(cpId, p, true, blob);
  };
  one(absPath);
}

/** Restore files to how they were before `turn` started, then drop that turn and everything after it. */
export function rollback(chatId: string, turn: number): { restored: string[]; removed: string[]; failed: string[] } {
  const restored: string[] = [];
  const removed: string[] = [];
  const failed: string[] = [];
  const cps = store.listCheckpoints(chatId).filter((c) => c.turn >= turn).sort((a, b) => b.turn - a.turn);
  for (const cp of cps) {
    for (const f of store.checkpointFiles(cp.id)) {
      try {
        if (f.existed) {
          if (!f.blob) {
            failed.push(f.path + ' (was too large to snapshot)');
            continue;
          }
          fs.mkdirSync(path.dirname(f.path), { recursive: true });
          fs.copyFileSync(f.blob, f.path);
          restored.push(f.path);
        } else if (fs.existsSync(f.path)) {
          fs.rmSync(f.path, { force: true });
          removed.push(f.path);
        }
      } catch (e: any) {
        failed.push(`${f.path} (${e?.message})`);
      }
    }
    fs.rmSync(path.join(store.checkpointsDir(), chatId, cp.id), { recursive: true, force: true });
  }
  store.deleteCheckpointsFromTurn(chatId, turn);
  store.deleteMessagesFromTurn(chatId, turn);
  return { restored: [...new Set(restored)], removed: [...new Set(removed)], failed };
}

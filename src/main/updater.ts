/** Update check against the project's GitHub Releases (electron-updater). Nothing downloads or installs without the user saying yes. */
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateState } from '../shared/types';

let state: UpdateState = { status: 'idle', current: '' };
let notify: (s: UpdateState) => void = () => {};
let wired = false;

const set = (patch: Partial<UpdateState>) => {
  state = { ...state, ...patch, current: app.getVersion() };
  notify(state);
};
export const updateState = (): UpdateState => ({ ...state, current: app.getVersion() });

function friendly(e: any): string {
  const msg = String(e?.message || e);
  if (/404|not found|Unable to find latest version|no published versions/i.test(msg)) return 'No published release was found. The GitHub repository may be private or have no releases yet.';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|net::/i.test(msg)) return 'Could not reach GitHub. Check your internet connection.';
  if (/latest\.yml/i.test(msg)) return 'The latest release has no update file (latest.yml) attached.';
  return msg.split('\n')[0].slice(0, 300);
}

function notesText(notes: unknown): string {
  if (typeof notes === 'string') return notes.replace(/<[^>]+>/g, '').trim().slice(0, 2000);
  if (Array.isArray(notes)) return notes.map((n: any) => `${n.version}: ${String(n.note || '').replace(/<[^>]+>/g, '')}`).join('\n').slice(0, 2000);
  return '';
}

export function initUpdater(onChange: (s: UpdateState) => void): void {
  notify = onChange;
  if (wired) return;
  wired = true;
  autoUpdater.autoDownload = false; // ask first
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: undefined }));
  autoUpdater.on('update-available', (info) => set({ status: 'available', latest: info.version, notes: notesText(info.releaseNotes) }));
  autoUpdater.on('update-not-available', (info) => set({ status: 'none', latest: info.version }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', () => set({ status: 'ready', percent: 100 }));
  autoUpdater.on('error', (e) => set({ status: 'error', error: friendly(e) }));
}

/** Runs at startup and from Settings. Only packaged builds can update themselves. */
export async function checkForUpdate(): Promise<UpdateState> {
  if (!app.isPackaged) {
    set({ status: 'error', error: 'Update checks only run in the installed app, not in a development build.' });
    return updateState();
  }
  if (state.status === 'checking' || state.status === 'downloading') return updateState();
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    set({ status: 'error', error: friendly(e) });
  }
  return updateState();
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (state.status !== 'available') return updateState();
  set({ status: 'downloading', percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    set({ status: 'error', error: friendly(e) });
  }
  return updateState();
}

/** Closes the app, runs the downloaded installer and starts the new version. */
export function installUpdate(): void {
  if (state.status === 'ready') autoUpdater.quitAndInstall(false, true);
}
